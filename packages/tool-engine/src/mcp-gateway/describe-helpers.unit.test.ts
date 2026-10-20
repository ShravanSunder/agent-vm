import { describe, expect, it, vi } from 'vitest';

import {
	createHarness,
	output,
	retainCatalog,
} from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

// Literal consumer output from the fixture's declared schemas and metadata.
const healthyRead = {
	annotations: { readOnlyHint: true, category: { label: 'original' } },
	namespace: 'alpha',
	related: [],
	schemaHint: { message: 'Full input schema included.', next: 'call_ready' },
	toolName: 'read',
	toolRef: 'mcp:YWxwaGE:cmVhZA',
	inputSchema: {
		type: 'object',
		properties: { value: { type: 'integer' } },
		required: ['value'],
		additionalProperties: false,
	},
	outputSchema: { type: 'object', properties: { result: { type: 'integer' } } },
};
const describeBatch = {
	requests: [
		{
			id: 'helper',
			tools: [{ namespace: 'alpha', toolName: 'read' }],
			includeTypescriptHelper: true,
		},
		{ id: 'plain', tools: [{ namespace: 'alpha', toolName: 'read' }] },
	],
};
const refusals = [
	{ discovery: 'incomplete', kind: 'upstream_discovery_failed', namespace: 'beta' },
	{ discovery: 'duplicate', kind: 'catalog_tool_name_collision', namespace: 'alpha' },
] as const;

describe('compact describe helper containment', () => {
	it.each(refusals)(
		'keeps healthy describe items when $discovery refuses full helpers',
		async ({ discovery, kind, namespace }) => {
			const harness = createHarness(undefined, discovery);
			const publisher = vi.fn(retainCatalog);
			harness.setPrepared(publisher);

			const result = await harness.gateway.describe(describeBatch);

			expect(result.ok).toBe(true);
			expect(result.errors).toEqual([]);
			expect(output(result, 'helper')).toEqual({
				tools: [
					{
						...healthyRead,
						typescriptHelperUnavailable: {
							kind: 'catalog_preparation_refused',
							refusals: [{ kind, namespace }],
						},
					},
				],
			});
			expect(output(result, 'plain')).toEqual({ tools: [healthyRead] });
			expect(publisher).not.toHaveBeenCalled();
			if (discovery === 'incomplete')
				expect(result.diagnostics).toMatchObject([
					{ kind: 'upstream_discovery_failed', namespace: 'beta' },
				]);
			else expect(result.diagnostics).toEqual([]);
			await expect(harness.gateway.prepareCatalog()).rejects.toMatchObject({
				name: 'PortalCatalogPreparationError',
			});
			await expect(harness.gateway.listTools('catalog')).rejects.toMatchObject({
				name: 'PortalCatalogPreparationError',
			});
		},
	);

	it('returns exact prepared helper bytes with a complete allowed catalog', async () => {
		const harness = createHarness();
		harness.setPrepared((catalog) => ({
			...catalog,
			typescriptHelpersByToolRef: { 'mcp:YWxwaGE:cmVhZA': '// prepared helper bytes\n' },
		}));

		const result = await harness.gateway.describe(describeBatch);

		expect(result.ok).toBe(true);
		expect(output(result, 'helper')).toEqual({
			tools: [{ ...healthyRead, typescriptHelper: '// prepared helper bytes\n' }],
		});
		expect(output(result, 'plain')).toEqual({ tools: [healthyRead] });
		expect(result.diagnostics).toEqual([]);
	});

	it.each(refusals)(
		'keeps helper-free describe independent of $discovery full preparation',
		async ({ discovery }) => {
			const harness = createHarness(undefined, discovery);
			const publisher = vi.fn(retainCatalog);
			harness.setPrepared(publisher);

			const result = await harness.gateway.describe({ requests: [describeBatch.requests[1]] });

			expect(result.ok).toBe(true);
			expect(output(result, 'plain')).toEqual({ tools: [healthyRead] });
			expect(publisher).not.toHaveBeenCalled();
		},
	);

	it('contains a prepared-port exception without leaking text or rejecting a healthy sibling', async () => {
		const harness = createHarness();
		harness.setPrepared(() => {
			throw new Error('compiler private detail canary');
		});

		const result = await harness.gateway.describe(describeBatch);

		expect(result.ok).toBe(true);
		expect(output(result, 'helper')).toEqual({
			tools: [
				{
					...healthyRead,
					typescriptHelperUnavailable: { kind: 'helper_preparation_failed', namespace: 'alpha' },
				},
			],
		});
		expect(output(result, 'plain')).toEqual({ tools: [healthyRead] });
		expect(JSON.stringify(result)).not.toContain('compiler private detail canary');
	});
});
