import { describe, expect, it } from 'vitest';

import type { McpGateway } from '#mcp-gateway/mcp-gateway';
import {
	callInput,
	createHarness,
	inputSchema,
	output,
} from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

function mutableRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error('Expected an object to mutate in place');
	return value;
}

function corruptInputSchema(schema: unknown): void {
	const properties = mutableRecord(mutableRecord(schema).properties);
	mutableRecord(properties.value).type = 'boolean';
	properties.injected = { type: 'string' };
}

async function describedTool(
	gateway: McpGateway,
	helper = false,
): Promise<Record<string, unknown>> {
	const described = await gateway.describe({
		requests: [
			{
				id: 'r',
				tools: [{ namespace: 'alpha', toolName: 'read' }],
				includeTypescriptHelper: helper,
			},
		],
	});
	const tools = output(described, 'r').tools;
	if (!Array.isArray(tools)) throw new Error('Expected described tools');
	return mutableRecord(tools[0]);
}

async function searchedTool(gateway: McpGateway): Promise<Record<string, unknown>> {
	const result = await gateway.search({
		requests: [{ id: 'r', query: 'read', namespaces: ['alpha'], schemaDetail: 'full' }],
	});
	const tools = output(result, 'r').tools;
	if (!Array.isArray(tools)) throw new Error('Expected searched tools');
	return mutableRecord(tools[0]);
}

describe('published catalog object isolation', () => {
	it.each(['prepared', 'native', 'publisher'] as const)(
		'isolates published full catalog schemas and annotations from %s mutations',
		async (surface) => {
			const harness = createHarness();
			if (surface === 'publisher') {
				harness.setPrepared((catalog) => {
					const tool = catalog.tools.find(
						(entry) => entry.namespace === 'alpha' && entry.toolName === 'read',
					);
					if (tool === undefined) throw new Error('Expected allowed tool');
					corruptInputSchema(tool.descriptor.inputSchema);
					mutableRecord(tool.descriptor.annotations).readOnlyHint = false;
					return catalog;
				});
			}
			const published =
				surface === 'native'
					? await harness.gateway.listTools('catalog')
					: (await harness.gateway.prepareCatalog()).tools.map((tool) => tool.descriptor);
			const tool = published.find((entry) => entry.name === 'alpha__read__151160dc30');
			if (tool === undefined) throw new Error('Expected allowed descriptor');
			corruptInputSchema(tool.inputSchema);
			mutableRecord(mutableRecord(tool.annotations).category).label = 'corrupted';
			harness.setPrepared((catalog) => catalog);

			const valid = await harness.gateway.call(callInput());
			const invalid = await harness.gateway.call(callInput('read', 'invalid', { value: true }));
			expect(valid.results['original-item']?.ok).toBe(true);
			expect(invalid.results.invalid).toMatchObject({
				ok: false,
				error: { kind: 'input_validation' },
			});
			expect(harness.effects).toHaveLength(1);
			const fresh = (await harness.gateway.listTools('catalog')).find(
				(entry) => entry.name === tool.name,
			);
			expect(fresh?.inputSchema).toEqual(inputSchema);
			expect(fresh?.annotations).toEqual({ readOnlyHint: true, category: { label: 'original' } });
		},
	);

	it.each(['describe', 'helper', 'search'] as const)(
		'isolates published compact schemas and metadata from %s mutations',
		async (surface) => {
			const harness = createHarness();
			harness.setPrepared((catalog) => ({
				...catalog,
				typescriptHelpersByToolRef: { 'mcp:YWxwaGE:cmVhZA': '// immutable helper' },
			}));
			const tool =
				surface === 'search'
					? await searchedTool(harness.gateway)
					: await describedTool(harness.gateway, surface === 'helper');
			corruptInputSchema(tool.inputSchema);
			mutableRecord(mutableRecord(mutableRecord(tool.outputSchema).properties).result).type =
				'boolean';
			if (surface !== 'search')
				mutableRecord(mutableRecord(tool.annotations).category).label = 'corrupted';
			mutableRecord(tool.schemaHint).message = 'corrupted';

			const valid = await harness.gateway.call(callInput());
			expect(valid.results['original-item']?.ok).toBe(true);
			expect(harness.effects).toHaveLength(1);
			const fresh = await describedTool(harness.gateway, true);
			expect(fresh.inputSchema).toEqual(inputSchema);
			expect(fresh.outputSchema).toEqual({
				type: 'object',
				properties: { result: { type: 'integer' } },
			});
			expect(fresh.annotations).toEqual({ readOnlyHint: true, category: { label: 'original' } });
			expect(fresh.typescriptHelper).toBe('// immutable helper');
			expect(fresh.schemaHint).toEqual({
				message: 'Full input schema included.',
				next: 'call_ready',
			});
		},
	);

	it('isolates published compact wrapper schemas from later listings', async () => {
		const { gateway } = createHarness();
		const descriptors = await gateway.listTools('compact');
		const originals = structuredClone(descriptors);
		for (const descriptor of descriptors)
			mutableRecord(descriptor.inputSchema.properties).injected = { type: 'boolean' };
		expect(await gateway.listTools('compact')).toEqual(originals);
	});
});
