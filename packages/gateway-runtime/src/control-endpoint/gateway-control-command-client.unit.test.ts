import type { GatewayControlRpcMessage } from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createGatewayRuntimeControlCommandClient } from './gateway-control-command-client.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlApplicationMessageIntent,
	GatewayControlEmitApplicationMessageOptions,
	GatewayControlService,
} from './gateway-control-endpoint-contracts.js';

const messageId = '11111111-1111-4111-8111-111111111111';
const responseMessageId = '22222222-2222-4222-8222-222222222222';
const commandId = '66666666-6666-4666-8666-666666666666';
const admissionPrincipal = 'a'.repeat(64);

const acceptedSession = Object.freeze({
	attachmentGeneration: 7,
	bootId: 'boot-7',
	connectionId: '33333333-3333-4333-8333-333333333333',
	controllerEpoch: 'controller-7',
	gatewayEpoch: 'gateway-7',
	generationId: 'generation-7',
	peerId: 'gateway-zone-a',
	processEpoch: 'process-7',
	sessionId: '44444444-4444-4444-8444-444444444444',
	zoneId: 'zone-a',
}) satisfies GatewayControlAcceptedSession;

type GatewayControlCommand = Extract<GatewayControlRpcMessage, { readonly kind: 'command' }>;

interface EmitCapture {
	intent: GatewayControlApplicationMessageIntent;
	options: GatewayControlEmitApplicationMessageOptions | undefined;
}

function controlPingCommand(): GatewayControlCommand {
	return {
		kind: 'command',
		operation: 'control_ping',
		payload: {},
	};
}

function leaseCreateCommand(): GatewayControlCommand {
	return {
		kind: 'command',
		operation: 'lease_create',
		payload: {
			callerContext: { callerContextId: '55555555-5555-4555-8555-555555555555' },
		},
	};
}

function controlPingResult(
	options: {
		readonly operation?: 'control_ping' | 'lease_get';
		readonly responseToMessageId?: string;
	} = {},
): unknown {
	return {
		kind: 'command_result',
		operation: options.operation ?? 'control_ping',
		payload: {
			responseToMessageId: options.responseToMessageId ?? messageId,
			result: 'ok',
		},
	};
}

function leaseCreateResult(): unknown {
	return {
		kind: 'command_result',
		operation: 'lease_create',
		payload: {
			leaseRejectionReason: 'runtime_not_ready',
			responseToMessageId: messageId,
			result: 'rejected',
		},
	};
}

function createControlService(
	emitApplicationMessage: GatewayControlService['emitApplicationMessage'],
): Pick<GatewayControlService, 'emitApplicationMessage'> {
	return { emitApplicationMessage };
}

describe('gateway runtime control command client', () => {
	it('builds one strict session-bound command envelope and returns the parsed correlated result', async () => {
		// Arrange
		let capture: EmitCapture | undefined;
		const emitApplicationMessage = vi.fn<GatewayControlService['emitApplicationMessage']>(
			async (intent, options) => {
				capture = { intent, options };
				const previewEnvelope = intent.buildEnvelope({
					acceptedSession,
					sequence: Number.MAX_SAFE_INTEGER,
				});
				const sentEnvelope = intent.buildEnvelope({ acceptedSession, sequence: 19 });
				expect(previewEnvelope.messageId).toBe(messageId);
				expect(sentEnvelope.messageId).toBe(messageId);
				return controlPingResult();
			},
		);
		const client = createGatewayRuntimeControlCommandClient({
			controlService: createControlService(emitApplicationMessage),
			createMessageId: () => messageId,
			now: () => 1_234,
		});

		// Act
		const result = await client.sendCommand({
			admissionPrincipal,
			idempotencyKey: 'ping-idempotency-7',
			message: controlPingCommand(),
		});

		// Assert
		expect(emitApplicationMessage).toHaveBeenCalledTimes(1);
		if (capture === undefined) throw new Error('Expected command emission to be captured.');
		expect(capture.intent.payload).toEqual(controlPingCommand());
		expect(capture.intent.domainMessage).toEqual({ kind: 'command', operation: 'control_ping' });
		expect(capture.options).toEqual({
			admissionPrincipal,
			commandResultTimeoutMs: 5_000,
		});
		expect(capture.intent.buildEnvelope({ acceptedSession, sequence: 23 })).toEqual({
			bootId: acceptedSession.bootId,
			connectionId: acceptedSession.connectionId,
			controllerEpoch: acceptedSession.controllerEpoch,
			createdAtMs: 1_234,
			deliveryPolicy: 'acked_idempotent',
			domain: 'gateway_control',
			idempotencyKey: 'ping-idempotency-7',
			kind: 'command',
			messageId,
			operation: 'control_ping',
			peerId: acceptedSession.peerId,
			protocolVersion: 1,
			sequence: 23,
			sessionId: acceptedSession.sessionId,
			zoneId: acceptedSession.zoneId,
		});
		expect(result.acceptedSession).toBe(acceptedSession);
		expect(result.messageId).toBe(messageId);
		expect(result.response).toEqual(controlPingResult());
	});

	it('derives lease-create delivery policy from idempotency material and uses its operation timeout', async () => {
		// Arrange
		const capturedEnvelopes: unknown[] = [];
		const capturedOptions: (GatewayControlEmitApplicationMessageOptions | undefined)[] = [];
		const emitApplicationMessage = vi.fn<GatewayControlService['emitApplicationMessage']>(
			async (intent, options) => {
				capturedOptions.push(options);
				capturedEnvelopes.push(intent.buildEnvelope({ acceptedSession, sequence: 1 }));
				return leaseCreateResult();
			},
		);
		const client = createGatewayRuntimeControlCommandClient({
			controlService: createControlService(emitApplicationMessage),
			createMessageId: () => messageId,
			now: () => 9,
		});

		// Act
		await client.sendCommand({ message: leaseCreateCommand() });
		await client.sendCommand({
			commandId,
			expiresAtMs: 500,
			idempotencyKey: 'lease-create-7',
			message: leaseCreateCommand(),
		});

		// Assert
		expect(capturedEnvelopes).toMatchObject([
			{ deliveryPolicy: 'single_use_critical' },
			{
				commandId,
				deliveryPolicy: 'critical_idempotent',
				expiresAtMs: 500,
				idempotencyKey: 'lease-create-7',
			},
		]);
		expect(capturedEnvelopes[0]).not.toHaveProperty('idempotencyKey');
		expect(capturedOptions).toEqual([
			{ commandResultTimeoutMs: 180_000 },
			{ commandResultTimeoutMs: 180_000 },
		]);
	});

	it.each([
		['malformed command result', { nope: true }],
		['wrong command-result operation', controlPingResult({ operation: 'lease_get' })],
		['wrong response correlation', controlPingResult({ responseToMessageId: responseMessageId })],
	])('fails closed on %s', async (_name, response) => {
		// Arrange
		const client = createGatewayRuntimeControlCommandClient({
			controlService: createControlService(async (intent) => {
				intent.buildEnvelope({ acceptedSession, sequence: 1 });
				return response;
			}),
			createMessageId: () => messageId,
			now: () => 9,
		});

		// Act / Assert
		await expect(client.sendCommand({ message: controlPingCommand() })).rejects.toThrow();
	});

	it('fails closed when one send is built against two accepted-session objects', async () => {
		// Arrange
		const replacementSession = Object.freeze({ ...acceptedSession });
		const client = createGatewayRuntimeControlCommandClient({
			controlService: createControlService(async (intent) => {
				intent.buildEnvelope({ acceptedSession, sequence: Number.MAX_SAFE_INTEGER });
				intent.buildEnvelope({ acceptedSession: replacementSession, sequence: 1 });
				return controlPingResult();
			}),
			createMessageId: () => messageId,
			now: () => 9,
		});

		// Act / Assert
		await expect(client.sendCommand({ message: controlPingCommand() })).rejects.toThrow(
			'accepted session changed',
		);
	});
});
