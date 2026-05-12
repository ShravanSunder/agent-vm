import { describe, expect, it } from 'vitest';

import { createPortalBindingsForAgents } from './portal-server-manager.js';

describe('portal server manager', () => {
	it('creates one Hono Streamable HTTP MCP server entry and allowlist per agent', () => {
		const result = createPortalBindingsForAgents({
			agents: [{ id: 'agent-a' }, { id: 'agent-b' }],
			baseUrl: 'http://127.0.0.1:8787',
			secretFactory: (agentId, bindingId) => `${agentId}-${bindingId}-secret`,
		});

		expect(result.mcpServers).toEqual({
			mcp_portal_agent_a_a51d7389ba2c: {
				headers: {
					'x-mcp-portal-binding-secret': 'agent-a-mcp-portal-agent-a-a51d7389ba2c-secret',
				},
				transport: 'streamable-http',
				url: 'http://127.0.0.1:8787/mcp-portal/bindings/mcp-portal-agent-a-a51d7389ba2c/mcp',
			},
			mcp_portal_agent_b_996a53b592e9: {
				headers: {
					'x-mcp-portal-binding-secret': 'agent-b-mcp-portal-agent-b-996a53b592e9-secret',
				},
				transport: 'streamable-http',
				url: 'http://127.0.0.1:8787/mcp-portal/bindings/mcp-portal-agent-b-996a53b592e9/mcp',
			},
		});
		expect(result.agentToolAllowlists).toEqual({
			'agent-a': [
				'mcp_portal_agent_a_a51d7389ba2c__mcp_portal_list',
				'mcp_portal_agent_a_a51d7389ba2c__mcp_portal_search',
				'mcp_portal_agent_a_a51d7389ba2c__mcp_portal_describe',
				'mcp_portal_agent_a_a51d7389ba2c__mcp_portal_call',
			],
			'agent-b': [
				'mcp_portal_agent_b_996a53b592e9__mcp_portal_list',
				'mcp_portal_agent_b_996a53b592e9__mcp_portal_search',
				'mcp_portal_agent_b_996a53b592e9__mcp_portal_describe',
				'mcp_portal_agent_b_996a53b592e9__mcp_portal_call',
			],
		});
		expect(JSON.stringify(result.bindings)).not.toContain('upstream');
	});

	it('keeps sanitized collisions distinct', () => {
		const result = createPortalBindingsForAgents({
			agents: [{ id: 'a-b' }, { id: 'a.b' }],
			baseUrl: 'http://127.0.0.1:8787',
			secretFactory: (_agentId, bindingId) => `${bindingId}-secret`,
		});

		expect(result.bindings.map((binding) => binding.bindingId)).toEqual([
			'mcp-portal-a-b-d44362d67d92',
			'mcp-portal-a-b-2e7336dc8eba',
		]);
		expect(result.bindings.map((binding) => binding.serverName)).toEqual([
			'mcp_portal_a_b_d44362d67d92',
			'mcp_portal_a_b_2e7336dc8eba',
		]);
	});
});
