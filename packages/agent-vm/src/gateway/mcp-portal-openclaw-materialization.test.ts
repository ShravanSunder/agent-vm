import { describe, expect, it } from 'vitest';

import {
	buildOpenClawMcpPortalMaterialization,
	type OpenClawMcpPortalMaterializationOptions,
} from './mcp-portal-openclaw-materialization.js';

const baseOptions = {
	agents: [{ id: 'shravan', toolVmProfile: 'standard' }],
	configDir: '/repo/config/gateways/shravan',
	mcpPortalConfig: {
		agents: { shravan: { profile: 'builder' } },
		profiles: { builder: { enabledNamespaces: ['linear'] } },
		schemaVersion: 1,
		server: {
			accessHeader: {
				name: 'x-agent-vm-mcp-portal-secret',
				secret: { source: 'environment', name: 'MCP_PORTAL_SERVER_SECRET' },
			},
			host: '127.0.0.1',
			port: 18790,
		},
	},
} satisfies OpenClawMcpPortalMaterializationOptions;

describe('buildOpenClawMcpPortalMaterialization', () => {
	it('creates plugin config and one MCP server entry per configured agent', () => {
		const materialization = buildOpenClawMcpPortalMaterialization(baseOptions);

		expect(materialization.pluginConfig).toEqual({
			configDir: '/repo/config/gateways/shravan',
		});
		expect(materialization.mcpServers).toEqual({
			mcp_portal_shravan: {
				headers: {
					'x-agent-vm-mcp-portal-secret': '${MCP_PORTAL_SERVER_SECRET}',
				},
				transport: 'streamable-http',
				url: 'http://127.0.0.1:18790/agents/shravan/mcp',
			},
		});
	});

	it('fails before materialization when a system agent lacks a portal profile', () => {
		expect(() =>
			buildOpenClawMcpPortalMaterialization({
				...baseOptions,
				agents: [{ id: 'missing' }],
			}),
		).toThrow(/missing MCP Portal profile binding for agent 'missing'/u);
	});

	it('uses collision-free server names for punctuation in agent ids', () => {
		const materialization = buildOpenClawMcpPortalMaterialization({
			...baseOptions,
			agents: [{ id: 'agent-a' }, { id: 'agent_a' }],
			mcpPortalConfig: {
				...baseOptions.mcpPortalConfig,
				agents: {
					'agent-a': { profile: 'builder' },
					agent_a: { profile: 'builder' },
				},
			},
		});

		expect(Object.keys(materialization.mcpServers).toSorted()).toEqual([
			'mcp_portal_agent_2d_a',
			'mcp_portal_agent_5f_a',
		]);
	});
});
