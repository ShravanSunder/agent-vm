import type {
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	StandaloneToolPortalConfig,
	ToolPortalBackendBinding,
} from '@agent-vm/config-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createStandaloneToolPortalApprovalCoordinator,
	createStandaloneToolPortalApprovalToken,
	type StandaloneToolPortalApprovalBatchIntent,
} from './standalone-entrypoint/standalone-tool-portal-approval.js';
import {
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalAuthenticatedEnvelope,
} from './standalone-entrypoint/standalone-tool-portal-bearer-credentials.js';
import { createStandaloneToolPortalProjectionService } from './standalone-entrypoint/standalone-tool-portal-mcp-projection.js';
import { agentATrustedContext, createServiceFixture } from './tool-portal-service-test-fixture.js';
import {
	createToolPortalService,
	type ToolPortalStandaloneMcpBackendPort,
	type ToolPortalStandaloneSemanticSnapshot,
} from './tool-portal-service.js';

const serviceGeneration = 'standalone-service:1';
const approvalHmacKey = 'standalone-approval-test-key';
const authenticatedEnvelope = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	principal: {
		agentId: 'agent-a',
		credentialVersion: 1,
		profileAssignmentRevision: 'profile-assignment:agent-a:7',
		toolPortalProfileId: 'code-builder',
	},
	serviceGeneration,
} satisfies StandaloneToolPortalAuthenticatedEnvelope;

const standaloneConfig = {
	agents: { 'agent-a': { profile: 'code-builder' } },
	authentication: {
		agents: {
			'agent-a': {
				approvalHmacKey: { name: 'TOOL_PORTAL_APPROVAL_KEY', source: 'environment' },
				bearerKey: { name: 'TOOL_PORTAL_BEARER_KEY', source: 'environment' },
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
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['create_issue', 'get_issue'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies StandaloneToolPortalConfig;

const standaloneSemanticSnapshot = {
	activeRevision: 'semantic:12',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			credentialVersion: 1,
			profileAssignmentRevision: 'profile-assignment:agent-a:7',
			toolPortalProfileId: 'code-builder',
		},
	},
	bindingRevision: 'binding:9',
	catalogRevision: 'catalog:12',
	desiredRevision: 'semantic:12',
	profilePolicyRevision: 'policy:7',
	providerRevision: 'provider:5',
	schemaRevision: 'schema:1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'code-builder': { github: ['http', 'mcp'] },
	},
} satisfies ToolPortalStandaloneSemanticSnapshot;

function operationIdFromStandaloneAuthority(
	authority: Parameters<ToolPortalStandaloneMcpBackendPort['call']>[1]['dispatchAuthority'],
): string {
	return authority.operationId;
}

function createStandaloneBackend(): {
	readonly callInvocations: Parameters<ToolPortalStandaloneMcpBackendPort['call']>[];
	readonly port: ToolPortalStandaloneMcpBackendPort;
} {
	const callInvocations: Parameters<ToolPortalStandaloneMcpBackendPort['call']>[] = [];
	const port = {
		backendKind: 'mcp_provider',
		call: async (request, options): Promise<PortalCallResult> => {
			callInvocations.push([request, options]);
			return {
				items: request.calls.map((call) => ({
					id: call.id,
					operationId: operationIdFromStandaloneAuthority(options.dispatchAuthority),
					outcome: {
						certainty: 'proven' as const,
						completion: 'succeeded' as const,
						kind: 'completed' as const,
						retryClass: 'forbidden' as const,
					},
					owningGeneration: standaloneSemanticSnapshot.activeRevision,
					status: 'ok' as const,
					value: { backend: 'mcp-provider' },
				})),
				ok: true,
			};
		},
		describe: async (request): Promise<PortalDescribeResult> => ({
			items: request.requests.map(({ id }) => ({ id, status: 'ok', value: { tools: [] } })),
			ok: true,
		}),
		list: async (request): Promise<PortalListResult> => ({
			items: request.requests.map(({ id }) => ({
				id,
				status: 'ok',
				value: { namespaces: ['github'], tools: [] },
			})),
			ok: true,
		}),
		search: async (request): Promise<PortalSearchResult> => ({
			items: request.requests.map(({ id }) => ({ id, status: 'ok', value: { tools: [] } })),
			ok: true,
		}),
	} satisfies ToolPortalStandaloneMcpBackendPort;
	return { callInvocations, port };
}

function createStandaloneFixture(): {
	readonly approvalCoordinator: ReturnType<typeof createStandaloneToolPortalApprovalCoordinator>;
	readonly backend: ReturnType<typeof createStandaloneBackend>;
	readonly service: ReturnType<typeof createToolPortalService>;
} {
	const backend = createStandaloneBackend();
	const approvalCoordinator = createStandaloneToolPortalApprovalCoordinator({
		credentials: [{ agentId: 'agent-a', hmacKey: approvalHmacKey, keyVersion: 1 }],
		now: () => new Date('2026-07-18T12:00:00.000Z'),
		serviceGeneration,
	});
	const service = createToolPortalService({
		approvalCoordinator,
		backendPorts: { mcpProvider: backend.port },
		config: standaloneConfig,
		semanticSnapshot: standaloneSemanticSnapshot,
	});
	return { approvalCoordinator, backend, service };
}

describe('standalone-v1 ToolPortalService seam', () => {
	it('owns one precisely named subordinate capability core', () => {
		const { service } = createStandaloneFixture();

		expect(service.mode).toBe('standalone-v1');
		expect(Object.keys(service).toSorted()).toEqual(['capabilityCore', 'mode']);
		expect(service.capabilityCore.semanticSnapshot).toEqual(standaloneSemanticSnapshot);
	});

	it('keeps standalone identity distinct from managed framework identity', async () => {
		const { service } = createStandaloneFixture();
		const standaloneOptions = {
			correlation: { sessionId: 'standalone-session' },
			origin: { authenticatedEnvelope, kind: 'standalone' as const },
			surfaceClass: 'mcp' as const,
		};
		const forgedStandaloneOrigin = {
			...standaloneOptions,
			origin: {
				...standaloneOptions.origin,
				frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
			},
		};

		await expect(
			service.capabilityCore.list(
				{ requests: [{ id: 'list', limit: 20 }] },
				forgedStandaloneOrigin,
			),
		).rejects.toThrow();
		expect(standaloneOptions.origin).not.toHaveProperty('frameworkIdentity');
	});

	it('reserves and arms one exact ordered HMAC batch before protected dispatch', async () => {
		const fixture = createStandaloneFixture();
		const projection = createStandaloneToolPortalProjectionService(fixture.service);
		const request = {
			calls: [
				{ arguments: { title: 'first' }, id: 'call-a', name: 'create_issue', namespace: 'github' },
				{ arguments: { title: 'second' }, id: 'call-b', name: 'create_issue', namespace: 'github' },
			],
		} satisfies PortalCallRequest;
		const invocationOptions = {
			authenticatedEnvelope,
			correlation: { sessionId: 'standalone-session' },
			surfaceClass: 'mcp' as const,
		};
		const challenge = await projection.call(request, invocationOptions);
		const protectedCalls = request.calls.map((call, index) => {
			const operationId = challenge.items[index]?.operationId;
			if (operationId === undefined) throw new Error('Expected deterministic operation id.');
			return { call, operationId };
		});
		const intent = {
			authenticatedEnvelope,
			protectedCalls,
			semanticRevisions: {
				activeRevision: standaloneSemanticSnapshot.activeRevision,
				bindingRevision: standaloneSemanticSnapshot.bindingRevision,
				catalogRevision: standaloneSemanticSnapshot.catalogRevision,
				profilePolicyRevision: standaloneSemanticSnapshot.profilePolicyRevision,
				providerRevision: standaloneSemanticSnapshot.providerRevision,
				schemaRevision: standaloneSemanticSnapshot.schemaRevision,
			},
			surfaceClass: 'mcp',
		} satisfies StandaloneToolPortalApprovalBatchIntent;
		const approvalToken = createStandaloneToolPortalApprovalToken({
			expiresAt: '2026-07-18T12:01:00.000Z',
			hmacKey: approvalHmacKey,
			intent,
			keyVersion: 1,
			tokenId: '10000000-0000-4000-8000-000000000001',
		});

		const result = await projection.call(request, { ...invocationOptions, approvalToken });

		expect(result.ok).toBe(true);
		expect(fixture.backend.callInvocations).toHaveLength(2);
		for (const [publicRequest, options] of fixture.backend.callInvocations) {
			expect(publicRequest).not.toHaveProperty('approvalToken');
			expect(options).not.toHaveProperty('approvalToken');
			expect(options.origin.kind).toBe('standalone');
			expect(options.origin).not.toHaveProperty('frameworkIdentity');
			expect(options.dispatchAuthority).toMatchObject({
				approval: {
					kind: 'standalone-hmac-batch',
					operationIds: protectedCalls.map(({ operationId }) => operationId),
				},
				kind: 'standalone-hmac-batch',
			});
		}
	});

	it('returns matched MCP-provider visibility through managed and standalone adapters', async () => {
		const managed = createServiceFixture();
		const standalone = createStandaloneFixture();
		const request = { requests: [{ id: 'list', limit: 20 }] } satisfies PortalListRequest;

		const [managedResult, standaloneResult] = await Promise.all([
			managed.capabilityCore.list(request, {
				origin: { kind: 'managed', trustedContext: agentATrustedContext },
				surfaceClass: 'mcp',
			}),
			createStandaloneToolPortalProjectionService(standalone.service).list(request, {
				authenticatedEnvelope,
				correlation: { sessionId: 'standalone-session' },
				surfaceClass: 'mcp',
			}),
		]);

		expect(standaloneResult).toEqual(managedResult);
	});

	it('admits no privileged backend ports in standalone construction', () => {
		const fixture = createStandaloneFixture();
		const createInvalidStandaloneService = (): void => {
			createToolPortalService({
				approvalCoordinator: fixture.approvalCoordinator,
				backendPorts: {
					// @ts-expect-error Standalone version 1 accepts only the MCP-provider port.
					controllerHostAction: vi.fn(),
					mcpProvider: fixture.backend.port,
				},
				config: standaloneConfig,
				semanticSnapshot: standaloneSemanticSnapshot,
			});
		};

		expect(createInvalidStandaloneService).toBeTypeOf('function');
	});

	it.each(['controller_host_action', 'tool_vm_runner'] as const)(
		'rejects the privileged %s backend during standalone service startup',
		(backendKind) => {
			const fixture = createStandaloneFixture();
			const privilegedBackend: ToolPortalBackendBinding =
				backendKind === 'controller_host_action'
					? { kind: backendKind }
					: {
							kind: backendKind,
							operations: {
								read_file: {
									description: 'Read one bounded file.',
									kind: 'filesystem.read',
								},
							},
							profile: 'sandbox_ssh',
						};

			expect(() =>
				createToolPortalService({
					approvalCoordinator: fixture.approvalCoordinator,
					backendPorts: { mcpProvider: fixture.backend.port },
					config: {
						...standaloneConfig,
						profiles: {
							'code-builder': {
								namespaces: {
									privileged: {
										backend: privilegedBackend,
										calls: {
											requiresApproval: { allow: [], deny: [] },
											withoutApproval: { allow: '*', deny: [] },
										},
										tools: { allow: '*', deny: [] },
									},
								},
							},
						},
					},
					semanticSnapshot: standaloneSemanticSnapshot,
				}),
			).toThrow('Standalone Tool Portal version 1 does not admit the privileged');
		},
	);
});
