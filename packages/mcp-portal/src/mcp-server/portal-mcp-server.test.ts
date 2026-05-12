import { describe, expect, it } from 'vitest';

import { listPortalMcpTools } from './portal-mcp-server.js';

describe('portal MCP server', () => {
	it('exposes exactly the four progressive-disclosure tools', () => {
		expect(listPortalMcpTools().map((tool) => tool.name)).toEqual([
			'mcp_portal_list',
			'mcp_portal_search',
			'mcp_portal_describe',
			'mcp_portal_call',
		]);
	});

	it('exposes the real input schema for each portal tool', () => {
		const toolsByName = new Map(listPortalMcpTools().map((tool) => [tool.name, tool]));

		expect(toolsByName.get('mcp_portal_list')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				requests: expect.objectContaining({ type: 'array' }),
			},
			required: ['requests'],
			type: 'object',
		});
		expect(toolsByName.get('mcp_portal_search')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				requests: expect.objectContaining({ type: 'array' }),
			},
			required: ['requests'],
			type: 'object',
		});
		expect(toolsByName.get('mcp_portal_describe')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				requests: expect.objectContaining({ type: 'array' }),
			},
			required: ['requests'],
			type: 'object',
		});
		expect(toolsByName.get('mcp_portal_call')?.inputSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				calls: expect.objectContaining({ type: 'array' }),
			},
			required: ['calls'],
			type: 'object',
		});
		expect(JSON.stringify(toolsByName.get('mcp_portal_call')?.inputSchema)).not.toContain(
			'commitToken',
		);
		expect(JSON.stringify(toolsByName.get('mcp_portal_call')?.inputSchema)).not.toContain(
			'portalApprovalNonce',
		);
	});
});
