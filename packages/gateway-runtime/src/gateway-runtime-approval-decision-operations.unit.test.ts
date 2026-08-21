import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeControlCommandRequest } from './control-endpoint/gateway-control-command-client.js';
import { createGatewayRuntimeApprovalDecisionOperations } from './gateway-runtime-approval-decision-operations.js';

const trustedContext = {
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
		profileAssignmentRevision: 'profiles-1',
		toolPortalProfileId: 'profile-a',
	},
} satisfies GatewayRuntimeTrustedInvocationContext;

describe('Gateway Runtime approval decision operations', () => {
	it('registers the exact principal purpose and sends only an opaque context ref plus decision', async () => {
		const register = vi.fn(async () => ({
			admissionPrincipal: 'a'.repeat(64),
			callerContextId: '11111111-1111-4111-8111-111111111111',
		}));
		const sendCommand = vi.fn(async (_request: GatewayRuntimeControlCommandRequest) => ({
			acceptedSession: {
				attachmentGeneration: 1,
				bootId: 'boot-a',
				connectionId: '44444444-4444-4444-8444-444444444444',
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				generationId: 'generation-a',
				peerId: 'gateway-peer-a',
				processEpoch: 'process-a',
				sessionId: '55555555-5555-4555-8555-555555555555',
				zoneId: 'zone-a',
			},
			messageId: '22222222-2222-4222-8222-222222222222',
			response: {
				kind: 'command_result' as const,
				operation: 'tool_portal_approval_decide' as const,
				payload: {
					approvalDecision: { kind: 'recorded' as const, state: 'approved' as const },
					responseToMessageId: '22222222-2222-4222-8222-222222222222',
					result: 'ok' as const,
				},
			},
		}));
		const operations = createGatewayRuntimeApprovalDecisionOperations({
			callerContextRegistrationClient: { close: vi.fn(), register },
			controlCommandClient: { sendCommand },
		});
		const decision = {
			challengeId: '33333333-3333-4333-8333-333333333333',
			decision: 'approve' as const,
		};

		const result = await operations.decide({ publicRequest: decision, trustedContext });

		expect(result).toEqual({ kind: 'recorded', state: 'approved' });
		expect(register).toHaveBeenCalledWith({
			purpose: 'tool_portal_approval_decision',
			trustedContext,
		});
		expect(sendCommand).toHaveBeenCalledWith({
			admissionPrincipal: 'a'.repeat(64),
			message: {
				kind: 'command',
				operation: 'tool_portal_approval_decide',
				payload: {
					callerContext: { callerContextId: '11111111-1111-4111-8111-111111111111' },
					decision,
				},
			},
		});
	});
});
