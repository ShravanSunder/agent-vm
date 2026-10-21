import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import { createHarness, frozenNames } from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

describe('direct MCP projection', () => {
	it('offers native tools plus all four search tools', async () => {
		const { gateway } = createHarness();
		const page = await gateway.listTools('direct');
		expect(page.tools.map((tool) => tool.name)).toEqual([
			...frozenNames,
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
		expect(page.nextCursor).toBeUndefined();
	});
	it.each([
		['mcp_portal_list', { requests: [{ id: 'r' }] }],
		['mcp_portal_search', { requests: [{ id: 'r', query: 'read' }] }],
		[
			'mcp_portal_describe',
			{ requests: [{ id: 'r', tools: [{ namespace: 'alpha', toolName: 'read' }] }] },
		],
		[
			'mcp_portal_call',
			{ calls: [{ id: 'r', namespace: 'alpha', toolName: 'read', arguments: { value: 42 } }] },
		],
	] as const)('routes %s through the direct entry', async (name, args) => {
		const { gateway, effects } = createHarness();
		const result = await gateway.callDirect({
			name,
			arguments: jsonObjectSchema.parse(args),
			item: 'entry',
			catalog: await gateway.prepareCatalog(),
		});
		expect(result.ok).toBe(true);
		expect(result.results.r?.ok).toBe(true);
		expect(effects).toHaveLength(name === 'mcp_portal_call' ? 1 : 0);
	});
});
