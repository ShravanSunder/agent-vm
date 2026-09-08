import { describe, expect, it } from 'vitest';

import { classifyGatewayControlAdmission } from './gateway-control-admission-classification.js';
import { GatewayControlRpcMessageSchema } from './index.js';

const cancellationMessage = {
	kind: 'command',
	operation: 'operation_cancel',
	payload: {
		activeOperationId: '11111111-1111-4111-8111-111111111111',
		adapterEvidence: {
			agentAuthority: { algorithm: 'hmac-sha256', digest: 'a'.repeat(43), keyId: 'agent-a' },
			principal: {
				agentId: 'agent-a',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
				profileAssignmentRevision: 'assignment-a',
				toolPortalProfileId: 'standard',
			},
			proof: { algorithm: 'hmac-sha256', digest: 'b'.repeat(43) },
			purpose: 'tool_portal_controller_execution',
			zoneId: 'zone-a',
		},
		initiatedBy: 'gateway',
		reason: 'caller_cancelled',
	},
} as const;

describe('Gateway configured CLI operation cancellation contract', () => {
	it('requires authenticated controller-execution evidence', () => {
		const { adapterEvidence: _adapterEvidence, ...payloadWithoutEvidence } =
			cancellationMessage.payload;
		expect(
			GatewayControlRpcMessageSchema.safeParse({
				...cancellationMessage,
				payload: payloadWithoutEvidence,
			}).success,
		).toBe(false);
		expect(GatewayControlRpcMessageSchema.parse(cancellationMessage)).toEqual(cancellationMessage);
	});

	it('uses the independent safety lane only after principal proof validation', () => {
		const message = GatewayControlRpcMessageSchema.parse(cancellationMessage);
		expect(
			classifyGatewayControlAdmission({ direction: 'gateway_to_controller', message }),
		).toEqual({ reason: 'unproven_gateway_cancel', status: 'refused' });
		expect(
			classifyGatewayControlAdmission({
				direction: 'gateway_to_controller',
				message,
				stablePrincipal: 'principal-a',
			}),
		).toEqual({ messageClass: 'safety', stablePrincipal: 'principal-a', status: 'classified' });
	});
});
