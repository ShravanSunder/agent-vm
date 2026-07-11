import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createControlSessionDispatcher } from './control-session-dispatcher.js';
import { createGatewaySemanticResultLedger } from './gateway-semantic-result-ledger.js';

const gateway = {
	controllerEpoch: 'controller-a',
	gatewayEpochId: 'gateway-a',
	gatewayVmId: 'gateway-vm-a',
	zoneId: 'zone-a',
};

function commandEnvelope(options: {
	readonly connectionId: string;
	readonly messageId: string;
	readonly sessionId: string;
}): ControlEnvelope {
	return {
		bootId: 'process-a',
		commandId: '77777777-7777-4777-8777-777777777777',
		connectionId: options.connectionId,
		controllerEpoch: 'controller-a',
		createdAtMs: 1,
		deliveryPolicy: 'critical_idempotent',
		domain: 'gateway_control',
		idempotencyKey: 'semantic-idempotency-a',
		kind: 'command',
		messageId: options.messageId,
		operation: 'mutate',
		peerId: 'gateway-zone-a',
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: 1,
		sessionId: options.sessionId,
		zoneId: 'zone-a',
	};
}

describe('Control session semantic dispatch', () => {
	it('does not rerun an S1 side effect when S2 retries after the S1 result was lost', async () => {
		let nowMs = 1;
		const ledger = createGatewaySemanticResultLedger({ gateway, nowMs: () => nowMs });
		const dispatcher = createControlSessionDispatcher({ semanticLedger: ledger });
		const mutate = vi.fn(async () => ({ result: 'mutated-once' }));
		dispatcher.register('gateway_control', {
			handle: mutate,
			messageIdentity: () => ({ kind: 'command', operation: 'mutate' }),
			policyByOperation: { mutate: 'critical_idempotent' },
			semanticMutation: ({ envelope, payload }) => ({
				identity: {
					commandId: envelope.commandId ?? envelope.messageId,
					gateway,
					idempotencyKey: envelope.idempotencyKey ?? envelope.messageId,
					operation: 'mutate',
					profile: {
						compatibilityId: 'compatibility-a',
						currentLeafTargetId: 'leaf-a',
						kind: 'lease_authority',
						stablePrincipal: 'principal-a',
					},
					target: 'leaf-a',
					validUntilMs: nowMs + 60_000,
				},
				payload: payload === null ? null : { value: 'same-meaning' },
			}),
		});

		const firstResult = await dispatcher.dispatch({
			envelope: commandEnvelope({
				connectionId: '11111111-1111-4111-8111-111111111111',
				messageId: '22222222-2222-4222-8222-222222222222',
				sessionId: '33333333-3333-4333-8333-333333333333',
			}),
			payload: { value: 'same-meaning' },
		});
		nowMs = 2;
		const retryResult = await dispatcher.dispatch({
			envelope: commandEnvelope({
				connectionId: '44444444-4444-4444-8444-444444444444',
				messageId: '55555555-5555-4555-8555-555555555555',
				sessionId: '66666666-6666-4666-8666-666666666666',
			}),
			payload: { value: 'same-meaning' },
		});

		expect(firstResult).toEqual({ result: 'mutated-once' });
		expect(retryResult).toEqual(firstResult);
		expect(mutate).toHaveBeenCalledOnce();
	});
});
