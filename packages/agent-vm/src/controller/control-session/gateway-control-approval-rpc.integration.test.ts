import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	type GatewayControlRpcMessage,
	type GatewayControlRpcOperation,
	GatewayControlRpcCommandResultMessageSchema,
	type GatewayRuntimeApprovalAuthorityContext,
	type GatewayRuntimeApprovalChallenge,
	type GatewayRuntimeApprovalChallengeIntent,
	deriveGatewayControlStablePrincipal,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createControllerApprovalLedger,
	type ControllerApprovalLedger,
	type ControllerApprovalOperatorIdentity,
} from '../approval/controller-approval-ledger.js';
import type { ControllerApprovalRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { createControlSessionDispatcher } from './control-session-dispatcher.js';
import {
	createGatewayControlCallerContextRegistry,
	type GatewayControlCallerContextSessionRef,
	type GatewayControlCallerContextRegistry,
	type GatewayControlTrustedCallerContext,
} from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	type GatewayControlApprovalLedgerOperations,
	type GatewayControlControllerExecutionOperations,
} from './gateway-control-domain-handler.js';

const BASE_TIME_MS = Date.parse('2026-07-13T12:00:00.000Z');
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const CONTROLLER_HOST_ACTION_OPERATION_ID = '66666666-6666-4666-8666-666666666666';
const APPROVAL_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_FINGERPRINT = `sha256:${'a'.repeat(64)}`;

const acceptedSession = {
	bootId: 'framework-boot-a',
	connectionId: '33333333-3333-4333-8333-333333333333',
	controllerEpoch: 'controller-epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '44444444-4444-4444-8444-444444444444',
	zoneId: 'zone-a',
} satisfies GatewayControlCallerContextSessionRef;

const gateway = {
	bootId: acceptedSession.bootId,
	controllerEpoch: acceptedSession.controllerEpoch,
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'runtime-generation-a',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayEpochIdentity;

const authorityContext = {
	controllerEpoch: gateway.controllerEpoch,
	frameworkEpoch: acceptedSession.bootId,
	gatewayEpoch: gateway.gatewayEpochId,
	runtimeEpoch: gateway.generationId,
	zoneId: gateway.zoneId,
} satisfies GatewayRuntimeApprovalAuthorityContext;

const approvalIntent = {
	backendKind: 'mcp_provider',
	call: {
		arguments: { issueTitle: 'Require operator approval' },
		id: 'github.create_issue',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: OPERATION_ID,
	semanticRevisions: {
		activeRevision: 'active-1',
		bindingRevision: 'binding-1',
		catalogRevision: 'catalog-1',
		profilePolicyRevision: 'policy-1',
		providerRevision: 'provider-1',
		schemaRevision: 'schema-1',
	},
	surfaceClass: 'mcp',
	trustedContext: {
		correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
		principal: {
			agentId: 'agent-a',
			frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
			profileAssignmentRevision: 'assignment-1',
			toolPortalProfileId: 'profile-a',
		},
		requester: { authenticatedSubjectId: 'subject-a' },
	},
} satisfies GatewayRuntimeApprovalChallengeIntent;

const controllerExecutionIntent = {
	...approvalIntent,
	backendKind: 'controller_execution',
	call: {
		arguments: {},
		id: 'controller_execution.controller_host_probe',
		name: 'controller_host_probe',
		namespace: 'controller_execution',
	},
	operationId: CONTROLLER_HOST_ACTION_OPERATION_ID,
} satisfies GatewayRuntimeApprovalChallengeIntent;

const approvalChallenge = {
	approvalId: APPROVAL_ID,
	createdAt: '2026-07-13T12:00:00.000Z',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT,
	intent: approvalIntent,
} satisfies GatewayRuntimeApprovalChallenge;

const operatorIdentity = {
	approverId: 'operator-a',
	audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
	provenance: 'managed-gateway',
	stablePrincipal: deriveGatewayControlStablePrincipal({
		principal: approvalIntent.trustedContext.principal,
	}),
} satisfies ControllerApprovalOperatorIdentity;

type GatewayControlCommandResultMessage = Extract<
	GatewayControlRpcMessage,
	{ readonly kind: 'command_result' }
>;

const temporaryDirectories: string[] = [];

function createEnvelope(props: {
	readonly operation: Extract<
		GatewayControlRpcOperation,
		| 'tool_portal_admission_reserve'
		| 'tool_portal_approval_decide'
		| 'tool_portal_controller_execution'
		| 'tool_portal_dispatch_arm'
	>;
	readonly sequence: number;
	readonly session?: GatewayControlCallerContextSessionRef;
}): ControlEnvelope {
	const session = props.session ?? acceptedSession;
	return {
		bootId: session.bootId,
		connectionId: session.connectionId,
		controllerEpoch: session.controllerEpoch,
		createdAtMs: BASE_TIME_MS + props.sequence,
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation[props.operation],
		domain: 'gateway_control',
		expiresAtMs: BASE_TIME_MS + 60_000,
		kind: 'command',
		messageId: `55555555-5555-4555-8555-${String(props.sequence).padStart(12, '0')}`,
		operation: props.operation,
		peerId: session.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: props.sequence,
		sessionId: session.sessionId,
		zoneId: session.zoneId,
	};
}

function createStaticCallerContextRegistry(
	callerContexts: readonly GatewayControlTrustedCallerContext[],
): GatewayControlCallerContextRegistry {
	const contextById = new Map(
		callerContexts.map((callerContext) => [callerContext.callerContextId, callerContext]),
	);
	return {
		register: () => {
			throw new Error('Static integration registry does not register new caller contexts.');
		},
		release: (callerContextId) => {
			contextById.delete(callerContextId);
		},
		resolve: (callerContextId) => contextById.get(callerContextId),
		resolveForSession: ({ callerContextId, session }) => {
			const callerContext = contextById.get(callerContextId);
			if (callerContext === undefined) return { status: 'absent' };
			return callerContext.bootId === session.bootId &&
				callerContext.connectionId === session.connectionId &&
				callerContext.controllerEpoch === session.controllerEpoch &&
				callerContext.peerId === session.peerId &&
				callerContext.sessionId === session.sessionId &&
				callerContext.zoneId === session.zoneId
				? { callerContext, status: 'ok' }
				: { status: 'session_mismatch' };
		},
		validateRegistrationForSession: () => {
			throw new Error('Static integration registry does not validate registrations.');
		},
	};
}

function createApprovalDispatcher(
	props: {
		readonly approvalLedger?: GatewayControlApprovalLedgerOperations;
		readonly callerContexts?: GatewayControlCallerContextRegistry;
		readonly controllerExecutions?: GatewayControlControllerExecutionOperations;
		readonly gateway?: GatewayEpochIdentity;
		readonly managedApprovalAuthority?: { readonly approverId: string };
		readonly session?: GatewayControlCallerContextSessionRef;
	} = {},
): ReturnType<typeof createControlSessionDispatcher> {
	const session = props.session ?? acceptedSession;
	const dispatcher = createControlSessionDispatcher({
		sessionFence: {
			bootId: session.bootId,
			connectionId: session.connectionId,
			controllerEpoch: session.controllerEpoch,
			domain: 'gateway_control',
			peerId: session.peerId,
			sessionId: session.sessionId,
			zoneId: session.zoneId,
		},
	});
	dispatcher.register(
		'gateway_control',
		createGatewayControlDomainHandler({
			...(props.approvalLedger === undefined ? {} : { approvalLedger: props.approvalLedger }),
			callerContexts:
				props.callerContexts ??
				createGatewayControlCallerContextRegistry({
					agentAuthorityKeys: {},
					callerContextProofKey: 'approval-rpc-test-caller-context-proof-key',
				}),
			...(props.controllerExecutions === undefined
				? {}
				: { controllerExecutions: props.controllerExecutions }),
			gateway: props.gateway ?? gateway,
			...(props.managedApprovalAuthority === undefined
				? {}
				: { managedApprovalAuthority: props.managedApprovalAuthority }),
			session,
		}),
	);
	return dispatcher;
}

async function dispatchApprovalCommand(props: {
	readonly dispatcher: ReturnType<typeof createControlSessionDispatcher>;
	readonly message: GatewayControlRpcMessage;
	readonly sequence: number;
	readonly session?: GatewayControlCallerContextSessionRef;
}): Promise<GatewayControlCommandResultMessage> {
	if (
		props.message.kind !== 'command' ||
		(props.message.operation !== 'tool_portal_admission_reserve' &&
			props.message.operation !== 'tool_portal_approval_decide' &&
			props.message.operation !== 'tool_portal_dispatch_arm')
	) {
		throw new Error('Approval RPC test helper received a non-approval command.');
	}
	const response = await props.dispatcher.dispatch({
		envelope: createEnvelope({
			operation: props.message.operation,
			sequence: props.sequence,
			...(props.session === undefined ? {} : { session: props.session }),
		}),
		payload: props.message,
	});
	return GatewayControlRpcCommandResultMessageSchema.parse(response);
}

async function createDurableApprovalLedger(): Promise<ControllerApprovalLedger> {
	const temporaryDirectoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-approval-control-rpc-'),
	);
	temporaryDirectories.push(temporaryDirectoryPath);
	const recordsTarget = {
		directoryPath: path.join(temporaryDirectoryPath, 'approval-records'),
		kind: 'controller-approval-records',
		zoneId: gateway.zoneId,
	} satisfies ControllerApprovalRecordsTarget;
	return createControllerApprovalLedger({
		challengeTtlMs: 300_000,
		currentControllerEpoch: gateway.controllerEpoch,
		now: () => BASE_TIME_MS,
		recordsTarget,
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('gateway-control approval RPC integration', () => {
	it('derives approval authority from the accepted gateway session and rejects caller authority', async () => {
		// Arrange
		const requestApproval = vi.fn(async () => ({
			challenge: approvalChallenge,
			kind: 'approval-required' as const,
		}));
		const approvalLedger = {
			armDispatch: vi.fn(async () => ({
				kind: 'not-dispatched' as const,
				operationId: OPERATION_ID,
				reason: 'stale-fingerprint' as const,
			})),
			decide: vi.fn(async () => ({ kind: 'rejected' as const, reason: 'not-found' as const })),
			requestApproval,
		} satisfies GatewayControlApprovalLedgerOperations;
		const dispatcher = createApprovalDispatcher({ approvalLedger });

		// Act
		const response = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 1,
		});
		const callerAuthoredAuthorityCommand = {
			kind: 'command',
			operation: 'tool_portal_admission_reserve',
			payload: { authorityContext, intent: approvalIntent },
		};

		// Assert
		expect(requestApproval).toHaveBeenCalledOnce();
		expect(requestApproval).toHaveBeenCalledWith({ authorityContext, intent: approvalIntent });
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_admission_reserve',
			payload: {
				approvalAdmission: { challenge: approvalChallenge, kind: 'approval-required' },
				responseToMessageId: createEnvelope({
					operation: 'tool_portal_admission_reserve',
					sequence: 1,
				}).messageId,
				result: 'ok',
			},
		});
		expect(JSON.stringify(response)).not.toContain('authorityContext');
		await expect(
			dispatcher.dispatch({
				envelope: createEnvelope({
					operation: 'tool_portal_admission_reserve',
					sequence: 2,
				}),
				payload: callerAuthoredAuthorityCommand,
			}),
		).rejects.toThrow();
		expect(requestApproval).toHaveBeenCalledOnce();
	});

	it('records a managed Gateway decision through an exact-session caller context', async () => {
		// Arrange
		const approvalLedger = await createDurableApprovalLedger();
		const stablePrincipal = deriveGatewayControlStablePrincipal({
			principal: approvalIntent.trustedContext.principal,
		});
		const callerContextId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const callerContexts = createStaticCallerContextRegistry([
			{
				agentId: approvalIntent.trustedContext.principal.agentId,
				...acceptedSession,
				callerContextId,
				principal: approvalIntent.trustedContext.principal,
				purpose: 'tool_portal_approval_decision',
				stablePrincipal,
			},
		]);
		const dispatcher = createApprovalDispatcher({
			approvalLedger,
			callerContexts,
			managedApprovalAuthority: { approverId: 'hermes-operator' },
		});
		const pendingResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 2,
		});
		const challenge = pendingResponse.payload.approvalAdmission;
		if (challenge?.kind !== 'approval-required') {
			throw new Error('Expected one pending approval challenge.');
		}

		// Act
		const decisionResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_approval_decide',
				payload: {
					callerContext: { callerContextId },
					decision: { challengeId: challenge.challenge.approvalId, decision: 'approve' },
				},
			},
			sequence: 3,
		});

		// Assert
		expect(decisionResponse.payload.approvalDecision).toEqual({
			kind: 'recorded',
			state: 'approved',
		});
		expect(await approvalLedger.read(challenge.challenge.approvalId)).toMatchObject({
			decision: {
				operator: {
					approverId: 'hermes-operator',
					provenance: 'managed-gateway',
					stablePrincipal,
				},
			},
			kind: 'approved',
		});
	});

	it('rejects a managed Gateway decision when the caller principal does not own the challenge', async () => {
		// Arrange
		const approvalLedger = await createDurableApprovalLedger();
		const attackerPrincipal = {
			...approvalIntent.trustedContext.principal,
			agentId: 'agent-attacker',
			frameworkIdentity: { agentId: 'agent-attacker', kind: 'openclaw' as const },
		};
		const callerContextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		const callerContexts = createStaticCallerContextRegistry([
			{
				agentId: attackerPrincipal.agentId,
				...acceptedSession,
				callerContextId,
				principal: attackerPrincipal,
				purpose: 'tool_portal_approval_decision',
				stablePrincipal: deriveGatewayControlStablePrincipal({ principal: attackerPrincipal }),
			},
		]);
		const dispatcher = createApprovalDispatcher({
			approvalLedger,
			callerContexts,
			managedApprovalAuthority: { approverId: 'hermes-operator' },
		});
		const pendingResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 4,
		});
		const challenge = pendingResponse.payload.approvalAdmission;
		if (challenge?.kind !== 'approval-required') {
			throw new Error('Expected one pending approval challenge.');
		}

		// Act
		const decisionResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_approval_decide',
				payload: {
					callerContext: { callerContextId },
					decision: { challengeId: challenge.challenge.approvalId, decision: 'approve' },
				},
			},
			sequence: 5,
		});

		// Assert
		expect(decisionResponse.payload.approvalDecision).toEqual({
			kind: 'rejected',
			reason: 'principal-mismatch',
		});
		expect(await approvalLedger.read(challenge.challenge.approvalId)).toMatchObject({
			kind: 'pending',
		});
	});

	it('fails closed with a strict failure result when no approval ledger is configured', async () => {
		// Arrange
		const dispatcher = createApprovalDispatcher();

		// Act
		const response = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 3,
		});

		// Assert
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_admission_reserve',
			payload: {
				error: {
					errorClass: 'gateway_control_handler_failed',
					retryable: true,
					safeMessage:
						"Gateway control command 'tool_portal_admission_reserve' failed after acceptance.",
				},
				responseToMessageId: createEnvelope({
					operation: 'tool_portal_admission_reserve',
					sequence: 3,
				}).messageId,
				result: 'failed',
			},
		});
		expect(JSON.stringify(response)).not.toContain('authorityContext');
	});

	it('moves a durable challenge through external approval, reservation, and dispatch arm', async () => {
		// Arrange
		const approvalLedger = await createDurableApprovalLedger();
		const dispatcher = createApprovalDispatcher({ approvalLedger });
		const pendingResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 4,
		});
		const approvalAdmission = pendingResponse.payload.approvalAdmission;
		if (approvalAdmission?.kind !== 'approval-required') {
			throw new Error('Expected gateway-control to return a pending approval challenge.');
		}
		const decision = await approvalLedger.decide({
			approvalId: approvalAdmission.challenge.approvalId,
			authorityContext,
			decision: 'approve',
			operator: operatorIdentity,
		});

		// Act
		const reservationResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 5,
		});
		const reservationAdmission = reservationResponse.payload.approvalAdmission;
		if (
			reservationAdmission?.kind !== 'dispatch-reserved' ||
			reservationAdmission.reservation.backendKind === 'controller_execution'
		) {
			throw new Error('Expected approved gateway-control admission to reserve dispatch.');
		}
		const armResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_dispatch_arm',
				payload: { reservation: reservationAdmission.reservation },
			},
			sequence: 6,
		});

		// Assert
		expect(decision).toMatchObject({ decision: 'approve', kind: 'recorded' });
		expect(reservationAdmission.reservation).toMatchObject({
			authorityContext,
			backendKind: approvalIntent.backendKind,
			operationId: approvalIntent.operationId,
		});
		expect(armResponse.payload.approvalDispatch).toMatchObject({
			grant: {
				authorityContext,
				backendKind: approvalIntent.backendKind,
				operationId: approvalIntent.operationId,
			},
			kind: 'dispatch-armed',
		});
		expect(armResponse.payload.result).toBe('ok');
	});

	it('arms an approved controller-execution reservation before one controller dispatch', async () => {
		// Arrange
		const approvalLedger = await createDurableApprovalLedger();
		const stablePrincipal = deriveGatewayControlStablePrincipal({
			principal: controllerExecutionIntent.trustedContext.principal,
		});
		const createCallerContext = (callerContextId: string): GatewayControlTrustedCallerContext => ({
			agentId: controllerExecutionIntent.trustedContext.principal.agentId,
			...acceptedSession,
			callerContextId,
			principal: controllerExecutionIntent.trustedContext.principal,
			purpose: 'tool_portal_controller_execution',
			stablePrincipal,
		});
		const firstCallerContextId = '77777777-7777-4777-8777-777777777777';
		const replayCallerContextId = '88888888-8888-4888-8888-888888888888';
		const attackerCallerContextId = '99999999-9999-4999-8999-999999999999';
		const attackerPrincipal = {
			...controllerExecutionIntent.trustedContext.principal,
			agentId: 'agent-attacker',
			frameworkIdentity: { agentId: 'agent-attacker', kind: 'openclaw' as const },
		};
		const callerContexts = createStaticCallerContextRegistry([
			createCallerContext(firstCallerContextId),
			createCallerContext(replayCallerContextId),
			{
				...createCallerContext(attackerCallerContextId),
				agentId: attackerPrincipal.agentId,
				principal: attackerPrincipal,
				stablePrincipal: deriveGatewayControlStablePrincipal({ principal: attackerPrincipal }),
			},
		]);
		const runControllerHostProbe = vi.fn(async () => ({
			entryNames: ['approval-dispatched'],
			probeKind: 'controller_cache_dir_listing' as const,
		}));
		const controllerExecutions = {
			authorizeControllerExecution: async () => ({ authorized: true as const }),
			executeConfiguredCli: async () => ({
				exitCode: 0,
				stderrTruncated: false,
				stdout: '',
				stdoutTruncated: false,
			}),
			pushWorkspaceGit: async () => {
				throw new Error('Controller approval integration must not push Git.');
			},
			runControllerHostProbe,
		} satisfies GatewayControlControllerExecutionOperations;
		const dispatcher = createApprovalDispatcher({
			approvalLedger,
			callerContexts,
			controllerExecutions,
		});
		const pendingResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: controllerExecutionIntent },
			},
			sequence: 12,
		});
		const pendingAdmission = pendingResponse.payload.approvalAdmission;
		if (pendingAdmission?.kind !== 'approval-required') {
			throw new Error('Expected a pending controller-execution approval challenge.');
		}
		await approvalLedger.decide({
			approvalId: pendingAdmission.challenge.approvalId,
			authorityContext,
			decision: 'approve',
			operator: operatorIdentity,
		});
		const reservationResponse = await dispatchApprovalCommand({
			dispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: controllerExecutionIntent },
			},
			sequence: 13,
		});
		const reservationAdmission = reservationResponse.payload.approvalAdmission;
		if (
			reservationAdmission?.kind !== 'dispatch-reserved' ||
			reservationAdmission.reservation.backendKind !== 'controller_execution'
		) {
			throw new Error('Expected an approved controller-execution reservation.');
		}
		const controllerApprovalReservation = reservationAdmission.reservation;
		const createHostActionMessage = (callerContextId: string): GatewayControlRpcMessage => ({
			kind: 'command',
			operation: 'tool_portal_controller_execution',
			payload: {
				action: {
					actionId: 'controller_host_probe',
					approvalReservation: controllerApprovalReservation,
					callerContext: { callerContextId },
					correlation: {
						capability: {
							name: 'controller_host_probe',
							namespace: 'controller_execution',
						},
					},
				},
				kind: 'registered_action',
			},
		});

		// Act
		const attackerResponse = await dispatcher.dispatch({
			envelope: createEnvelope({
				operation: 'tool_portal_controller_execution',
				sequence: 14,
			}),
			payload: createHostActionMessage(attackerCallerContextId),
		});
		const firstResponse = await dispatcher.dispatch({
			envelope: createEnvelope({
				operation: 'tool_portal_controller_execution',
				sequence: 15,
			}),
			payload: createHostActionMessage(firstCallerContextId),
		});
		const replayResponse = await dispatcher.dispatch({
			envelope: createEnvelope({
				operation: 'tool_portal_controller_execution',
				sequence: 16,
			}),
			payload: createHostActionMessage(replayCallerContextId),
		});

		// Assert
		expect(attackerResponse).toMatchObject({
			operation: 'tool_portal_controller_execution',
			payload: {
				error: { errorClass: 'controller_execution_approval_principal_mismatch' },
				result: 'rejected',
			},
		});
		expect(firstResponse).toMatchObject({
			operation: 'tool_portal_controller_execution',
			payload: {
				controllerExecution: {
					action: { actionId: 'controller_host_probe' },
					kind: 'registered_action',
				},
				result: 'ok',
			},
		});
		expect(replayResponse).toMatchObject({
			operation: 'tool_portal_controller_execution',
			payload: {
				error: { errorClass: 'controller_execution_approval_dispatch_armed' },
				result: 'failed',
			},
		});
		expect(runControllerHostProbe).toHaveBeenCalledOnce();
		expect(await approvalLedger.read(pendingAdmission.challenge.approvalId)).toMatchObject({
			challenge: { intent: controllerExecutionIntent },
			kind: 'dispatch-armed',
		});
	});

	it('refuses an old reservation under replacement framework or gateway epochs', async () => {
		// Arrange
		const approvalLedger = await createDurableApprovalLedger();
		const originalDispatcher = createApprovalDispatcher({ approvalLedger });
		const pendingResponse = await dispatchApprovalCommand({
			dispatcher: originalDispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 7,
		});
		const pendingAdmission = pendingResponse.payload.approvalAdmission;
		if (pendingAdmission?.kind !== 'approval-required') {
			throw new Error('Expected a pending challenge before stale epoch proof.');
		}
		await approvalLedger.decide({
			approvalId: pendingAdmission.challenge.approvalId,
			authorityContext,
			decision: 'approve',
			operator: operatorIdentity,
		});
		const reservationResponse = await dispatchApprovalCommand({
			dispatcher: originalDispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_admission_reserve',
				payload: { intent: approvalIntent },
			},
			sequence: 8,
		});
		const reservationAdmission = reservationResponse.payload.approvalAdmission;
		if (
			reservationAdmission?.kind !== 'dispatch-reserved' ||
			reservationAdmission.reservation.backendKind === 'controller_execution'
		) {
			throw new Error('Expected an approved reservation before stale epoch proof.');
		}
		const replacementSession = {
			...acceptedSession,
			bootId: 'framework-boot-b',
			connectionId: '66666666-6666-4666-8666-666666666666',
			sessionId: '77777777-7777-4777-8777-777777777777',
		} satisfies GatewayControlCallerContextSessionRef;
		const replacementGateway = {
			...gateway,
			gatewayEpochId: 'gateway-epoch-b',
			gatewayVmId: 'gateway-vm-b',
			generationId: 'runtime-generation-b',
		} satisfies GatewayEpochIdentity;
		const replacementFrameworkDispatcher = createApprovalDispatcher({
			approvalLedger,
			session: replacementSession,
		});
		const replacementGatewayDispatcher = createApprovalDispatcher({
			approvalLedger,
			gateway: replacementGateway,
		});

		// Act
		const staleFrameworkResponse = await dispatchApprovalCommand({
			dispatcher: replacementFrameworkDispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_dispatch_arm',
				payload: { reservation: reservationAdmission.reservation },
			},
			sequence: 9,
			session: replacementSession,
		});
		const staleGatewayResponse = await dispatchApprovalCommand({
			dispatcher: replacementGatewayDispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_dispatch_arm',
				payload: { reservation: reservationAdmission.reservation },
			},
			sequence: 10,
		});
		const currentAuthorityResponse = await dispatchApprovalCommand({
			dispatcher: originalDispatcher,
			message: {
				kind: 'command',
				operation: 'tool_portal_dispatch_arm',
				payload: { reservation: reservationAdmission.reservation },
			},
			sequence: 11,
		});

		// Assert
		for (const staleResponse of [staleFrameworkResponse, staleGatewayResponse]) {
			expect(staleResponse.payload.approvalDispatch).toEqual({
				kind: 'not-dispatched',
				operationId: OPERATION_ID,
				reason: 'stale-authority',
			});
		}
		expect(currentAuthorityResponse.payload.approvalDispatch?.kind).toBe('dispatch-armed');
	});
});
