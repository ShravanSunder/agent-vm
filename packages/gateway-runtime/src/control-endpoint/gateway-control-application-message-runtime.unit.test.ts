import type { ControlEnvelope } from '@agent-vm/control-protocol-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayControlApplicationMessageRuntime,
	type GatewayControlSocket,
} from './gateway-control-application-message-runtime.js';
import {
	GatewayControlCommandCancelledBeforeDispatchError,
	type GatewayControlAcceptedSession,
	type GatewayControlApplicationMessageIntent,
} from './gateway-control-endpoint-contracts.js';

function deferred<TValue>(): {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
} {
	let resolvePromise!: (value: TValue) => void;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

const acceptedSession = {
	attachmentGeneration: 1,
	bootId: 'boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	generationId: 'generation-a',
	peerId: 'gateway-zone-a',
	processEpoch: 'process-a',
	sessionId: '22222222-2222-4222-8222-222222222222',
	zoneId: 'zone-a',
} as const satisfies GatewayControlAcceptedSession;

describe('Gateway control application message runtime', () => {
	it('does not emit an aborted command after it waits in local admission', async () => {
		const firstReceipt = deferred<unknown>();
		const emitWithAck = vi.fn(() => firstReceipt.promise);
		const socket = {
			connected: true,
			timeout: () => ({ emitWithAck }),
		} as unknown as GatewayControlSocket;
		let peerSequence = 0;
		const runtime = createGatewayControlApplicationMessageRuntime({
			assertInboundEnvelopeMatchesAcceptedSession: () => undefined,
			closeForProtocolFailure: () => undefined,
			closeForResponseFailure: () => undefined,
			commandResultTimeoutMsFor: () => 1_000,
			getAcceptedSession: () => acceptedSession,
			getAcceptedSocket: () => socket,
			getLastSeenControllerSequence: () => 0,
			pendingCommandResults: new Map(),
			recordLastSeenControllerSequence: () => undefined,
			recordLastSeenPeerSequence: () => undefined,
			reservePeerSequence: () => {
				peerSequence += 1;
				return peerSequence;
			},
		});
		const buildIntent = (messageId: string): GatewayControlApplicationMessageIntent => ({
			buildEnvelope: ({ sequence }: { readonly sequence: number }): ControlEnvelope => ({
				bootId: acceptedSession.bootId,
				connectionId: acceptedSession.connectionId,
				controllerEpoch: acceptedSession.controllerEpoch,
				createdAtMs: 1,
				deliveryPolicy: 'append_only_observation',
				domain: 'gateway_control',
				kind: 'event',
				messageId,
				operation: 'health_event',
				peerId: acceptedSession.peerId,
				protocolVersion: 1,
				sequence,
				sessionId: acceptedSession.sessionId,
				zoneId: acceptedSession.zoneId,
			}),
			domainMessage: { kind: 'event' as const, operation: 'health_event' },
			payload: {
				kind: 'event' as const,
				operation: 'health_event' as const,
				payload: {
					attempt: 1,
					elapsedMs: 1,
					eventKind: 'controller-request' as const,
					maxAttempts: 1,
					observedAtMs: 1,
					operation: 'lease-get' as const,
					result: 'ok' as const,
				},
			},
		});
		const first = runtime.emitApplicationMessage(
			buildIntent('33333333-3333-4333-8333-333333333333'),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(emitWithAck).toHaveBeenCalledOnce();
		const cancellation = new AbortController();
		const second = runtime.emitApplicationMessage(
			buildIntent('44444444-4444-4444-8444-444444444444'),
			{ signal: cancellation.signal },
		);
		cancellation.abort();
		firstReceipt.resolve({ received: true });
		await first;

		await expect(second).rejects.toBeInstanceOf(GatewayControlCommandCancelledBeforeDispatchError);
		expect(emitWithAck).toHaveBeenCalledOnce();
	});
});
