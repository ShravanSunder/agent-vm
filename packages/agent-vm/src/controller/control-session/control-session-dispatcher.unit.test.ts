import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createControlSessionDispatcher } from './control-session-dispatcher.js';
import {
	createGatewaySemanticResultLedger,
	type GatewaySemanticExecutionProof,
} from './gateway-semantic-result-ledger.js';

const gateway = {
	bootId: 'gateway-process-a',
	controllerEpoch: 'controller-a',
	gatewayEpochId: 'gateway-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
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
		const mutate = vi.fn(async (_proof: GatewaySemanticExecutionProof) => ({
			result: 'mutated-once',
		}));
		dispatcher.register('gateway_control', {
			handle: async () => ({ result: 'non-semantic-handler-must-not-run' }),
			messageIdentity: () => ({ kind: 'command', operation: 'mutate' }),
			policyByOperation: { mutate: 'critical_idempotent' },
			prepareSemanticMutation: async ({ envelope, payload }) => ({
				execute: mutate,
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

	it('rebuilds transport correlation around a cached semantic value for each retry', async () => {
		const ledger = createGatewaySemanticResultLedger({ gateway, nowMs: () => 1 });
		const dispatcher = createControlSessionDispatcher({ semanticLedger: ledger });
		const mutate = vi.fn(async (_proof: GatewaySemanticExecutionProof) => ({
			value: 'transport-neutral-result',
		}));
		dispatcher.register('gateway_control', {
			buildSemanticTransportResult: ({ envelope }, completedValue) => ({
				completedValue,
				responseToMessageId: envelope.messageId,
			}),
			handle: async () => ({ result: 'non-semantic-handler-must-not-run' }),
			messageIdentity: () => ({ kind: 'command', operation: 'mutate' }),
			policyByOperation: { mutate: 'critical_idempotent' },
			prepareSemanticMutation: async ({ envelope }) => ({
				execute: mutate,
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
					validUntilMs: 60_001,
				},
				payload: { value: 'same-meaning' },
			}),
		});
		const firstEnvelope = commandEnvelope({
			connectionId: '11111111-1111-4111-8111-111111111111',
			messageId: '22222222-2222-4222-8222-222222222222',
			sessionId: '33333333-3333-4333-8333-333333333333',
		});
		const retryEnvelope = commandEnvelope({
			connectionId: '44444444-4444-4444-8444-444444444444',
			messageId: '55555555-5555-4555-8555-555555555555',
			sessionId: '66666666-6666-4666-8666-666666666666',
		});

		await expect(
			dispatcher.dispatch({ envelope: firstEnvelope, payload: { value: 'same-meaning' } }),
		).resolves.toEqual({
			completedValue: { value: 'transport-neutral-result' },
			responseToMessageId: firstEnvelope.messageId,
		});
		await expect(
			dispatcher.dispatch({ envelope: retryEnvelope, payload: { value: 'same-meaning' } }),
		).resolves.toEqual({
			completedValue: { value: 'transport-neutral-result' },
			responseToMessageId: retryEnvelope.messageId,
		});
		expect(mutate).toHaveBeenCalledOnce();
	});

	it('turns a raw prepared-mutation failure into an unknown-side-effect tombstone', async () => {
		const ledger = createGatewaySemanticResultLedger({ gateway, nowMs: () => 1 });
		const dispatcher = createControlSessionDispatcher({ semanticLedger: ledger });
		const execute = vi.fn(async (_proof: GatewaySemanticExecutionProof) => {
			throw new Error('effect outcome is uncertain');
		});
		const buildHandlerFailureResult = vi.fn(() => ({ result: 'ordinary-handler-failure' }));
		const buildSemanticFailureResult = vi.fn((_context, decision) => ({
			result: decision.kind,
		}));
		dispatcher.register('gateway_control', {
			buildHandlerFailureResult,
			buildSemanticFailureResult,
			handle: async () => ({ result: 'non-semantic-handler-must-not-run' }),
			messageIdentity: () => ({ kind: 'command', operation: 'mutate' }),
			policyByOperation: { mutate: 'critical_idempotent' },
			prepareSemanticMutation: async ({ envelope }) => ({
				execute,
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
					validUntilMs: 60_001,
				},
				payload: { value: 'uncertain' },
			}),
		});
		const firstContext = {
			envelope: commandEnvelope({
				connectionId: '11111111-1111-4111-8111-111111111111',
				messageId: '22222222-2222-4222-8222-222222222222',
				sessionId: '33333333-3333-4333-8333-333333333333',
			}),
			payload: { value: 'uncertain' },
		};
		const retryContext = {
			envelope: commandEnvelope({
				connectionId: '44444444-4444-4444-8444-444444444444',
				messageId: '55555555-5555-4555-8555-555555555555',
				sessionId: '66666666-6666-4666-8666-666666666666',
			}),
			payload: { value: 'uncertain' },
		};

		await expect(dispatcher.dispatch(firstContext)).resolves.toEqual({
			result: 'unknown_side_effect',
		});
		await expect(dispatcher.dispatch(retryContext)).resolves.toEqual({
			result: 'unknown_side_effect',
		});

		expect(execute).toHaveBeenCalledOnce();
		expect(buildHandlerFailureResult).not.toHaveBeenCalled();
		expect(buildSemanticFailureResult).toHaveBeenCalledTimes(2);
	});

	it('executes with the request state captured before a newer session becomes current', async () => {
		const ledger = createGatewaySemanticResultLedger({ gateway, nowMs: () => 1 });
		const dispatcher = createControlSessionDispatcher({ semanticLedger: ledger });
		let currentSession = {
			attachmentGeneration: 1,
			processEpoch: 'process-a',
			sessionId: 'session-s1',
		};
		let observedProof: GatewaySemanticExecutionProof | undefined;
		const execute = vi.fn(
			async (proof: GatewaySemanticExecutionProof, capturedSession: typeof currentSession) => {
				observedProof = proof;
				return { capturedSession };
			},
		);
		dispatcher.register('gateway_control', {
			handle: async () => ({ currentSession }),
			messageIdentity: () => ({ kind: 'command', operation: 'mutate' }),
			policyByOperation: { mutate: 'critical_idempotent' },
			prepareSemanticMutation: async ({ envelope }) => {
				const capturedSession = structuredClone(currentSession);
				currentSession = {
					attachmentGeneration: 2,
					processEpoch: 'process-a',
					sessionId: 'session-s2',
				};
				return {
					execute: async (proof) => await execute(proof, capturedSession),
					identity: {
						commandId: envelope.commandId ?? envelope.messageId,
						gateway,
						idempotencyKey: envelope.idempotencyKey ?? envelope.messageId,
						operation: 'mutate',
						profile: {
							kind: 'active_use',
							leafGeneration: 'leaf-a',
							processEpoch: capturedSession.processEpoch,
							stablePrincipal: 'principal-a',
							useId: 'use-a',
						},
						target: 'lease-a/use-a',
						validUntilMs: 60_001,
					},
					payload: { value: 'captured-s1' },
				};
			},
		});

		await expect(
			dispatcher.dispatch({
				envelope: commandEnvelope({
					connectionId: '11111111-1111-4111-8111-111111111111',
					messageId: '22222222-2222-4222-8222-222222222222',
					sessionId: '33333333-3333-4333-8333-333333333333',
				}),
				payload: { value: 'captured-s1' },
			}),
		).resolves.toEqual({
			capturedSession: {
				attachmentGeneration: 1,
				processEpoch: 'process-a',
				sessionId: 'session-s1',
			},
		});

		expect(currentSession).toMatchObject({ attachmentGeneration: 2, sessionId: 'session-s2' });
		expect(observedProof?.identity.profile).toMatchObject({
			kind: 'active_use',
			processEpoch: 'process-a',
		});
		expect(execute).toHaveBeenCalledOnce();
	});
});
