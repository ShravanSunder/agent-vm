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
} from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	type GatewayControlApprovalLedgerOperations,
} from './gateway-control-domain-handler.js';

const BASE_TIME_MS = Date.parse('2026-07-13T12:00:00.000Z');
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
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
	credentialId: 'approval-credential-a',
	provenance: 'approval-access',
} satisfies ControllerApprovalOperatorIdentity;

type GatewayControlCommandResultMessage = Extract<
	GatewayControlRpcMessage,
	{ readonly kind: 'command_result' }
>;

const temporaryDirectories: string[] = [];

function createEnvelope(props: {
	readonly operation: Extract<
		GatewayControlRpcOperation,
		'tool_portal_admission_reserve' | 'tool_portal_dispatch_arm'
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

function createApprovalDispatcher(
	props: {
		readonly approvalLedger?: GatewayControlApprovalLedgerOperations;
		readonly gateway?: GatewayEpochIdentity;
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
			callerContexts: createGatewayControlCallerContextRegistry({
				agentAuthorityKeys: {},
				callerContextProofKey: 'approval-rpc-test-caller-context-proof-key',
			}),
			gateway: props.gateway ?? gateway,
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
			reservationAdmission.reservation.backendKind === 'controller_host_action'
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
			reservationAdmission.reservation.backendKind === 'controller_host_action'
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
