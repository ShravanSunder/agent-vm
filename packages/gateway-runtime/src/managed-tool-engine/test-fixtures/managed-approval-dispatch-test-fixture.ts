import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	type PortalCallResult,
	type PortalDescribeResult,
	type PortalListResult,
	type PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import {
	type GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeClientTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import type {
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import { type ControllerApprovalOperatorIdentity } from '@agent-vm/controller-test-support/approval/controller-approval-ledger.js';
import { type GatewayControlCallerContextSessionRef } from '@agent-vm/controller-test-support/control-session/gateway-control-caller-context.js';
import type { GatewayEpochIdentity } from '@agent-vm/controller-test-support/vm-ownership/vm-ownership-contracts.js';
import {
	deriveGatewayControlStablePrincipal,
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import { type GatewayRuntimePortalProjectionOperations } from '@agent-vm/gateway-runtime';
import type { ManagedToolEngineAdapter } from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-tool-engine-adapter.js';
import {
	type ToolPortalBackendCallOptions,
	type ToolPortalBackendPort,
} from '@agent-vm/tool-portal';

export const BASE_TIME_MS = Date.parse('2026-07-13T17:00:00.000Z');

export const acceptedSession = {
	bootId: 'framework-boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'controller-epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '22222222-2222-4222-8222-222222222222',
	zoneId: 'zone-a',
} satisfies GatewayControlCallerContextSessionRef;

export const gateway = {
	bootId: acceptedSession.bootId,
	controllerEpoch: acceptedSession.controllerEpoch,
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'runtime-generation-a',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayEpochIdentity;

export const authorityContext = {
	controllerEpoch: gateway.controllerEpoch,
	frameworkEpoch: acceptedSession.bootId,
	gatewayEpoch: gateway.gatewayEpochId,
	runtimeEpoch: gateway.generationId,
	zoneId: gateway.zoneId,
} as const;

export const semanticSnapshot = {
	activeRevision: 'semantic:12',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment:agent-a:7',
			toolPortalNamespaces: [{ namespace: 'github' }],
			toolPortalProfileId: 'code-builder',
		},
	},
	bindingRevision: 'binding:9',
	catalogRevision: 'catalog:12',
	desiredRevision: 'semantic:12',
	profilePolicyRevision: 'policy:7',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	providerRevision: 'provider:5',
	schemaRevision: 'schema:1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'code-builder': { github: ['protected_uds'] },
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

export const toolPortalConfig = {
	agents: { 'agent-a': { profile: 'code-builder' } },
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['create_issue'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

export const managedPrincipal = {
	agentId: 'agent-a',
	frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
	profileAssignmentRevision: 'profile-assignment:agent-a:7',
	toolPortalProfileId: 'code-builder',
} as const;

export const trustedInvocationContext = {
	correlation: {
		runId: 'approval-exactly-once-run',
		sessionId: 'approval-exactly-once-session',
		toolCallId: 'approval-exactly-once-tool-call',
	},
	principal: managedPrincipal,
	requester: { authenticatedSubjectId: 'hermes:agent-a' },
} satisfies GatewayRuntimeClientTrustedInvocationContext;

export const managedPluginAttachment = {
	attachmentGeneration: 1,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: [managedPrincipal.agentId],
	frameworkEpoch: authorityContext.frameworkEpoch,
	gatewayEpoch: authorityContext.gatewayEpoch,
	protocolVersion: 1,
	projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
	runtimeEpoch: authorityContext.runtimeEpoch,
	schemaVersion: 1,
} satisfies GatewayRuntimeAttachmentMetadata;

export const operatorIdentity = {
	approverId: 'operator-a',
	audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	provenance: 'managed-gateway',
	stablePrincipal: deriveGatewayControlStablePrincipal({ principal: managedPrincipal }),
} satisfies ControllerApprovalOperatorIdentity;

export const portalCallRequest = PortalCallRequestSchema.parse({
	calls: [
		{
			arguments: { issueTitle: 'Exactly once' },
			id: 'github-create-issue',
			name: 'create_issue',
			namespace: 'github',
		},
	],
	requestId: 'private-uds-approval-exactly-once',
});

export interface ApprovalControlTraceEntry {
	readonly operation: 'tool_portal_admission_reserve' | 'tool_portal_dispatch_arm';
	readonly requestedPrincipal: string;
	readonly resolvedPrincipal: string;
	readonly resultKind: string;
}

export interface RecordedMcpProviderInvocation {
	readonly options: ToolPortalBackendCallOptions<'mcp_provider'>;
	readonly request: typeof portalCallRequest;
}

export async function callToolPortal(client: GatewayRuntimeClient): Promise<PortalCallResult> {
	return await client.portal.call(portalCallRequest, { trustedContext: trustedInvocationContext });
}

export function createPrivateUdsPortalOperations(
	adapter: ManagedToolEngineAdapter,
): GatewayRuntimePortalProjectionOperations {
	return {
		call: async ({ publicRequest, trustedContext }) =>
			await adapter.call(publicRequest, { trustedContext, surfaceClass: 'protected_uds' }),
		describe: async () => {
			throw new Error('Discovery outside the approval proof');
		},
		list: async () => {
			throw new Error('Discovery outside the approval proof');
		},
		search: async () => {
			throw new Error('Discovery outside the approval proof');
		},
	};
}

export function createInboundEnvelope(props: {
	readonly messageId: string;
	readonly operation: ApprovalControlTraceEntry['operation'];
	readonly sequence: number;
}): ControlEnvelope {
	return {
		bootId: acceptedSession.bootId,
		connectionId: acceptedSession.connectionId,
		controllerEpoch: acceptedSession.controllerEpoch,
		createdAtMs: BASE_TIME_MS + props.sequence,
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation[props.operation],
		domain: 'gateway_control',
		expiresAtMs: BASE_TIME_MS + 60_000,
		kind: 'command',
		messageId: props.messageId,
		operation: props.operation,
		peerId: acceptedSession.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: props.sequence,
		sessionId: acceptedSession.sessionId,
		zoneId: acceptedSession.zoneId,
	};
}

export function unexpectedBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
	label: string,
): ToolPortalBackendPort<TBackendKind> {
	const unexpected = (): never => {
		throw new Error(`${label} backend must not be invoked by the MCP provider proof.`);
	};
	return {
		backendKind,
		call: async (): Promise<PortalCallResult> => unexpected(),
		describe: async (): Promise<PortalDescribeResult> => unexpected(),
		list: async (): Promise<PortalListResult> => unexpected(),
		search: async (): Promise<PortalSearchResult> => unexpected(),
	};
}

function unexpectedMcpProviderRead(): never {
	throw new Error('MCP provider discovery was not expected in the approval call proof.');
}

export function createRecordingMcpProviderBackend(
	invocations: RecordedMcpProviderInvocation[],
): ToolPortalBackendPort<'mcp_provider'> {
	return {
		backendKind: 'mcp_provider',
		call: async (request, options): Promise<PortalCallResult> => {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			if (options.dispatchAuthority.kind !== 'approval-grant') {
				throw new Error('MCP provider dispatch requires a controller-issued approval grant.');
			}
			const grant = options.dispatchAuthority.grant;
			invocations.push({ options, request: parsedRequest });
			return PortalCallResultSchema.parse({
				items: parsedRequest.calls.map((call) => ({
					id: call.id,
					operationId: grant.operationId,
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: semanticSnapshot.activeRevision,
					status: 'ok',
					value: { created: true },
				})),
				ok: true,
			});
		},
		describe: async (): Promise<PortalDescribeResult> => unexpectedMcpProviderRead(),
		list: async (): Promise<PortalListResult> => unexpectedMcpProviderRead(),
		search: async (): Promise<PortalSearchResult> => unexpectedMcpProviderRead(),
	};
}

export function singleResultItem(result: PortalCallResult): PortalCallResult['items'][number] {
	const item = result.items[0];
	if (item === undefined || result.items.length !== 1) {
		throw new Error('Expected exactly one Tool Portal call result item.');
	}
	return item;
}
