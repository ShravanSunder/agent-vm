import { describe, expect, it } from 'vitest';

import { resolveUpstreamServers } from './provider-runtime.js';

describe('provider runtime resolution', () => {
	it('resolves stdio environment and remote header secrets from MCP config', async () => {
		const resolved = await resolveUpstreamServers({
			config: {
				providers: {
					linear: {
						discovery: {},
						kind: 'mcp',
						namespace: 'linear',
						secretPolicies: {},
						transport: {
							headers: {
								Authorization: { name: 'LINEAR_TOKEN', source: 'environment' },
							},
							kind: 'streamable-http',
							requiredEgressHosts: [],
							url: 'https://mcp.linear.app/mcp',
						},
					},
					local: {
						discovery: {},
						kind: 'mcp',
						namespace: 'local',
						secretPolicies: {},
						transport: {
							args: ['serve'],
							command: 'local-mcp',
							env: {
								API_TOKEN: { name: 'LOCAL_TOKEN', source: 'environment' },
							},
							kind: 'stdio',
							networkAccess: 'none',
							requiredEgressHosts: [],
						},
					},
				},
				schemaVersion: 1,
			},
			resolveSecret: async (secret) => {
				if (secret.source !== 'environment') {
					throw new Error(`unexpected secret source ${secret.source}`);
				}
				return `resolved:${secret.name}`;
			},
		});

		expect(resolved).toEqual([
			{
				headers: { Authorization: 'resolved:LINEAR_TOKEN' },
				namespace: 'linear',
				transport: 'streamable-http',
				url: 'https://mcp.linear.app/mcp',
			},
			{
				args: ['serve'],
				command: 'local-mcp',
				env: { API_TOKEN: 'resolved:LOCAL_TOKEN' },
				namespace: 'local',
				transport: 'stdio',
			},
		]);
	});
});
