import { describe, expect, it } from 'vitest';

import { classifyGatewayControlAdmission } from './gateway-control-admission-classification.js';
import { GatewayControlRpcCommandMessageSchema } from './index.js';

const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';
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

const approvalAuthorityCommands = [
	{
		message: GatewayControlRpcCommandMessageSchema.parse({
			kind: 'command',
			operation: 'tool_portal_admission_reserve',
			payload: { intent: approvalChallengeIntent },
		}),
		operation: 'tool_portal_admission_reserve',
	},
	{
		message: GatewayControlRpcCommandMessageSchema.parse({
			kind: 'command',
			operation: 'tool_portal_dispatch_arm',
			payload: { reservation: approvalDispatchReservation },
		}),
		operation: 'tool_portal_dispatch_arm',
	},
] as const;

describe.each(approvalAuthorityCommands)('$operation admission classification', ({ message }) => {
	it('requires a stable Gateway principal', () => {
		// Arrange / Act
		const classification = classifyGatewayControlAdmission({
			direction: 'gateway_to_controller',
			message,
		});

		// Assert
		expect(classification).toEqual({
			reason: 'stable_principal_required',
			status: 'refused',
		});
	});

	it('uses the stable Gateway principal as the authority scheduling key', () => {
		// Arrange / Act
		const classification = classifyGatewayControlAdmission({
			direction: 'gateway_to_controller',
			message,
			stablePrincipal: STABLE_GATEWAY_PRINCIPAL,
		});

		// Assert
		expect(classification).toEqual({
			authoritySchedulingKey: STABLE_GATEWAY_PRINCIPAL,
			messageClass: 'authority',
			stablePrincipal: STABLE_GATEWAY_PRINCIPAL,
			status: 'classified',
		});
	});

	it('fences the controller-to-Gateway direction', () => {
		// Arrange / Act
		const classification = classifyGatewayControlAdmission({
			direction: 'controller_to_gateway',
			message,
			stablePrincipal: STABLE_GATEWAY_PRINCIPAL,
		});

		// Assert
		expect(classification).toEqual({ reason: 'direction_violation', status: 'fence' });
	});
});
