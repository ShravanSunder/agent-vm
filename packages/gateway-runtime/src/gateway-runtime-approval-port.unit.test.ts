import {
	GatewayControlRpcCommandMessageSchema,
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeApprovalAdmissionResult,
	type GatewayRuntimeApprovalArmDispatchResult,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimeApprovalDispatchGrant,
	type GatewayRuntimeApprovalDispatchReservation,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import { createGatewayRuntimeApprovalPort } from './gateway-runtime-approval-port.js';

const APPROVAL_ID_A = '11111111-1111-4111-8111-111111111111';
const APPROVAL_ID_B = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID_A = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID_B = '44444444-4444-4444-8444-444444444444';
const RESERVATION_ID_A = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID_B = '66666666-6666-4666-8666-666666666666';
const GRANT_ID_A = '77777777-7777-4777-8777-777777777777';
const GRANT_ID_B = '88888888-8888-4888-8888-888888888888';
const MESSAGE_ID_A = '99999999-9999-4999-8999-999999999999';
const MESSAGE_ID_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE_ID_C = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE_ID_D = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MISMATCHED_MESSAGE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APPROVAL_FINGERPRINT_A = `sha256:${'a'.repeat(64)}`;
const APPROVAL_FINGERPRINT_B = `sha256:${'b'.repeat(64)}`;

interface ApprovalControlCommandRequest {
	readonly admissionPrincipal: string;
	readonly message: unknown;
}

interface ApprovalControlCommandResponse {
	readonly messageId: string;
	readonly response: unknown;
}

interface ApprovalPortFixture {
	readonly approvalPort: ReturnType<typeof createGatewayRuntimeApprovalPort>;
	readonly sentCommands: readonly ApprovalControlCommandRequest[];
}

const approvalAuthorityContext = {
	controllerEpoch: 'controller-epoch-7',
	frameworkEpoch: 'framework-epoch-5',
	gatewayEpoch: 'gateway-epoch-9',
	runtimeEpoch: 'runtime-epoch-3',
	zoneId: 'zone-a',
} as const;

const approvalIntentA = {
	backendKind: 'mcp_provider',
	call: {
		arguments: { owner: 'agent-vm', repository: 'runtime' },
		id: 'call-a',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: OPERATION_ID_A,
	semanticRevisions: {
		activeRevision: 'semantic-12',
		bindingRevision: 'bindings-4',
		catalogRevision: 'catalog-9',
		profilePolicyRevision: 'profile-policy-6',
		providerRevision: 'providers-3',
		schemaRevision: 'portal-schema-1',
	},
	surfaceClass: 'mcp',
	trustedContext: {
		correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
		principal: {
			agentId: 'agent-a',
			frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-assignment:agent-a:7',
			toolPortalProfileId: 'code-builder',
		},
		requester: { authenticatedSubjectId: 'subject-a' },
	},
} satisfies GatewayRuntimeApprovalChallengeIntent;

const approvalIntentB = {
	...approvalIntentA,
	call: {
		arguments: { command: 'pnpm check' },
		id: 'call-b',
		name: 'exec',
		namespace: 'sandbox',
	},
	operationId: OPERATION_ID_B,
	trustedContext: {
		...approvalIntentA.trustedContext,
		correlation: { runId: 'run-b', sessionId: 'session-b', toolCallId: 'tool-call-b' },
		principal: {
			...approvalIntentA.trustedContext.principal,
			agentId: 'agent-b',
			frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-assignment:agent-b:4',
		},
		requester: { authenticatedSubjectId: 'subject-b' },
	},
} satisfies GatewayRuntimeApprovalChallengeIntent;

const approvalReservationA = {
	approvalId: APPROVAL_ID_A,
	authorityContext: approvalAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT_A,
	operationId: OPERATION_ID_A,
	reservationId: RESERVATION_ID_A,
	stablePrincipal: stablePrincipalForAgent({ agentId: 'agent-a' }),
} satisfies GatewayRuntimeApprovalDispatchReservation;

const approvalReservationB = {
	approvalId: APPROVAL_ID_B,
	authorityContext: approvalAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT_B,
	operationId: OPERATION_ID_B,
	reservationId: RESERVATION_ID_B,
	stablePrincipal: stablePrincipalForAgent({ agentId: 'agent-b' }),
} satisfies GatewayRuntimeApprovalDispatchReservation;

const approvalGrantA = {
	approvalId: APPROVAL_ID_A,
	authorityContext: approvalAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT_A,
	grantId: GRANT_ID_A,
	operationId: OPERATION_ID_A,
	stablePrincipal: stablePrincipalForAgent({ agentId: 'agent-a' }),
} satisfies GatewayRuntimeApprovalDispatchGrant;

const approvalGrantB = {
	approvalId: APPROVAL_ID_B,
	authorityContext: approvalAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT_B,
	grantId: GRANT_ID_B,
	operationId: OPERATION_ID_B,
	stablePrincipal: stablePrincipalForAgent({ agentId: 'agent-b' }),
} satisfies GatewayRuntimeApprovalDispatchGrant;

const approvalRequired = {
	challenge: {
		approvalId: APPROVAL_ID_A,
		createdAt: '2026-07-13T12:00:00.000Z',
		expiresAt: '2026-07-13T12:05:00.000Z',
		fingerprint: APPROVAL_FINGERPRINT_A,
		intent: approvalIntentA,
	},
	kind: 'approval-required',
} satisfies GatewayRuntimeApprovalAdmissionResult;

function stablePrincipalForAgent(props: { readonly agentId: string }): string {
	return deriveGatewayControlStablePrincipal({
		principal:
			props.agentId === 'agent-a'
				? approvalIntentA.trustedContext.principal
				: approvalIntentB.trustedContext.principal,
	});
}

function successfulAdmissionResponse(props: {
	readonly approvalAdmission: GatewayRuntimeApprovalAdmissionResult;
	readonly messageId: string;
}): ApprovalControlCommandResponse {
	return {
		messageId: props.messageId,
		response: {
			kind: 'command_result',
			operation: 'tool_portal_admission_reserve',
			payload: {
				approvalAdmission: props.approvalAdmission,
				responseToMessageId: props.messageId,
				result: 'ok',
			},
		},
	};
}

function successfulDispatchResponse(props: {
	readonly approvalDispatch: GatewayRuntimeApprovalArmDispatchResult;
	readonly messageId: string;
}): ApprovalControlCommandResponse {
	return {
		messageId: props.messageId,
		response: {
			kind: 'command_result',
			operation: 'tool_portal_dispatch_arm',
			payload: {
				approvalDispatch: props.approvalDispatch,
				responseToMessageId: props.messageId,
				result: 'ok',
			},
		},
	};
}

function createApprovalPortFixture(
	queuedResponses: readonly ApprovalControlCommandResponse[],
): ApprovalPortFixture {
	const pendingResponses = [...queuedResponses];
	const sentCommands: ApprovalControlCommandRequest[] = [];
	const approvalPort = createGatewayRuntimeApprovalPort({
		controlCommandPort: {
			sendCommand: (
				request: ApprovalControlCommandRequest,
			): Promise<ApprovalControlCommandResponse> => {
				sentCommands.push(request);
				const response = pendingResponses.shift();
				if (response === undefined) {
					return Promise.reject(new Error('Unexpected Gateway control command.'));
				}
				return Promise.resolve(response);
			},
		},
		zoneId: 'zone-a',
	});
	return { approvalPort, sentCommands };
}

describe('Gateway runtime approval port', () => {
	it('sends a strict admission command under the stable zone-and-agent principal', async () => {
		// Arrange
		const fixture = createApprovalPortFixture([
			successfulAdmissionResponse({ approvalAdmission: approvalRequired, messageId: MESSAGE_ID_A }),
		]);

		// Act
		const result = await fixture.approvalPort.reserveDispatch({ intent: approvalIntentA });

		// Assert
		expect(result).toEqual(approvalRequired);
		expect(fixture.sentCommands).toEqual([
			{
				admissionPrincipal: stablePrincipalForAgent({ agentId: 'agent-a' }),
				message: {
					kind: 'command',
					operation: 'tool_portal_admission_reserve',
					payload: { intent: approvalIntentA },
				},
			},
		]);
		expect(GatewayControlRpcCommandMessageSchema.parse(fixture.sentCommands[0]?.message)).toEqual(
			fixture.sentCommands[0]?.message,
		);
	});

	it('preserves each stable admission principal across interleaved reserve and arm calls', async () => {
		// Arrange
		const fixture = createApprovalPortFixture([
			successfulAdmissionResponse({
				approvalAdmission: { kind: 'dispatch-reserved', reservation: approvalReservationA },
				messageId: MESSAGE_ID_A,
			}),
			successfulAdmissionResponse({
				approvalAdmission: { kind: 'dispatch-reserved', reservation: approvalReservationB },
				messageId: MESSAGE_ID_B,
			}),
			successfulDispatchResponse({
				approvalDispatch: { grant: approvalGrantB, kind: 'dispatch-armed' },
				messageId: MESSAGE_ID_C,
			}),
			successfulDispatchResponse({
				approvalDispatch: { grant: approvalGrantA, kind: 'dispatch-armed' },
				messageId: MESSAGE_ID_D,
			}),
		]);

		// Act
		await fixture.approvalPort.reserveDispatch({ intent: approvalIntentA });
		await fixture.approvalPort.reserveDispatch({ intent: approvalIntentB });
		const agentBDispatch = await fixture.approvalPort.armDispatch({
			reservation: approvalReservationB,
		});
		const agentADispatch = await fixture.approvalPort.armDispatch({
			reservation: approvalReservationA,
		});

		// Assert
		expect(agentBDispatch).toEqual({ grant: approvalGrantB, kind: 'dispatch-armed' });
		expect(agentADispatch).toEqual({ grant: approvalGrantA, kind: 'dispatch-armed' });
		expect(fixture.sentCommands).toEqual([
			{
				admissionPrincipal: stablePrincipalForAgent({ agentId: 'agent-a' }),
				message: {
					kind: 'command',
					operation: 'tool_portal_admission_reserve',
					payload: { intent: approvalIntentA },
				},
			},
			{
				admissionPrincipal: stablePrincipalForAgent({ agentId: 'agent-b' }),
				message: {
					kind: 'command',
					operation: 'tool_portal_admission_reserve',
					payload: { intent: approvalIntentB },
				},
			},
			{
				admissionPrincipal: stablePrincipalForAgent({ agentId: 'agent-b' }),
				message: {
					kind: 'command',
					operation: 'tool_portal_dispatch_arm',
					payload: { reservation: approvalReservationB },
				},
			},
			{
				admissionPrincipal: stablePrincipalForAgent({ agentId: 'agent-a' }),
				message: {
					kind: 'command',
					operation: 'tool_portal_dispatch_arm',
					payload: { reservation: approvalReservationA },
				},
			},
		]);
	});

	it.each([
		{
			label: 'a different admission principal',
			response: successfulAdmissionResponse({
				approvalAdmission: {
					kind: 'dispatch-reserved',
					reservation: {
						...approvalReservationA,
						stablePrincipal: stablePrincipalForAgent({
							agentId: 'agent-b',
						}),
					},
				},
				messageId: MESSAGE_ID_A,
			}),
		},
		{
			label: 'the wrong result operation',
			response: {
				messageId: MESSAGE_ID_A,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_dispatch_arm',
					payload: {
						approvalDispatch: {
							kind: 'not-dispatched',
							operationId: OPERATION_ID_A,
							reason: 'denied',
						},
						responseToMessageId: MESSAGE_ID_A,
						result: 'ok',
					},
				},
			},
		},
		{
			label: 'a failed result',
			response: {
				messageId: MESSAGE_ID_A,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_admission_reserve',
					payload: {
						error: {
							errorClass: 'approval_admission_failed',
							retryable: false,
							safeMessage: 'Approval admission failed.',
						},
						responseToMessageId: MESSAGE_ID_A,
						result: 'failed',
					},
				},
			},
		},
		{
			label: 'a missing approval admission payload',
			response: {
				messageId: MESSAGE_ID_A,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_admission_reserve',
					payload: { responseToMessageId: MESSAGE_ID_A, result: 'ok' },
				},
			},
		},
		{
			label: 'a malformed approval admission payload',
			response: {
				messageId: MESSAGE_ID_A,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_admission_reserve',
					payload: {
						approvalAdmission: { kind: 'approval-required' },
						responseToMessageId: MESSAGE_ID_A,
						result: 'ok',
					},
				},
			},
		},
		{
			label: 'a mismatched response correlation',
			response: {
				messageId: MESSAGE_ID_A,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_admission_reserve',
					payload: {
						approvalAdmission: approvalRequired,
						responseToMessageId: MISMATCHED_MESSAGE_ID,
						result: 'ok',
					},
				},
			},
		},
	] satisfies readonly {
		readonly label: string;
		readonly response: ApprovalControlCommandResponse;
	}[])('fails closed when admission returns $label', async ({ response }) => {
		// Arrange
		const fixture = createApprovalPortFixture([response]);

		// Act / Assert
		await expect(
			fixture.approvalPort.reserveDispatch({ intent: approvalIntentA }),
		).rejects.toThrow();
	});

	it.each([
		{
			label: 'a changed grant principal',
			response: successfulDispatchResponse({
				approvalDispatch: {
					grant: {
						...approvalGrantA,
						stablePrincipal: stablePrincipalForAgent({
							agentId: 'agent-b',
						}),
					},
					kind: 'dispatch-armed',
				},
				messageId: MESSAGE_ID_B,
			}),
		},
		{
			label: 'the wrong result operation',
			response: successfulAdmissionResponse({
				approvalAdmission: approvalRequired,
				messageId: MESSAGE_ID_B,
			}),
		},
		{
			label: 'a failed result',
			response: {
				messageId: MESSAGE_ID_B,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_dispatch_arm',
					payload: {
						error: {
							errorClass: 'approval_dispatch_failed',
							retryable: false,
							safeMessage: 'Approval dispatch failed.',
						},
						responseToMessageId: MESSAGE_ID_B,
						result: 'failed',
					},
				},
			},
		},
		{
			label: 'a missing approval dispatch payload',
			response: {
				messageId: MESSAGE_ID_B,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_dispatch_arm',
					payload: { responseToMessageId: MESSAGE_ID_B, result: 'ok' },
				},
			},
		},
		{
			label: 'a malformed approval dispatch payload',
			response: {
				messageId: MESSAGE_ID_B,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_dispatch_arm',
					payload: {
						approvalDispatch: { kind: 'dispatch-armed' },
						responseToMessageId: MESSAGE_ID_B,
						result: 'ok',
					},
				},
			},
		},
		{
			label: 'a mismatched response correlation',
			response: {
				...successfulDispatchResponse({
					approvalDispatch: { grant: approvalGrantA, kind: 'dispatch-armed' },
					messageId: MESSAGE_ID_B,
				}),
				response: {
					kind: 'command_result',
					operation: 'tool_portal_dispatch_arm',
					payload: {
						approvalDispatch: { grant: approvalGrantA, kind: 'dispatch-armed' },
						responseToMessageId: MISMATCHED_MESSAGE_ID,
						result: 'ok',
					},
				},
			},
		},
	] satisfies readonly {
		readonly label: string;
		readonly response: ApprovalControlCommandResponse;
	}[])('fails closed when arm returns $label', async ({ response }) => {
		// Arrange
		const fixture = createApprovalPortFixture([
			successfulAdmissionResponse({
				approvalAdmission: { kind: 'dispatch-reserved', reservation: approvalReservationA },
				messageId: MESSAGE_ID_A,
			}),
			response,
		]);
		await fixture.approvalPort.reserveDispatch({ intent: approvalIntentA });

		// Act / Assert
		await expect(
			fixture.approvalPort.armDispatch({ reservation: approvalReservationA }),
		).rejects.toThrow();
	});
});
