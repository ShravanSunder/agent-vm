import { describe, expect, it, vi } from 'vitest';

const forbiddenStandaloneRuntimeDependencies = [
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/gateway-control-contracts',
	'@agent-vm/gateway-runtime',
	'@agent-vm/hermes-gateway',
	'@agent-vm/managed-vm',
	'@agent-vm/openclaw-agent-vm-plugin',
	'@agent-vm/openclaw-gateway',
	'ssh2',
] as const;

describe('standalone Tool Portal module boundary', () => {
	it('constructs the standalone service through its public subpath without managed runtime modules', async () => {
		for (const dependency of forbiddenStandaloneRuntimeDependencies) {
			vi.doMock(dependency, () => {
				throw new Error(
					`Standalone Tool Portal loaded forbidden runtime dependency: ${dependency}`,
				);
			});
		}

		const publicStandaloneModuleUrl = import.meta
			.resolve('@agent-vm/tool-portal/standalone-entrypoint');
		const standalone: typeof import('@agent-vm/tool-portal/standalone-entrypoint') = await import(
			/* @vite-ignore */ publicStandaloneModuleUrl
		);
		const service = standalone.createStandaloneV1ToolPortalService({
			approvalCoordinator: standalone.createStandaloneToolPortalApprovalCoordinator({
				credentials: [{ agentId: 'agent-a', hmacKey: 'approval-test-key', keyVersion: 1 }],
				now: () => new Date('2026-07-18T12:00:00.000Z'),
				serviceGeneration: 'standalone-service:1',
			}),
			baseSemanticSnapshot: {
				activeRevision: 'semantic:1',
				agentProjections: {
					'agent-a': {
						agentId: 'agent-a',
						credentialVersion: 1,
						profileAssignmentRevision: 'profile-assignment:1',
						toolPortalProfileId: 'code-builder',
					},
				},
				bindingRevision: 'binding:1',
				catalogRevision: 'catalog:1',
				desiredRevision: 'semantic:1',
				namespaceDiscoveryByProfile: { 'code-builder': [{ namespace: 'github' }] },
				profilePolicyRevision: 'policy:1',
				providerRevision: 'provider:1',
				schemaRevision: 'schema:1',
				schemaVersion: 1,
				surfaceEligibilityByProfile: { 'code-builder': { github: ['mcp'] } },
			},
			backendPorts: {
				mcpProvider: {
					backendKind: 'mcp_provider',
					call: async (): Promise<never> => {
						throw new Error('Calls are outside the module-boundary proof.');
					},
					describe: async (): Promise<never> => {
						throw new Error('Describe is outside the module-boundary proof.');
					},
					list: async (): Promise<never> => {
						throw new Error('List is outside the module-boundary proof.');
					},
					search: async (): Promise<never> => {
						throw new Error('Search is outside the module-boundary proof.');
					},
				},
			},
			config: {
				agents: { 'agent-a': { profile: 'code-builder' } },
				authentication: {
					agents: {
						'agent-a': {
							approvalHmacKey: { name: 'APPROVAL_KEY', source: 'environment' },
							bearerKey: { name: 'BEARER_KEY', source: 'environment' },
							credentialVersion: 1,
						},
					},
				},
				drain: { timeoutMs: 1_000 },
				entrypoints: {
					stdio: {
						authentication: { agentId: 'agent-a', kind: 'scoped-principal' },
						enabled: true,
					},
				},
				mode: 'standalone',
				profiles: {
					'code-builder': {
						namespaces: {
							github: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: ['get_issue'], deny: [] },
								},
								tools: { allow: ['get_issue'], deny: [] },
							},
						},
					},
				},
				schemaVersion: 1,
			},
			mcpConfig: {
				providers: {
					github: {
						discovery: {},
						kind: 'mcp',
						namespace: 'github',
						secretPolicies: {},
						transport: {
							headers: {},
							kind: 'streamable-http',
							requiredEgressHosts: [],
							url: 'https://github.example.test/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
		});

		expect(standalone.startStandaloneToolPortalEntrypoints).toBeTypeOf('function');
		expect(service.mode).toBe('standalone-v1');
		expect(Object.keys(service).toSorted()).toEqual(['capabilityCore', 'mode']);
	});
});
