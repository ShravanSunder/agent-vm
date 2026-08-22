import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalBackendDescribeResult,
	type PortalBackendListResult,
	type PortalBackendSearchResult,
} from '@agent-vm/agent-portal-sdk';
import {
	type GatewayRuntimeManagedToolPortalConfig,
	type ManagedToolPortalConfig,
	type ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import {
	GatewayRuntimeApprovalAdmissionResultSchema,
	GatewayRuntimeApprovalArmDispatchResultSchema,
	GatewayRuntimeApprovalChallengeSchema,
	GatewayRuntimeApprovalDispatchGrantSchema,
	GatewayRuntimeApprovalDispatchReservationSchema,
	deriveGatewayControlStablePrincipal,
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	type GatewayRuntimeApprovalAdmissionResult,
	type GatewayRuntimeApprovalArmDispatchResult,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeApprovalDispatchGrant,
	type GatewayRuntimeApprovalDispatchReservation,
	type GatewayRuntimeGatewayDispatchReservation,
	type GatewayRuntimePortalSemanticSnapshot,
	type GatewayRuntimeToolPortalDispatchAuthority,
} from '@agent-vm/gateway-control-contracts';

import {
	createManagedToolPortalCapabilityCore,
	type ToolPortalApprovalPort,
	type ToolPortalBackendCallOptions,
	type ToolPortalBackendPort,
	type ToolPortalInvocationOptions,
	type ToolPortalManagedServiceInvocationOptions,
	type ToolPortalCapabilityCore,
	type ToolPortalTrustedInvocationContext,
} from './tool-portal-service.js';

const mixedBackendConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
		'agent-b': { profile: 'code-builder' },
	},
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				controller_execution: {
					discovery: { summary: 'Controller-operated repository actions.' },
					backend: {
						kind: 'controller_execution',
						operations: {
							controller_host_probe: { kind: 'registered_action' },
							workspace_git_push: { kind: 'registered_action' },
						},
					},
					calls: {
						requiresApproval: { allow: ['controller_host_probe'], deny: [] },
						withoutApproval: { allow: ['workspace_git_push'], deny: [] },
					},
					tools: { allow: ['controller_host_probe', 'workspace_git_push'], deny: [] },
				},
				github: {
					discovery: { summary: 'GitHub repository tools.' },
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: {
							allow: ['create_issue', 'update_issue'],
							deny: [],
						},
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: {
						allow: ['create_issue', 'get_issue', 'update_issue'],
						deny: [],
					},
				},
				sandbox: {
					discovery: { summary: 'Leased Tool VM operations.' },
					backend: {
						kind: 'tool_vm_runner',
						operations: {
							exec: {
								description: 'Execute an inert test command.',
								executable: '/usr/bin/true',
								kind: 'command.fixed',
								mandatoryArgvPrefix: [],
								workingDirectory: '.',
							},
							exec_denied: {
								description: 'Execute an inert denied test command.',
								executable: '/usr/bin/true',
								kind: 'command.fixed',
								mandatoryArgvPrefix: [],
								workingDirectory: '.',
							},
						},
						profile: 'sandbox_ssh',
					},
					calls: {
						requiresApproval: { allow: '*', deny: ['exec', 'exec_denied'] },
						withoutApproval: { allow: ['exec'], deny: [] },
					},
					tools: { allow: '*', deny: ['exec_denied'] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

const semanticSnapshot = {
	activeRevision: 'semantic:12',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-assignment:agent-a:7',
			toolPortalNamespaces: [
				{ namespace: 'controller_execution', summary: 'Controller-operated repository actions.' },
				{ namespace: 'github', summary: 'GitHub repository tools.' },
				{ namespace: 'sandbox' },
			],
			toolPortalProfileId: 'code-builder',
		},
		'agent-b': {
			agentId: 'agent-b',
			frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-assignment:agent-b:4',
			toolPortalNamespaces: [
				{ namespace: 'controller_execution', summary: 'Controller-operated repository actions.' },
				{ namespace: 'github', summary: 'GitHub repository tools.' },
				{ namespace: 'sandbox' },
			],
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
		'code-builder': {
			controller_execution: ['protected_uds'],
			github: ['mcp', 'protected_uds'],
			sandbox: ['protected_uds'],
		},
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

const agentATrustedContext = {
	correlation: {
		runId: 'run-a',
		sessionId: 'session-a',
		toolCallId: 'tool-call-a',
	},
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-assignment:agent-a:7',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} satisfies ToolPortalTrustedInvocationContext;

const agentBTrustedContext = {
	principal: {
		agentId: 'agent-b',
		frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-assignment:agent-b:4',
		toolPortalProfileId: 'code-builder',
	},
} satisfies ToolPortalTrustedInvocationContext;

const AUTHORITY_CONTEXT = {
	controllerEpoch: 'controller:7',
	frameworkEpoch: 'framework:7',
	gatewayEpoch: 'gateway:7',
	runtimeEpoch: 'runtime:7',
	zoneId: 'zone-a',
} as const;

const RESERVATION_ID = '20000000-0000-4000-8000-000000000002';
const GRANT_ID = '30000000-0000-4000-8000-000000000003';
const APPROVAL_EXPIRES_AT = '2026-07-13T18:00:00.000Z';
const STABLE_PRINCIPAL = deriveGatewayControlStablePrincipal({
	principal: agentATrustedContext.principal,
});

type RecordedBackendInvocation =
	| {
			readonly operation: 'call';
			readonly options: ToolPortalInvocationOptions & {
				readonly dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthority;
			};
			readonly request: PortalCallRequest;
	  }
	| {
			readonly operation: 'describe' | 'list' | 'search';
			readonly options: ToolPortalInvocationOptions;
			readonly request: unknown;
	  };

interface RecordingBackendPort<TBackendKind extends ToolPortalBackendKind> {
	readonly invocations: RecordedBackendInvocation[];
	readonly port: ToolPortalBackendPort<TBackendKind>;
}

function operationIdFromDispatchAuthority(
	authority: GatewayRuntimeToolPortalDispatchAuthority,
): string {
	switch (authority.kind) {
		case 'without-approval':
			return authority.operationId;
		case 'approval-grant':
			return authority.grant.operationId;
		case 'controller-approval-reservation':
			return authority.reservation.operationId;
		default:
			throw new Error(`Unsupported dispatch authority: ${String(authority)}`);
	}
}

function createRecordingBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
	namespace: string,
	props?: {
		readonly onCall?: (props: {
			readonly options: ToolPortalBackendCallOptions<TBackendKind>;
			readonly request: PortalCallRequest;
		}) => void;
	},
): RecordingBackendPort<TBackendKind> {
	const invocations: RecordedBackendInvocation[] = [];
	return {
		invocations,
		port: {
			backendKind,
			call: (request, options): Promise<PortalCallResult> => {
				const parsedRequest = PortalCallRequestSchema.parse(request);
				invocations.push({ operation: 'call', options, request: parsedRequest });
				props?.onCall?.({ options, request: parsedRequest });
				return Promise.resolve({
					items: parsedRequest.calls.map((call) => ({
						id: call.id,
						operationId: operationIdFromDispatchAuthority(options.dispatchAuthority),
						outcome: {
							certainty: 'proven' as const,
							completion: 'succeeded' as const,
							kind: 'completed' as const,
							retryClass: 'forbidden' as const,
						},
						owningGeneration: 'gateway-epoch-7',
						status: 'ok' as const,
						value: { backendNamespace: namespace },
					})),
					ok: true,
				});
			},
			describe: (request, options): Promise<PortalBackendDescribeResult> => {
				invocations.push({ operation: 'describe', options, request });
				const parsedRequest = PortalDescribeRequestSchema.parse(request);
				return Promise.resolve({
					items: parsedRequest.requests.map((item) => ({
						id: item.id,
						status: 'ok' as const,
						value: { tools: [] },
					})),
					ok: true,
				});
			},
			list: (request, options): Promise<PortalBackendListResult> => {
				invocations.push({ operation: 'list', options, request });
				const parsedRequest = PortalListRequestSchema.parse(request);
				return Promise.resolve({
					items: parsedRequest.requests.map((item) => ({
						id: item.id,
						status: 'ok' as const,
						value: { namespaces: [namespace], tools: [] },
					})),
					ok: true,
				});
			},
			search: (request, options): Promise<PortalBackendSearchResult> => {
				invocations.push({ operation: 'search', options, request });
				const parsedRequest = PortalSearchRequestSchema.parse(request);
				return Promise.resolve({
					items: parsedRequest.requests.map((item) => ({
						id: item.id,
						status: 'ok' as const,
						value: { tools: [] },
					})),
					ok: true,
				});
			},
		},
	};
}

interface RecordingApprovalPort {
	readonly armInvocations: GatewayRuntimeGatewayDispatchReservation[];
	readonly port: ToolPortalApprovalPort;
	readonly reserveInvocations: GatewayRuntimeApprovalChallengeIntent[];
}

function createApprovalChallenge(
	intent: GatewayRuntimeApprovalChallengeIntent,
): GatewayRuntimeApprovalAdmissionResult {
	const fingerprint = deriveGatewayRuntimeApprovalFingerprint({
		authorityContext: AUTHORITY_CONTEXT,
		intent,
	});
	return GatewayRuntimeApprovalAdmissionResultSchema.parse({
		challenge: GatewayRuntimeApprovalChallengeSchema.parse({
			approvalId: deriveGatewayRuntimeApprovalId(fingerprint),
			createdAt: '2026-07-13T17:00:00.000Z',
			expiresAt: APPROVAL_EXPIRES_AT,
			fingerprint,
			intent,
		}),
		kind: 'approval-required',
	});
}

function createApprovalReservation(
	intent: GatewayRuntimeApprovalChallengeIntent,
	backendKind: GatewayRuntimeApprovalChallengeIntent['backendKind'] = intent.backendKind,
): GatewayRuntimeApprovalDispatchReservation {
	const fingerprint = deriveGatewayRuntimeApprovalFingerprint({
		authorityContext: AUTHORITY_CONTEXT,
		intent,
	});
	return GatewayRuntimeApprovalDispatchReservationSchema.parse({
		approvalId: deriveGatewayRuntimeApprovalId(fingerprint),
		authorityContext: AUTHORITY_CONTEXT,
		backendKind,
		...(backendKind === 'controller_execution'
			? { bindingRevision: intent.semanticRevisions.bindingRevision }
			: {}),
		expiresAt: APPROVAL_EXPIRES_AT,
		fingerprint,
		operationId: intent.operationId,
		reservationId: RESERVATION_ID,
		stablePrincipal: STABLE_PRINCIPAL,
	});
}

function createApprovalGrant(
	reservation: GatewayRuntimeGatewayDispatchReservation,
	backendKind: GatewayRuntimeApprovalDispatchGrant['backendKind'] = reservation.backendKind,
): GatewayRuntimeApprovalDispatchGrant {
	return GatewayRuntimeApprovalDispatchGrantSchema.parse({
		approvalId: reservation.approvalId,
		authorityContext: reservation.authorityContext,
		backendKind,
		expiresAt: reservation.expiresAt,
		fingerprint: reservation.fingerprint,
		grantId: GRANT_ID,
		operationId: reservation.operationId,
		stablePrincipal: reservation.stablePrincipal,
	});
}

function createDispatchReservedResult(
	intent: GatewayRuntimeApprovalChallengeIntent,
): GatewayRuntimeApprovalAdmissionResult {
	return GatewayRuntimeApprovalAdmissionResultSchema.parse({
		kind: 'dispatch-reserved',
		reservation: createApprovalReservation(intent),
	});
}

function createNotDispatchedAdmissionResult(props: {
	readonly intent: GatewayRuntimeApprovalChallengeIntent;
	readonly reason: 'consumed-without-dispatch' | 'denied' | 'expired' | 'revoked';
}): GatewayRuntimeApprovalAdmissionResult {
	return GatewayRuntimeApprovalAdmissionResultSchema.parse({
		kind: 'not-dispatched',
		operationId: props.intent.operationId,
		reason: props.reason,
	});
}

function createAmbiguousAdmissionResult(
	intent: GatewayRuntimeApprovalChallengeIntent,
): GatewayRuntimeApprovalAdmissionResult {
	return GatewayRuntimeApprovalAdmissionResultSchema.parse({
		kind: 'ambiguous',
		operationId: intent.operationId,
		reason: 'dispatch-armed',
	});
}

function createRecordingApprovalPort(props?: {
	readonly armResult?: (
		reservation: GatewayRuntimeGatewayDispatchReservation,
	) => GatewayRuntimeApprovalArmDispatchResult;
	readonly reserveResult?: (
		intent: GatewayRuntimeApprovalChallengeIntent,
	) => GatewayRuntimeApprovalAdmissionResult;
	readonly onArm?: (reservation: GatewayRuntimeGatewayDispatchReservation) => void;
	readonly onReserve?: (intent: GatewayRuntimeApprovalChallengeIntent) => void;
}): RecordingApprovalPort {
	const armInvocations: GatewayRuntimeGatewayDispatchReservation[] = [];
	const reserveInvocations: GatewayRuntimeApprovalChallengeIntent[] = [];
	return {
		armInvocations,
		port: {
			armDispatch: ({ reservation }) => {
				armInvocations.push(reservation);
				props?.onArm?.(reservation);
				return Promise.resolve(
					GatewayRuntimeApprovalArmDispatchResultSchema.parse(
						props?.armResult?.(reservation) ?? {
							grant: createApprovalGrant(reservation),
							kind: 'dispatch-armed',
						},
					),
				);
			},
			reserveDispatch: ({ intent }) => {
				reserveInvocations.push(intent);
				props?.onReserve?.(intent);
				return Promise.resolve(
					GatewayRuntimeApprovalAdmissionResultSchema.parse(
						props?.reserveResult?.(intent) ?? createApprovalChallenge(intent),
					),
				);
			},
		},
		reserveInvocations,
	};
}

function createServiceFixture(props?: {
	readonly approval?: RecordingApprovalPort;
	readonly config?: GatewayRuntimeManagedToolPortalConfig | ManagedToolPortalConfig;
	readonly controllerExecution?: RecordingBackendPort<'controller_execution'>;
	readonly mcpProvider?: RecordingBackendPort<'mcp_provider'>;
	readonly semanticSnapshot?: GatewayRuntimePortalSemanticSnapshot;
	readonly toolVmRunner?: RecordingBackendPort<'tool_vm_runner'>;
}): {
	readonly approval: RecordingApprovalPort;
	readonly controllerExecution: RecordingBackendPort<'controller_execution'>;
	readonly mcpProvider: RecordingBackendPort<'mcp_provider'>;
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
	readonly toolVmRunner: RecordingBackendPort<'tool_vm_runner'>;
} {
	const approval = props?.approval ?? createRecordingApprovalPort();
	const controllerExecution =
		props?.controllerExecution ??
		createRecordingBackendPort('controller_execution', 'controller_execution');
	const mcpProvider = props?.mcpProvider ?? createRecordingBackendPort('mcp_provider', 'github');
	const toolVmRunner =
		props?.toolVmRunner ?? createRecordingBackendPort('tool_vm_runner', 'sandbox');
	const capabilityCore = createManagedToolPortalCapabilityCore({
		approvalPort: approval.port,
		backendPorts: {
			controllerExecution: controllerExecution.port,
			mcpProvider: mcpProvider.port,
			toolVmRunner: toolVmRunner.port,
		},
		config: props?.config ?? mixedBackendConfig,
		semanticSnapshot: props?.semanticSnapshot ?? semanticSnapshot,
	});
	return { approval, capabilityCore, controllerExecution, mcpProvider, toolVmRunner };
}

function udsOptions(
	trustedContext: ToolPortalTrustedInvocationContext = agentATrustedContext,
): ToolPortalManagedServiceInvocationOptions {
	return { origin: { kind: 'managed', trustedContext }, surfaceClass: 'protected_uds' };
}

function totalBackendInvocations(fixture: ReturnType<typeof createServiceFixture>): number {
	return (
		fixture.controllerExecution.invocations.length +
		fixture.mcpProvider.invocations.length +
		fixture.toolVmRunner.invocations.length
	);
}

export {
	AUTHORITY_CONTEXT,
	STABLE_PRINCIPAL,
	type RecordedBackendInvocation,
	type RecordingBackendPort,
	type ToolPortalInvocationOptions,
	type ToolPortalManagedServiceInvocationOptions,
	type ToolPortalTrustedInvocationContext,
	agentATrustedContext,
	agentBTrustedContext,
	createAmbiguousAdmissionResult,
	createApprovalChallenge,
	createApprovalGrant,
	createApprovalReservation,
	createDispatchReservedResult,
	createNotDispatchedAdmissionResult,
	createRecordingApprovalPort,
	createRecordingBackendPort,
	createServiceFixture,
	mixedBackendConfig,
	semanticSnapshot,
	totalBackendInvocations,
	udsOptions,
};
