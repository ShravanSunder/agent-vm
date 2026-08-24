import type {
	PortalBackendDescribeResult,
	PortalBackendListResult,
	PortalBackendSearchResult,
	PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import {
	mcpConfigSchema,
	type McpConfig,
	type StandaloneToolPortalConfig,
} from '@agent-vm/config-contracts';

import {
	createStandaloneToolPortalApprovalCoordinator,
	type StandaloneToolPortalApprovalBatchIntent,
} from './standalone-entrypoint/standalone-tool-portal-approval.js';
import {
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalAuthenticatedEnvelope,
} from './standalone-entrypoint/standalone-tool-portal-bearer-credentials.js';
import {
	createToolPortalService,
	type ToolPortalStandaloneMcpBackendPort,
	type ToolPortalStandaloneSemanticSnapshot,
} from './tool-portal-service.js';

export const standaloneServiceGeneration = 'standalone-service:1';
export const standaloneApprovalHmacKey = 'standalone-approval-test-key';
export const standaloneAuthenticatedEnvelope = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	principal: {
		agentId: 'agent-a',
		credentialVersion: 1,
		profileAssignmentRevision: 'profile-assignment:agent-a:7',
		toolPortalProfileId: 'code-builder',
	},
	serviceGeneration: standaloneServiceGeneration,
} satisfies StandaloneToolPortalAuthenticatedEnvelope;

export const standaloneToolPortalConfig = {
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

export const standaloneMcpConfig: McpConfig = mcpConfigSchema.parse({
	providers: {
		github: {
			discovery: { summary: 'GitHub repository tools.' },
			kind: 'mcp',
			namespace: 'github',
			transport: {
				kind: 'streamable-http',
				requiredEgressHosts: ['api.github.com'],
				url: 'https://api.github.com/mcp',
			},
		},
	},
	schemaVersion: 1,
});

export const standaloneBaseSemanticSnapshot = {
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
	namespaceDiscoveryByProfile: {
		'code-builder': [{ namespace: 'github', summary: 'GitHub repository tools.' }],
	},
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
					owningGeneration: standaloneBaseSemanticSnapshot.activeRevision,
					status: 'ok' as const,
					value: { backend: 'mcp-provider' },
				})),
				ok: true,
			};
		},
		describe: async (request): Promise<PortalBackendDescribeResult> => ({
			items: request.requests.map(({ id }) => ({
				id,
				status: 'ok',
				value: {
					tools: [
						{
							annotations: {},
							name: 'get_issue',
							namespace: 'github',
							related: [],
							toolRef: 'github:get_issue',
						},
					],
				},
			})),
			ok: true,
		}),
		list: async (request): Promise<PortalBackendListResult> => ({
			items: request.requests.map(({ id }) => ({
				id,
				status: 'ok',
				value: { namespaces: ['github'], tools: [] },
			})),
			ok: true,
		}),
		search: async (request): Promise<PortalBackendSearchResult> => ({
			items: request.requests.map(({ id }) => ({
				id,
				status: 'ok',
				value: {
					tools: [
						{
							description: 'Read one GitHub issue.',
							input: { optional: [], propertyCount: 0, required: [], type: 'object' },
							name: 'get_issue',
							namespace: 'github',
							safety: { readOnlyHint: true },
							toolRef: 'github:get_issue',
						},
					],
				},
			})),
			ok: true,
		}),
	} satisfies ToolPortalStandaloneMcpBackendPort;
	return { callInvocations, port };
}

export function createStandaloneToolPortalFixture(
	options: {
		readonly baseSemanticSnapshot?: ToolPortalStandaloneSemanticSnapshot;
		readonly config?: StandaloneToolPortalConfig;
		readonly mcpConfig?: McpConfig;
	} = {},
): {
	readonly approvalCoordinator: ReturnType<typeof createStandaloneToolPortalApprovalCoordinator>;
	readonly approvalIntents: StandaloneToolPortalApprovalBatchIntent[];
	readonly backend: ReturnType<typeof createStandaloneBackend>;
	readonly service: ReturnType<typeof createToolPortalService>;
} {
	const backend = createStandaloneBackend();
	const baseApprovalCoordinator = createStandaloneToolPortalApprovalCoordinator({
		credentials: [{ agentId: 'agent-a', hmacKey: standaloneApprovalHmacKey, keyVersion: 1 }],
		now: () => new Date('2026-07-18T12:00:00.000Z'),
		serviceGeneration: standaloneServiceGeneration,
	});
	const approvalIntents: StandaloneToolPortalApprovalBatchIntent[] = [];
	const approvalCoordinator = {
		...baseApprovalCoordinator,
		reserveDispatch: (intent: StandaloneToolPortalApprovalBatchIntent, approvalToken?: string) => {
			approvalIntents.push(intent);
			return baseApprovalCoordinator.reserveDispatch(intent, approvalToken);
		},
	};
	const service = createToolPortalService({
		approvalCoordinator,
		baseSemanticSnapshot: options.baseSemanticSnapshot ?? standaloneBaseSemanticSnapshot,
		backendPorts: { mcpProvider: backend.port },
		config: options.config ?? standaloneToolPortalConfig,
		mcpConfig: options.mcpConfig ?? standaloneMcpConfig,
	});
	return { approvalCoordinator, approvalIntents, backend, service };
}
