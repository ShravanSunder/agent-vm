import { describe, expect, it } from 'vitest';

import {
	GatewayControlRpcCommandMessageSchema,
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcCommandResultOperationSchema,
	GatewayControlRpcOperationSchema,
	GatewayRuntimeApprovalAdmissionResultSchema,
	GatewayRuntimeApprovalArmDispatchResultSchema,
	GatewayRuntimeApprovalChallengeIntentSchema,
	GatewayRuntimeApprovalDispatchReservationSchema,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	gatewayControlDeliveryPolicyByOperation,
} from './index.js';

const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const RESPONSE_TO_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const APPROVAL_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const STABLE_GATEWAY_PRINCIPAL = 'b'.repeat(64);

const approvalAuthorityContext = {
	controllerEpoch: 'controller-epoch-7',
	frameworkEpoch: 'framework-epoch-5',
	gatewayEpoch: 'gateway-epoch-9',
	runtimeEpoch: 'runtime-epoch-3',
	zoneId: 'zone-a',
} as const;

const approvalChallengeIntent = {
	backendKind: 'mcp_provider',
	call: {
		arguments: { owner: 'agent-vm', repository: 'runtime' },
		id: 'github.create_issue',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: OPERATION_ID,
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
			profileAssignmentRevision: 'profile-assignment-7',
			toolPortalProfileId: 'code-builder',
		},
		requester: { authenticatedSubjectId: 'operator-a' },
	},
} as const;

const approvalChallenge = {
	approvalId: APPROVAL_ID,
	createdAt: '2026-07-13T12:00:00.000Z',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT,
	intent: approvalChallengeIntent,
} as const;

const approvalDispatchReservation = {
	approvalId: APPROVAL_ID,
	authorityContext: approvalAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT,
	operationId: OPERATION_ID,
	reservationId: RESERVATION_ID,
	stablePrincipal: STABLE_GATEWAY_PRINCIPAL,
} as const;

const approvalDispatchGrant = {
	approvalId: APPROVAL_ID,
	authorityContext: approvalAuthorityContext,
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T12:05:00.000Z',
	fingerprint: APPROVAL_FINGERPRINT,
	grantId: GRANT_ID,
	operationId: OPERATION_ID,
	stablePrincipal: STABLE_GATEWAY_PRINCIPAL,
} as const;

const rpcError = {
	errorClass: 'approval_admission_failed',
	retryable: false,
	safeMessage: 'Approval admission failed.',
} as const;

describe('gateway-control approval operations', () => {
	it('declares reserve and arm as command and command-result operations', () => {
		// Arrange
		const expectedOperations = [
			'tool_portal_admission_reserve',
			'tool_portal_dispatch_arm',
		] as const;

		// Act / Assert
		for (const operation of expectedOperations) {
			expect(GatewayControlRpcOperationSchema.safeParse(operation).success).toBe(true);
			expect(GatewayControlRpcCommandResultOperationSchema.safeParse(operation).success).toBe(true);
			expect(
				GatewayControlRpcCommandMessageSchema.safeParse({
					kind: 'event',
					operation,
					payload: {},
				}).success,
			).toBe(false);
		}
	});

	it('carries only the bounded challenge intent in admission reserve commands', () => {
		// Arrange
		const command = {
			kind: 'command',
			operation: 'tool_portal_admission_reserve',
			payload: { intent: approvalChallengeIntent },
		} as const;
		const forbiddenPayloadFields = {
			adminToken: 'admin-token',
			approvalProof: 'caller-authored-proof',
			authorityContext: approvalAuthorityContext,
			bearerToken: 'approval-bearer-token',
			rawCredentialRef: 'credential-reference',
		} as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalChallengeIntentSchema.parse(approvalChallengeIntent)).toEqual(
			approvalChallengeIntent,
		);
		expect(GatewayControlRpcCommandMessageSchema.safeParse(command).success).toBe(true);
		for (const [fieldName, fieldValue] of Object.entries(forbiddenPayloadFields)) {
			expect(
				GatewayControlRpcCommandMessageSchema.safeParse({
					...command,
					payload: { ...command.payload, [fieldName]: fieldValue },
				}).success,
			).toBe(false);
		}
		expect(
			GatewayControlRpcCommandMessageSchema.safeParse({
				...command,
				payload: {
					intent: { ...approvalChallengeIntent, credentialProfileId: 'approval-profile' },
				},
			}).success,
		).toBe(false);
	});

	it.each([
		{
			challenge: approvalChallenge,
			kind: 'approval-required',
		},
		{
			kind: 'dispatch-reserved',
			reservation: approvalDispatchReservation,
		},
		{
			kind: 'not-dispatched',
			operationId: OPERATION_ID,
			reason: 'denied',
		},
		{
			kind: 'ambiguous',
			operationId: OPERATION_ID,
			reason: 'dispatch-armed',
		},
	] as const)('binds the $kind admission result to admission reserve', (approvalAdmission) => {
		// Arrange
		const resultMessage = {
			kind: 'command_result',
			operation: 'tool_portal_admission_reserve',
			payload: {
				approvalAdmission,
				responseToMessageId: RESPONSE_TO_MESSAGE_ID,
				result: 'ok',
			},
		} as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalAdmissionResultSchema.parse(approvalAdmission)).toEqual(
			approvalAdmission,
		);
		expect(GatewayControlRpcCommandResultMessageSchema.safeParse(resultMessage).success).toBe(true);
		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				...resultMessage,
				payload: { ...resultMessage.payload, authorityContext: approvalAuthorityContext },
			}).success,
		).toBe(false);
		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				...resultMessage,
				payload: { ...resultMessage.payload, bearerToken: 'approval-bearer-token' },
			}).success,
		).toBe(false);
	});

	it('keeps admission reserve error results strict and separate from success authority', () => {
		// Arrange
		const errorResult = {
			kind: 'command_result',
			operation: 'tool_portal_admission_reserve',
			payload: {
				error: rpcError,
				responseToMessageId: RESPONSE_TO_MESSAGE_ID,
				result: 'failed',
			},
		} as const;

		// Act / Assert
		expect(GatewayControlRpcCommandResultMessageSchema.safeParse(errorResult).success).toBe(true);
		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				...errorResult,
				payload: {
					...errorResult.payload,
					approvalAdmission: {
						challenge: approvalChallenge,
						kind: 'approval-required',
					},
				},
			}).success,
		).toBe(false);
	});

	it('carries only the controller-issued reservation in dispatch arm commands', () => {
		// Arrange
		const command = {
			kind: 'command',
			operation: 'tool_portal_dispatch_arm',
			payload: { reservation: approvalDispatchReservation },
		} as const;

		// Act / Assert
		expect(
			GatewayRuntimeApprovalDispatchReservationSchema.parse(approvalDispatchReservation),
		).toEqual(approvalDispatchReservation);
		expect(GatewayControlRpcCommandMessageSchema.safeParse(command).success).toBe(true);
		for (const invalidPayload of [
			{ ...command.payload, approvalProof: 'caller-authored-proof' },
			{ ...command.payload, bearerToken: 'approval-bearer-token' },
			{ ...command.payload, grant: approvalDispatchGrant },
			{ ...command.payload, rawCredentialRef: 'credential-reference' },
		]) {
			expect(
				GatewayControlRpcCommandMessageSchema.safeParse({ ...command, payload: invalidPayload })
					.success,
			).toBe(false);
		}
		expect(
			GatewayControlRpcCommandMessageSchema.safeParse({
				...command,
				payload: {
					reservation: {
						...approvalDispatchReservation,
						credentialProfileId: 'approval-profile',
					},
				},
			}).success,
		).toBe(false);
		expect(
			GatewayControlRpcCommandMessageSchema.safeParse({
				...command,
				payload: {
					reservation: {
						...approvalDispatchReservation,
						backendKind: 'controller_execution',
					},
				},
			}).success,
		).toBe(false);
	});

	it.each([
		{
			grant: approvalDispatchGrant,
			kind: 'dispatch-armed',
		},
		{
			kind: 'not-dispatched',
			operationId: OPERATION_ID,
			reason: 'stale-authority',
		},
		{
			kind: 'ambiguous',
			operationId: OPERATION_ID,
			reason: 'dispatch-armed',
		},
	] as const)('binds the $kind dispatch result to dispatch arm', (approvalDispatch) => {
		// Arrange
		const resultMessage = {
			kind: 'command_result',
			operation: 'tool_portal_dispatch_arm',
			payload: {
				approvalDispatch,
				responseToMessageId: RESPONSE_TO_MESSAGE_ID,
				result: 'ok',
			},
		} as const;

		// Act / Assert
		expect(GatewayRuntimeApprovalArmDispatchResultSchema.parse(approvalDispatch)).toEqual(
			approvalDispatch,
		);
		expect(GatewayControlRpcCommandResultMessageSchema.safeParse(resultMessage).success).toBe(true);
		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				...resultMessage,
				payload: { ...resultMessage.payload, rawCredentialRef: 'credential-reference' },
			}).success,
		).toBe(false);
	});

	it('keeps dispatch arm error results strict and separate from grant authority', () => {
		// Arrange
		const errorResult = {
			kind: 'command_result',
			operation: 'tool_portal_dispatch_arm',
			payload: {
				error: rpcError,
				responseToMessageId: RESPONSE_TO_MESSAGE_ID,
				result: 'timeout',
			},
		} as const;

		// Act / Assert
		expect(GatewayControlRpcCommandResultMessageSchema.safeParse(errorResult).success).toBe(true);
		expect(
			GatewayControlRpcCommandResultMessageSchema.safeParse({
				...errorResult,
				payload: {
					...errorResult.payload,
					approvalDispatch: {
						grant: approvalDispatchGrant,
						kind: 'dispatch-armed',
					},
				},
			}).success,
		).toBe(false);
	});

	it('classifies reserve and arm as single-use critical with bounded execution budgets', () => {
		// Arrange
		const declaredDeliveryPolicies: Readonly<Record<string, unknown>> =
			gatewayControlDeliveryPolicyByOperation;
		const declaredExecutionTimeouts: Readonly<Record<string, number>> =
			gatewayControlCommandExecutionTimeoutMsByOperation;

		// Act / Assert
		expect(declaredDeliveryPolicies.tool_portal_admission_reserve).toBe('single_use_critical');
		expect(declaredDeliveryPolicies.tool_portal_dispatch_arm).toBe('single_use_critical');
		expect(declaredExecutionTimeouts.tool_portal_admission_reserve).toBe(10_000);
		expect(declaredExecutionTimeouts.tool_portal_dispatch_arm).toBe(10_000);
		expect(Object.keys(declaredDeliveryPolicies).toSorted()).toEqual(
			[...GatewayControlRpcOperationSchema.options].toSorted(),
		);
		expect(Object.keys(declaredExecutionTimeouts).toSorted()).toEqual(
			[...GatewayControlRpcOperationSchema.options].toSorted(),
		);
	});
});
