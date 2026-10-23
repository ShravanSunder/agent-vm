import path from 'node:path';

import { nodeHostConfigSchema, type NodeHostConfig } from '@agent-collaboration/tool-host-node';

const revision = { owner: 'configured-host', revision: 'v1' };

export function nodeParityHostConfig(
	directory: string,
	urls: readonly [string, string],
	exposure: 'compact' | 'catalog' = 'compact',
): NodeHostConfig {
	const policy = {
		backendKind: 'mcp_provider',
		tools: { allow: '*', deny: ['hidden', 'blocked'] },
		calls: {
			kind: 'selectors',
			withoutApproval: { allow: ['read', 'fail'], deny: [] },
			requiresApproval: { allow: ['ask'], deny: [] },
		},
		operations: {},
	};
	return nodeHostConfigSchema.parse({
		schemaVersion: 1,
		authority: 'test-tool-authority',
		revision,
		workspaceLayer: 'not-configured',
		storeDirectory: path.join(directory, 'store'),
		auth: {
			audience: 'tool-portal:mcp',
			serviceGeneration: 'generation-1',
			credentials: ['a', 'b'].map((agent) => ({
				bearerToken: `credential-${agent}`,
				credentialVersion: 1,
				principal: {
					agentId: `agent-${agent}`,
					profileAssignmentRevision: 'assignment-1',
					toolPortalProfileId: `profile-${agent}`,
				},
			})),
		},
		profiles: {
			'profile-a': { revision, profile: { profileId: 'profile-a', namespaces: { alpha: policy } } },
			'profile-b': { revision, profile: { profileId: 'profile-b', namespaces: { beta: policy } } },
		},
		mcp: {
			schemaVersion: 1,
			providers: Object.fromEntries(
				['alpha', 'beta'].map((namespace, index) => [
					namespace,
					{
						kind: 'mcp',
						namespace,
						transport: {
							kind: 'streamable-http',
							url: urls[index],
							headers: {
								Authorization: {
									source: 'environment',
									name: 'PROVIDER_SECRET',
									format: { kind: 'bearer' },
								},
								'x-selected-binding': { source: 'environment', name: 'HEADER_SECRET' },
							},
						},
					},
				]),
			),
		},
		listener: {
			kind: 'http',
			hostname: '127.0.0.1',
			port: 0,
			routePath: '/mcp',
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: ['https://allowed.example'],
		},
		exposure,
	});
}
