/* oxlint-disable no-await-in-loop -- These controls sequence the same live host/provider state so effects, failure changes and replay races remain attributable. */
import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-collaboration/tool-access/contracts';
import { ToolPortalMcpClient } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import { createNodeToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';
import { mcpConfigSchema, type StandaloneToolPortalConfig } from '@agent-vm/config-contracts';
import { createManagedMcpProviderBackendFactoryFromConfig } from '@agent-vm/mcp-portal/mcp-provider-backend';
import {
	createToolPortalService,
	createStandaloneToolPortalProjectionService,
	createStandaloneToolPortalApprovalCoordinator as createOldCoordinator,
	startStandaloneToolPortalMcpHttpServer as startOldMcp,
	startStandaloneToolPortalHttpServer as startOldJson,
	type ToolPortalStandaloneSemanticSnapshot,
} from '@agent-vm/tool-portal';
import { expect, it } from 'vitest';

import {
	startStandaloneToolPortalMcpHttpServer,
	startStandaloneToolPortalHttpServer,
} from '#node-host/standalone/standalone-http-servers';
import {
	startControlledProvider,
	toolInputSchema,
} from '#node-host/test-fixtures/node-host-fixture';
import { createNodeToolPortalMcpTransport as createOldTransport } from '#node-host/test-fixtures/old-node-tool-portal-mcp-transport';
import {
	createStandaloneHostFixture,
	standaloneCredentials,
	standaloneKey,
	standaloneSemanticRevisions,
} from '#node-host/test-fixtures/standalone-host-fixture';

for (const length of [4, 257, 10_000]) {
	it(`preserves all four old standalone operations and canonical call identity with public names of ${length} characters`, async () => {
		const namespace = length === 4 ? 'example' : 'n'.repeat(length);
		const name = length === 4 ? 'read' : 't'.repeat(length);
		const provider = await startControlledProvider(
			'parity',
			[name, 'ask', 'hidden', 'blocked'].map((tool) => ({
				name: tool,
				description: `${tool} capability`,
				inputSchema: toolInputSchema,
			})),
		);
		provider.setCallResult({
			content: [{ type: 'text', text: 'canonical resource response' }],
			structuredContent: { value: 42 },
		});
		const mcpConfig = mcpConfigSchema.parse({
			schemaVersion: 1,
			providers: {
				example: {
					kind: 'mcp',
					namespace,
					discovery: { summary: 'Controlled provider tools.' },
					transport: {
						kind: 'streamable-http',
						url: provider.url,
						requiredEgressHosts: ['127.0.0.1'],
					},
				},
			},
		});
		const namespacePolicy = {
			backend: { kind: 'mcp_provider' as const },
			tools: { allow: '*' as const, deny: ['hidden', 'blocked'] },
			calls: {
				withoutApproval: { allow: [name], deny: [] },
				requiresApproval: { allow: ['ask'], deny: [] },
			},
		};
		const config: StandaloneToolPortalConfig = {
			schemaVersion: 1,
			mode: 'standalone',
			agents: Object.fromEntries(
				['agent-a', 'agent-b'].map((agent) => [agent, { profile: 'builder' }]),
			),
			profiles: { builder: { namespaces: { [namespace]: namespacePolicy } } },
			authentication: {
				agents: Object.fromEntries(
					['agent-a', 'agent-b'].map((agent) => [
						agent,
						{
							credentialVersion: 1,
							approvalHmacKey: { source: 'environment' as const, name: 'TEST_KEY' },
							bearerKey: { source: 'environment' as const, name: 'TEST_BEARER' },
						},
					]),
				),
			},
			drain: { timeoutMs: 1000 },
			entrypoints: {
				stdio: { enabled: true, authentication: { kind: 'scoped-principal', agentId: 'agent-a' } },
			},
		};
		const snapshot: ToolPortalStandaloneSemanticSnapshot = {
			...standaloneSemanticRevisions,
			desiredRevision: standaloneSemanticRevisions.activeRevision,
			schemaVersion: 1,
			agentProjections: Object.fromEntries(
				standaloneCredentials.credentials.map(({ principal, credentialVersion }) => [
					principal.agentId,
					{ ...principal, credentialVersion },
				]),
			),
			namespaceDiscoveryByProfile: {
				builder: [{ namespace, summary: 'Controlled provider tools.' }],
			},
			surfaceEligibilityByProfile: { builder: { [namespace]: ['http', 'mcp'] } },
		};
		const factory = await createManagedMcpProviderBackendFactoryFromConfig({
			mcpConfig,
			resolveSecret: async () => {
				throw new Error('No fixture secrets');
			},
		});
		// Use the existing public resource-session port to choose the same owning generation.
		// No canonical result field is removed or rewritten by this comparison.
		const backend = factory.createBackend(
			{
				agentId: 'agent-a',
				profile: 'builder',
				namespaces: {
					[namespace]: {
						tools: namespacePolicy.tools,
						calls: {
							withoutApproval: { allow: '*', deny: [] },
							requiresApproval: { allow: [], deny: [] },
						},
					},
				},
			},
			{ sessionKey: 'controlled-resource-generation', portalAgentScopeSource: 'mcp-proxy-bearer' },
		);
		const old = createToolPortalService({
			config,
			mcpConfig,
			baseSemanticSnapshot: snapshot,
			approvalCoordinator: createOldCoordinator({
				credentials: [{ agentId: 'agent-a', hmacKey: standaloneKey, keyVersion: 1 }],
				serviceGeneration: standaloneCredentials.serviceGeneration,
			}),
			backendPorts: {
				mcpProvider: {
					...backend,
					backendKind: 'mcp_provider',
					call: async (request, options) =>
						backend.call(request, {
							operationIdsByCallId: Object.fromEntries(
								request.calls.map((call) => [call.id, options.dispatchAuthority.operationId]),
							),
						}),
				},
			},
		});
		const {
			activeRevision,
			bindingRevision,
			catalogRevision,
			profilePolicyRevision,
			providerRevision,
			schemaRevision,
		} = old.capabilityCore.semanticSnapshot;
		const fixture = await createStandaloneHostFixture(provider, namespace, {
			activeRevision,
			bindingRevision,
			catalogRevision,
			profilePolicyRevision,
			providerRevision,
			schemaRevision,
		});
		const common = {
			hostname: '127.0.0.1',
			port: 0,
			routePath: '/portal',
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: [],
			credentialSet: standaloneCredentials,
			artifactReader: fixture.artifactReader,
		};
		const oldService = createStandaloneToolPortalProjectionService(old);
		const oldMcp = await startOldMcp({ ...common, service: oldService });
		const currentMcp = await startStandaloneToolPortalMcpHttpServer({
			...common,
			service: fixture.service,
		});
		const oldJson = await startOldJson({ ...common, service: oldService });
		const currentJson = await startStandaloneToolPortalHttpServer({
			...common,
			service: fixture.service,
		});
		const oldClient = new ToolPortalMcpClient({
			transport: createOldTransport({
				kind: 'http',
				endpoint: oldMcp.endpoint,
				authorization: 'credential-agent-a',
			}),
		});
		const client = new ToolPortalMcpClient({
			transport: createNodeToolPortalMcpTransport({
				kind: 'http',
				endpoint: currentMcp.endpoint,
				authorization: 'credential-agent-a',
			}),
		});
		try {
			await oldClient.connect();
			await client.connect();
			const list = PortalListRequestSchema.parse({
				requests: [
					{ id: 'list' },

					{ id: 'missing', namespaces: ['missing'] },
				],
			});
			const search = PortalSearchRequestSchema.parse({ requests: [{ id: 'search', query: name }] });
			const describe = PortalDescribeRequestSchema.parse({
				requests: [
					{
						id: 'describe',
						tools: [{ namespace, name }],
						includeTypescriptHelper: length < 10_000,
					},
				],
			});
			const call = PortalCallRequestSchema.parse({
				calls: [{ id: 'call', namespace, name, arguments: { value: 42 } }],
			});
			const expectedList = await oldClient.list(list);
			expect(await client.list(list)).toEqual(expectedList);
			const selected = PortalListRequestSchema.parse({
				requests: [{ id: 'selected', tools: [{ namespace, name }] }],
			});
			expect(await client.list(selected)).toEqual(await oldClient.list(selected));
			expect(await client.search(search)).toEqual(await oldClient.search(search));
			const expectedDescription = await oldClient.describe(describe);
			expect(await client.describe(describe)).toEqual(expectedDescription);
			if (length === 10_000) {
				const oversized = PortalDescribeRequestSchema.parse({
					requests: describe.requests.map((item) => ({ ...item, includeTypescriptHelper: true })),
				});
				await expect(oldClient.describe(oversized)).rejects.toThrow();
				await expect(client.describe(oversized)).rejects.toThrow();
			}
			expect(await client.call(call)).toEqual(await oldClient.call(call));
			expect(provider.effects).toHaveLength(2);
			for (const [operation, request] of [
				['list', list],
				['search', search],
				['describe', describe],
				['call', call],
			] as const) {
				const post = async (endpoint: URL): Promise<unknown> => {
					const response = await fetch(endpoint, {
						method: 'POST',
						headers: {
							authorization: 'Bearer credential-agent-a',
							'content-type': 'application/json',
						},
						body: JSON.stringify({ operation, request }),
					});
					expect(response.status).toBe(200);
					return response.json();
				};
				expect(await post(currentJson.endpoint)).toEqual(await post(oldJson.endpoint));
			}
			expect(provider.effects).toHaveLength(4);
			const denied = {
				calls: [{ id: 'denied', namespace, name: 'blocked', arguments: { value: 42 } }],
			};
			expect(await client.call(denied)).toEqual(await oldClient.call(denied));
			expect(provider.effects).toHaveLength(4);
		} finally {
			await Promise.all([client.close(), oldClient.close()]);
			await Promise.all([
				oldMcp.retire(),
				currentMcp.retire(),
				oldJson.retire(),
				currentJson.retire(),
			]);
			await fixture.close();
			await factory.close();
			await provider.close();
		}
	});
}
