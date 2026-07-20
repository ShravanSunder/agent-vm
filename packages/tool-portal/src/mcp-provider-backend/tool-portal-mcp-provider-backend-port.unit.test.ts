import { PortalCallRequestSchema, PortalListRequestSchema } from '@agent-vm/agent-portal-sdk';
import type {
	ManagedToolPortalConfig,
	StandaloneToolPortalConfig,
} from '@agent-vm/config-contracts';
import {
	GatewayRuntimeMcpProviderDispatchGrantSchema,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import type {
	ManagedMcpProviderBackendFactory,
	McpProviderCapabilityBackend,
} from '@agent-vm/mcp-portal/mcp-provider-backend';
import { describe, expect, it, vi } from 'vitest';

import type {
	ToolPortalStandaloneMcpBackendInvocationOptions,
	ToolPortalStandaloneMcpBackendReadOptions,
} from '../tool-portal-service.js';
import { createToolPortalMcpProviderBackendPort } from './tool-portal-mcp-provider-backend-port.js';

const managedConfig = {
	agents: {
		'agent-a': { profile: 'profile-a' },
		'agent-b': { profile: 'profile-b' },
	},
	mode: 'managed',
	profiles: {
		'profile-a': {
			namespaces: {
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['create_issue', 'get_issue'], deny: [] },
				},
			},
		},
		'profile-b': {
			namespaces: {
				linear: {
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
} satisfies ManagedToolPortalConfig;

const standaloneConfig = {
	agents: { 'agent-a': { profile: 'profile-a' } },
	authentication: {
		agents: {
			'agent-a': {
				approvalHmacKey: { name: 'AGENT_A_APPROVAL_KEY', source: 'environment' },
				bearerKey: { name: 'AGENT_A_BEARER_KEY', source: 'environment' },
				credentialVersion: 1,
			},
		},
	},
	drain: { timeoutMs: 1_000 },
	entrypoints: {
		mcp: {
			address: { host: '127.0.0.1', port: 18_793 },
			allowedHosts: ['127.0.0.1'],
			allowedOrigins: ['http://127.0.0.1:18793'],
			authentication: { kind: 'bearer' },
			enabled: true,
			route: '/mcp',
			transport: 'streamable-http',
		},
	},
	mode: 'standalone',
	profiles: managedConfig.profiles,
	schemaVersion: 1,
} satisfies StandaloneToolPortalConfig;

function managedTrustedContext(
	agentId: 'agent-a' | 'agent-b',
): GatewayRuntimeTrustedInvocationContext {
	return {
		correlation: {
			runId: `run-${agentId}`,
			sessionId: `session-${agentId}`,
			toolCallId: `tool-call-${agentId}`,
		},
		principal: {
			agentId,
			frameworkIdentity: { kind: 'hermes', profileName: `${agentId}-profile` },
			profileAssignmentRevision: `profile-assignment-${agentId}-1`,
			toolPortalProfileId: agentId === 'agent-a' ? 'profile-a' : 'profile-b',
		},
		requester: { authenticatedSubjectId: `subject-${agentId}` },
	};
}

function standaloneReadOptions(props?: {
	readonly credentialVersion?: number;
	readonly profileAssignmentRevision?: string;
	readonly serviceGeneration?: string;
	readonly sessionId?: string;
}): ToolPortalStandaloneMcpBackendReadOptions {
	return {
		correlation: { sessionId: props?.sessionId ?? 'standalone-session-a' },
		origin: {
			authenticatedEnvelope: {
				audience: 'tool-portal:mcp',
				principal: {
					agentId: 'agent-a',
					credentialVersion: props?.credentialVersion ?? 1,
					profileAssignmentRevision:
						props?.profileAssignmentRevision ?? 'profile-assignment-agent-a-1',
					toolPortalProfileId: 'profile-a',
				},
				serviceGeneration: props?.serviceGeneration ?? 'standalone-service-1',
			},
			kind: 'standalone',
		},
		surfaceClass: 'mcp',
	};
}

function createBackendFactoryFixture(): {
	readonly backendFactory: ManagedMcpProviderBackendFactory;
	readonly callOptions: unknown[];
	readonly createdBackends: {
		readonly agentId: string;
		readonly namespaces: readonly string[];
		readonly options: unknown;
	}[];
} {
	const callOptions: unknown[] = [];
	const createdBackends: {
		readonly agentId: string;
		readonly namespaces: readonly string[];
		readonly options: unknown;
	}[] = [];
	return {
		backendFactory: {
			close: vi.fn(),
			createBackend: vi.fn((projection, options): McpProviderCapabilityBackend => {
				createdBackends.push({
					agentId: projection.agentId,
					namespaces: Object.keys(projection.namespaces).toSorted(),
					options,
				});
				return {
					call: async (request, optionsForCall) => {
						callOptions.push(optionsForCall);
						const parsedRequest = PortalCallRequestSchema.parse(request);
						const operationIdsByCallId = optionsForCall?.operationIdsByCallId ?? {};
						return {
							items: parsedRequest.calls.map((call) => ({
								id: call.id,
								operationId:
									operationIdsByCallId[call.id] ?? '50000000-0000-4000-8000-000000000005',
								outcome: {
									certainty: 'proven' as const,
									completion: 'succeeded' as const,
									kind: 'completed' as const,
									retryClass: 'forbidden' as const,
								},
								owningGeneration: 'provider-generation-1',
								status: 'ok' as const,
								value: { ok: true },
							})),
							ok: true,
						};
					},
					describe: vi.fn(),
					list: async (request) => ({
						items: PortalListRequestSchema.parse(request).requests.map((item) => ({
							id: item.id,
							status: 'ok' as const,
							value: { namespaces: Object.keys(projection.namespaces), tools: [] },
						})),
						ok: true,
					}),
					search: vi.fn(),
				};
			}),
			retireSession: vi.fn(),
		},
		callOptions,
		createdBackends,
	};
}

describe('Tool Portal MCP provider backend port', () => {
	it('keeps managed provider pooling stable across requester and correlation changes', async () => {
		const fixture = createBackendFactoryFixture();
		const port = createToolPortalMcpProviderBackendPort({
			backendFactory: fixture.backendFactory,
			mode: 'managed',
			toolPortalConfig: managedConfig,
		});
		const context = managedTrustedContext('agent-a');

		await port.list(
			{ requests: [{ id: 'first', limit: 20, namespaces: ['github'] }] },
			{ surfaceClass: 'protected_uds', trustedContext: context },
		);
		await port.list(
			{ requests: [{ id: 'second', limit: 20, namespaces: ['github'] }] },
			{
				surfaceClass: 'protected_uds',
				trustedContext: {
					...context,
					correlation: { sessionId: 'later-session' },
					requester: { authenticatedSubjectId: 'later-subject' },
				},
			},
		);
		await port.list(
			{ requests: [{ id: 'agent-b', limit: 20, namespaces: ['linear'] }] },
			{
				surfaceClass: 'protected_uds',
				trustedContext: managedTrustedContext('agent-b'),
			},
		);

		expect(fixture.createdBackends).toHaveLength(3);
		expect(fixture.createdBackends[0]?.options).toEqual({
			portalAgentScopeSource: 'tool-portal-service',
			sessionKey: expect.stringMatching(/^tool-portal:managed:mcp:[A-Za-z0-9_-]{43}$/u),
		});
		expect(fixture.createdBackends[0]?.options).toEqual(fixture.createdBackends[1]?.options);
		expect(fixture.createdBackends[0]?.options).not.toEqual(fixture.createdBackends[2]?.options);
		expect(fixture.createdBackends[2]).toMatchObject({
			agentId: 'agent-b',
			namespaces: ['linear'],
		});
	});

	it('isolates standalone sessions by complete authenticated envelope and correlation session', async () => {
		const fixture = createBackendFactoryFixture();
		const port = createToolPortalMcpProviderBackendPort({
			backendFactory: fixture.backendFactory,
			mode: 'standalone-v1',
			toolPortalConfig: standaloneConfig,
		});
		const baseline = standaloneReadOptions();

		await Promise.all(
			[
				baseline,
				standaloneReadOptions(),
				standaloneReadOptions({ sessionId: 'standalone-session-b' }),
				standaloneReadOptions({ serviceGeneration: 'standalone-service-2' }),
				standaloneReadOptions({ credentialVersion: 2 }),
				standaloneReadOptions({
					profileAssignmentRevision: 'profile-assignment-agent-a-2',
				}),
			].map(
				async (options) =>
					await port.list(
						{ requests: [{ id: 'list', limit: 20, namespaces: ['github'] }] },
						options,
					),
			),
		);

		const sessionKeys = fixture.createdBackends.map((backend) =>
			Reflect.get(backend.options ?? {}, 'sessionKey'),
		);
		expect(sessionKeys[0]).toBe(sessionKeys[1]);
		expect(new Set(sessionKeys.slice(2))).toHaveLength(4);
		for (const sessionKey of sessionKeys) {
			expect(sessionKey).toEqual(
				expect.stringMatching(/^tool-portal:standalone-v1:mcp:[A-Za-z0-9_-]{43}$/u),
			);
		}
		for (const backend of fixture.createdBackends) {
			expect(backend.options).toMatchObject({
				portalAgentScopeSource: 'tool-portal-service',
			});
			expect(JSON.stringify(backend.options)).not.toMatch(/openclaw|hermes/u);
		}
	});

	it('forwards managed direct and approval-grant operation identities', async () => {
		const fixture = createBackendFactoryFixture();
		const port = createToolPortalMcpProviderBackendPort({
			backendFactory: fixture.backendFactory,
			mode: 'managed',
			toolPortalConfig: managedConfig,
		});
		const directOperationId = '40000000-0000-4000-8000-000000000004';
		const approvedOperationId = '60000000-0000-4000-8000-000000000006';
		const context = managedTrustedContext('agent-a');
		const request = {
			calls: [{ arguments: {}, id: 'call-a', name: 'get_issue', namespace: 'github' }],
		};

		await port.call(request, {
			dispatchAuthority: {
				backendKind: 'mcp_provider',
				fingerprint: `sha256:${'0'.repeat(64)}`,
				kind: 'without-approval',
				operationId: directOperationId,
			},
			surfaceClass: 'protected_uds',
			trustedContext: context,
		});
		await port.call(request, {
			dispatchAuthority: {
				backendKind: 'mcp_provider',
				grant: GatewayRuntimeMcpProviderDispatchGrantSchema.parse({
					approvalId: '10000000-0000-4000-8000-000000000001',
					authorityContext: {
						controllerEpoch: 'controller-1',
						frameworkEpoch: 'framework-1',
						gatewayEpoch: 'gateway-1',
						runtimeEpoch: 'runtime-1',
						zoneId: 'zone-a',
					},
					backendKind: 'mcp_provider',
					expiresAt: '2026-07-18T12:05:00.000Z',
					fingerprint: `sha256:${'1'.repeat(64)}`,
					grantId: '20000000-0000-4000-8000-000000000002',
					operationId: approvedOperationId,
					stablePrincipal: 'a'.repeat(64),
				}),
				kind: 'approval-grant',
			},
			surfaceClass: 'protected_uds',
			trustedContext: context,
		});

		expect(fixture.callOptions).toEqual([
			{ operationIdsByCallId: { 'call-a': directOperationId } },
			{ operationIdsByCallId: { 'call-a': approvedOperationId } },
		]);
	});

	it('forwards standalone direct and exact HMAC-batch operation identities', async () => {
		const fixture = createBackendFactoryFixture();
		const port = createToolPortalMcpProviderBackendPort({
			backendFactory: fixture.backendFactory,
			mode: 'standalone-v1',
			toolPortalConfig: standaloneConfig,
		});
		const directOperationId = '40000000-0000-4000-8000-000000000004';
		const approvedOperationId = '60000000-0000-4000-8000-000000000006';
		const readOptions = standaloneReadOptions();
		const request = {
			calls: [{ arguments: {}, id: 'call-a', name: 'get_issue', namespace: 'github' }],
		};

		await port.call(request, {
			...readOptions,
			dispatchAuthority: {
				backendKind: 'mcp_provider',
				fingerprint: `sha256:${'0'.repeat(64)}`,
				kind: 'without-approval',
				operationId: directOperationId,
			},
		});
		await port.call(request, {
			...readOptions,
			dispatchAuthority: {
				approval: {
					batchFingerprint: `sha256:${'2'.repeat(64)}`,
					kind: 'standalone-hmac-batch',
					operationIds: [approvedOperationId],
					serviceGeneration: 'standalone-service-1',
					tokenId: '30000000-0000-4000-8000-000000000003',
				},
				backendKind: 'mcp_provider',
				kind: 'standalone-hmac-batch',
				operationId: approvedOperationId,
			},
		} satisfies ToolPortalStandaloneMcpBackendInvocationOptions);

		expect(fixture.callOptions).toEqual([
			{ operationIdsByCallId: { 'call-a': directOperationId } },
			{ operationIdsByCallId: { 'call-a': approvedOperationId } },
		]);
	});

	it('rejects batches and mismatched standalone batch authority before provider selection', async () => {
		const fixture = createBackendFactoryFixture();
		const port = createToolPortalMcpProviderBackendPort({
			backendFactory: fixture.backendFactory,
			mode: 'standalone-v1',
			toolPortalConfig: standaloneConfig,
		});
		const operationId = '40000000-0000-4000-8000-000000000004';
		const readOptions = standaloneReadOptions();

		await expect(
			port.call(
				{
					calls: [
						{ arguments: {}, id: 'call-a', name: 'get_issue', namespace: 'github' },
						{ arguments: {}, id: 'call-b', name: 'get_issue', namespace: 'github' },
					],
				},
				{
					...readOptions,
					dispatchAuthority: {
						backendKind: 'mcp_provider',
						fingerprint: `sha256:${'0'.repeat(64)}`,
						kind: 'without-approval',
						operationId,
					},
				},
			),
		).rejects.toThrow('exactly one capability call');
		await expect(
			port.call(
				{
					calls: [{ arguments: {}, id: 'call-a', name: 'get_issue', namespace: 'github' }],
				},
				{
					...readOptions,
					dispatchAuthority: {
						approval: {
							batchFingerprint: `sha256:${'2'.repeat(64)}`,
							kind: 'standalone-hmac-batch',
							operationIds: ['60000000-0000-4000-8000-000000000006'],
							serviceGeneration: 'standalone-service-1',
							tokenId: '30000000-0000-4000-8000-000000000003',
						},
						backendKind: 'mcp_provider',
						kind: 'standalone-hmac-batch',
						operationId,
					},
				},
			),
		).rejects.toThrow('exact protected batch operation');
		expect(fixture.backendFactory.createBackend).not.toHaveBeenCalled();
	});

	it('fails before provider selection for unknown managed and standalone agents', async () => {
		const managedFixture = createBackendFactoryFixture();
		const managedPort = createToolPortalMcpProviderBackendPort({
			backendFactory: managedFixture.backendFactory,
			mode: 'managed',
			toolPortalConfig: managedConfig,
		});
		const managedContext = managedTrustedContext('agent-a');
		const standaloneFixture = createBackendFactoryFixture();
		const standalonePort = createToolPortalMcpProviderBackendPort({
			backendFactory: standaloneFixture.backendFactory,
			mode: 'standalone-v1',
			toolPortalConfig: standaloneConfig,
		});
		const standaloneOptions = standaloneReadOptions();

		await expect(
			managedPort.list(
				{ requests: [{ id: 'managed-unknown', limit: 20 }] },
				{
					surfaceClass: 'protected_uds',
					trustedContext: {
						...managedContext,
						principal: { ...managedContext.principal, agentId: 'unknown-agent' },
					},
				},
			),
		).rejects.toThrow('not configured');
		await expect(
			standalonePort.list(
				{ requests: [{ id: 'standalone-unknown', limit: 20 }] },
				{
					...standaloneOptions,
					origin: {
						...standaloneOptions.origin,
						authenticatedEnvelope: {
							...standaloneOptions.origin.authenticatedEnvelope,
							principal: {
								...standaloneOptions.origin.authenticatedEnvelope.principal,
								agentId: 'unknown-agent',
							},
						},
					},
				},
			),
		).rejects.toThrow('not configured');
		expect(managedFixture.backendFactory.createBackend).not.toHaveBeenCalled();
		expect(standaloneFixture.backendFactory.createBackend).not.toHaveBeenCalled();
	});
});
