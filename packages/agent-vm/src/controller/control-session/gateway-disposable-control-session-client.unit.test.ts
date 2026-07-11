import { EventEmitter } from 'node:events';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
	type ControlMessageReceipt,
} from '@agent-vm/control-protocol-contracts';
import type { GatewayControlHello } from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGatewayControlProcessAdmissionCoordinator } from './gateway-control-process-admission-coordinator.js';
import {
	createGatewayDisposableControlSessionClient,
	type GatewayDisposableControlSocket,
} from './gateway-disposable-control-session-client.js';

interface FakeSocketControl {
	accept(): Promise<void>;
	disconnectFromPeer(): void;
	readonly acknowledgedEnvelopes: ControlEnvelope[];
	readonly acknowledgedPayloads: unknown[];
	readonly clientDisconnectCount: number;
	receive(envelope: ControlEnvelope, payload: unknown): Promise<ControlMessageReceipt | undefined>;
	receiveWithoutAcknowledge(envelope: ControlEnvelope, payload: unknown): void;
	readonly volatileMessageIds: string[];
	readonly volatileSequences: number[];
}

function deferred<TValue = void>(): {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
} {
	let resolvePromise!: (value: TValue) => void;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function flushImmediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function createFakeSocket(options: {
	readonly connectionId: string;
	readonly helloControllerEpoch?: string;
	readonly messageReceiptFailure?: Error;
	readonly sessionId: string;
}): {
	readonly control: FakeSocketControl;
	readonly socket: GatewayDisposableControlSocket;
} {
	const events = new EventEmitter();
	let connected = false;
	let hello: GatewayControlHello | undefined;
	let clientDisconnectCount = 0;
	const volatileMessageIds: string[] = [];
	const volatileSequences: number[] = [];
	const acknowledgedEnvelopes: ControlEnvelope[] = [];
	const acknowledgedPayloads: unknown[] = [];
	const managerEvents = new EventEmitter();
	const socket = {
		connect(): void {
			connected = true;
			events.emit('connect');
		},
		disconnect(): void {
			connected = false;
			clientDisconnectCount += 1;
		},
		get connected(): boolean {
			return connected;
		},
		io: {
			engine: { transport: { name: 'websocket' } },
			removeAllListeners: (): EventEmitter => managerEvents.removeAllListeners(),
		},
		on: events.on.bind(events),
		once: events.once.bind(events),
		removeAllListeners: events.removeAllListeners.bind(events),
		sendBuffer: [],
		timeout: () => ({
			emitWithAck: async (
				eventName: string,
				payload: unknown,
				domainPayload?: unknown,
			): Promise<unknown> => {
				if (eventName === 'control:hello') {
					hello = payload as GatewayControlHello;
					return {
						attachmentGeneration: hello.attachmentGeneration,
						connectionId: options.connectionId,
						controllerEpoch: options.helloControllerEpoch ?? hello.controllerEpoch,
						outcome: 'accepted',
						sessionId: options.sessionId,
					};
				}
				acknowledgedEnvelopes.push(payload as ControlEnvelope);
				acknowledgedPayloads.push(domainPayload);
				if (options.messageReceiptFailure !== undefined) {
					throw options.messageReceiptFailure;
				}
				return { received: true };
			},
		}),
		volatile: {
			emit: (_eventName: string, envelope: ControlEnvelope): void => {
				volatileMessageIds.push(envelope.messageId);
				volatileSequences.push(envelope.sequence);
			},
		},
	} as unknown as GatewayDisposableControlSocket;
	return {
		control: {
			acknowledgedEnvelopes,
			acknowledgedPayloads,
			async accept(): Promise<void> {
				await Promise.resolve();
				await Promise.resolve();
				expect(hello).toBeDefined();
			},
			disconnectFromPeer(): void {
				connected = false;
				events.emit('disconnect', 'transport close');
			},
			get clientDisconnectCount(): number {
				return clientDisconnectCount;
			},
			async receive(
				envelope: ControlEnvelope,
				payload: unknown,
			): Promise<ControlMessageReceipt | undefined> {
				return await new Promise<ControlMessageReceipt | undefined>((resolve) => {
					events.emit('control:message', envelope, payload, (receipt: ControlMessageReceipt) =>
						resolve(receipt),
					);
					setImmediate(() => resolve(undefined));
				});
			},
			receiveWithoutAcknowledge(envelope: ControlEnvelope, payload: unknown): void {
				events.emit('control:message', envelope, payload);
			},
			volatileMessageIds,
			volatileSequences,
		},
		socket,
	};
}

function latestWinsEnvelope(options: {
	readonly connectionId: string;
	readonly messageId: string;
	readonly sequence: number;
	readonly sessionId: string;
}): ControlEnvelope {
	return {
		bootId: 'process-a',
		connectionId: options.connectionId,
		controllerEpoch: 'controller-a',
		createdAtMs: 1,
		deliveryPolicy: 'latest_wins',
		domain: 'gateway_control',
		kind: 'heartbeat',
		messageId: options.messageId,
		peerId: 'gateway-zone-a',
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: options.sequence,
		sessionId: options.sessionId,
		zoneId: 'zone-a',
	};
}

function inboundEnvelope(options: {
	readonly connectionId: string;
	readonly kind: ControlEnvelope['kind'];
	readonly messageId: string;
	readonly operation?: string;
	readonly sequence: number;
	readonly sessionId: string;
}): ControlEnvelope {
	return {
		bootId: 'process-a',
		connectionId: options.connectionId,
		controllerEpoch: 'controller-a',
		createdAtMs: 1,
		deliveryPolicy: 'acked_idempotent',
		domain: 'gateway_control',
		kind: options.kind,
		messageId: options.messageId,
		...(options.operation === undefined ? {} : { operation: options.operation }),
		peerId: 'gateway-zone-a',
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: options.sequence,
		sessionId: options.sessionId,
		zoneId: 'zone-a',
	};
}

function leaseGetMessage(leaseId: string): unknown {
	return {
		kind: 'command',
		operation: 'lease_get',
		payload: {
			callerContext: { callerContextId: '77777777-7777-4777-8777-777777777777' },
			leaseId,
		},
	};
}

function leaseRenewMessage(leaseId: string): unknown {
	return {
		kind: 'command',
		operation: 'lease_renew',
		payload: {
			callerContext: { callerContextId: '77777777-7777-4777-8777-777777777777' },
			leaseId,
		},
	};
}

describe('Gateway disposable control session client', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps replacement S2 registered when stale S1 closes afterward', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		let attachmentGeneration = 0;
		const createClient = (
			socket: GatewayDisposableControlSocket,
		): ReturnType<typeof createGatewayDisposableControlSessionClient> =>
			createGatewayDisposableControlSessionClient({
				createSocket: () => socket,
				endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
				identity: {
					controllerEpoch: 'controller-a',
					gatewayEpoch: 'gateway-a',
					peerId: 'gateway-zone-a',
					processEpoch: 'process-a',
					zoneId: 'zone-a',
				},
				initialExtraHeaders: {},
				nextAttachmentGeneration: () => {
					attachmentGeneration += 1;
					return attachmentGeneration;
				},
				policyByKind: { heartbeat: 'critical_idempotent' },
				policyByOperation: {},
				processAdmissionCoordinator: coordinator,
				refreshExtraHeaders: async () => ({}),
			});
		const firstClient = createClient(first.socket);
		await firstClient.ready;
		const secondClient = createClient(second.socket);
		await secondClient.ready;
		expect(first.control.clientDisconnectCount).toBe(1);

		firstClient.close();
		await secondClient.emitApplicationMessage(
			{
				...latestWinsEnvelope({
					connectionId: '33333333-3333-4333-8333-333333333333',
					messageId: '55555555-5555-4555-8555-555555555555',
					sequence: 99,
					sessionId: '44444444-4444-4444-8444-444444444444',
				}),
				deliveryPolicy: 'critical_idempotent',
				operation: undefined,
			},
			{ kind: 'heartbeat' },
			{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
		);
		expect(second.control.acknowledgedEnvelopes).toMatchObject([{ sequence: 1 }]);
		secondClient.close();
	});

	it('fences a foreign-controller hello before ready or acceptance callback', async () => {
		vi.useFakeTimers();
		const foreign = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			helloControllerEpoch: 'controller-foreign',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const current = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [foreign.socket, current.socket];
		const acceptedControllerEpochs: string[] = [];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			onHelloResponse: (response) => acceptedControllerEpochs.push(response.controllerEpoch),
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(foreign.control.clientDisconnectCount).toBe(1);
		expect(acceptedControllerEpochs).toEqual([]);
		await vi.runOnlyPendingTimersAsync();
		await current.control.accept();
		await expect(client.ready).resolves.toMatchObject({ controllerEpoch: 'controller-a' });
		expect(acceptedControllerEpochs).toEqual(['controller-a']);
		client.close();
		vi.useRealTimers();
	});

	it('settles S1 work on close and prevents its late handler completion from emitting in S2', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		const heldHandler = deferred();
		const reconnectCallbacks: Array<() => void> = [];
		let attachmentGeneration = 0;
		let handlerStarted = false;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			dispatcher: {
				dispatch: async ({ envelope }) => {
					handlerStarted = true;
					await heldHandler.promise;
					return {
						kind: 'command_result',
						operation: 'control_ping',
						payload: { responseToMessageId: envelope.messageId, result: 'ok' },
					};
				},
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByOperation: { control_ping: 'acked_idempotent' },
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleImmediate: (callback) => callback(),
			scheduleReconnectTimer: (callback) => {
				reconnectCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		await client.ready;
		await first.control.receive(
			inboundEnvelope({
				connectionId: '11111111-1111-4111-8111-111111111111',
				kind: 'command',
				messageId: '55555555-5555-4555-8555-555555555555',
				operation: 'control_ping',
				sequence: 1,
				sessionId: '22222222-2222-4222-8222-222222222222',
			}),
			{ kind: 'command', operation: 'control_ping', payload: {} },
		);
		await Promise.resolve();
		expect(handlerStarted).toBe(true);
		first.control.disconnectFromPeer();
		expect(reconnectCallbacks).toHaveLength(1);
		reconnectCallbacks.shift()?.();
		await Promise.resolve();
		await second.control.accept();

		heldHandler.resolve(undefined);
		await Promise.resolve();
		expect(first.control.acknowledgedEnvelopes).toEqual([]);
		expect(second.control.acknowledgedEnvelopes).toEqual([]);
		expect(client.getDiagnostics()).toMatchObject({ accepted: true, attachmentGeneration: 2 });
		client.close();
	});

	it('dispatches each accepted attempt with its exact immutable attachment generation', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		const firstHandler = deferred();
		const firstContextSeen = deferred<{
			readonly attachmentGeneration?: number;
			readonly envelope: ControlEnvelope;
		}>();
		const secondContextSeen = deferred<{
			readonly attachmentGeneration?: number;
			readonly envelope: ControlEnvelope;
		}>();
		const reconnectCallbacks: Array<() => void> = [];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			dispatcher: {
				dispatch: async (context) => {
					if (context.envelope.messageId === '55555555-5555-4555-8555-555555555555') {
						firstContextSeen.resolve(context);
						await firstHandler.promise;
					} else {
						secondContextSeen.resolve(context);
					}
					return undefined;
				},
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByOperation: { control_ping: 'acked_idempotent' },
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleImmediate: (callback) => callback(),
			scheduleReconnectTimer: (callback) => {
				reconnectCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		await client.ready;
		expect(
			await first.control.receive(
				inboundEnvelope({
					connectionId: '11111111-1111-4111-8111-111111111111',
					kind: 'command',
					messageId: '55555555-5555-4555-8555-555555555555',
					operation: 'control_ping',
					sequence: 1,
					sessionId: '22222222-2222-4222-8222-222222222222',
				}),
				{ kind: 'command', operation: 'control_ping', payload: {} },
			),
		).toEqual({ received: true });
		const capturedFirstContext = await firstContextSeen.promise;

		expect(
			client.fenceCurrentSession({
				expectedAttachmentGeneration: 1,
				expectedSessionId: '22222222-2222-4222-8222-222222222222',
				reason: 'reliability_test_disconnect',
			}),
		).toMatchObject({ attachmentGeneration: 1, status: 'fenced' });
		expect(reconnectCallbacks).toHaveLength(1);
		reconnectCallbacks.shift()?.();
		await Promise.resolve();
		await second.control.accept();
		expect(
			await second.control.receive(
				inboundEnvelope({
					connectionId: '33333333-3333-4333-8333-333333333333',
					kind: 'command',
					messageId: '66666666-6666-4666-8666-666666666666',
					operation: 'control_ping',
					sequence: 1,
					sessionId: '44444444-4444-4444-8444-444444444444',
				}),
				{ kind: 'command', operation: 'control_ping', payload: {} },
			),
		).toEqual({ received: true });
		const capturedSecondContext = await secondContextSeen.promise;

		expect(capturedFirstContext.attachmentGeneration).toBe(1);
		expect(capturedSecondContext.attachmentGeneration).toBe(2);
		expect(capturedSecondContext.attachmentGeneration).toBeGreaterThan(
			capturedFirstContext.attachmentGeneration ?? Number.MAX_SAFE_INTEGER,
		);
		expect(capturedFirstContext).not.toBe(capturedSecondContext);
		expect(capturedFirstContext).toMatchObject({
			attachmentGeneration: 1,
			envelope: { sessionId: '22222222-2222-4222-8222-222222222222' },
		});
		expect(capturedSecondContext).toMatchObject({
			attachmentGeneration: 2,
			envelope: { sessionId: '44444444-4444-4444-8444-444444444444' },
		});

		firstHandler.resolve(undefined);
		await flushImmediate();
		expect(capturedFirstContext).toMatchObject({
			attachmentGeneration: 1,
			envelope: { sessionId: '22222222-2222-4222-8222-222222222222' },
		});
		client.close();
	});

	it('fences only the exact current session and reconnects with a fresh attachment', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		const reconnectCallbacks: Array<() => void> = [];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleReconnectTimer: (callback) => {
				reconnectCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		await client.ready;

		expect(
			client.fenceCurrentSession({
				expectedAttachmentGeneration: 2,
				expectedSessionId: '22222222-2222-4222-8222-222222222222',
				reason: 'reliability_test_disconnect',
			}),
		).toEqual({ status: 'not-current' });
		expect(first.control.clientDisconnectCount).toBe(0);
		expect(reconnectCallbacks).toEqual([]);

		expect(
			client.fenceCurrentSession({
				expectedAttachmentGeneration: 1,
				expectedSessionId: '22222222-2222-4222-8222-222222222222',
				reason: 'reliability_test_disconnect',
			}),
		).toEqual({
			attachmentGeneration: 1,
			sessionId: '22222222-2222-4222-8222-222222222222',
			status: 'fenced',
		});
		expect(first.control.clientDisconnectCount).toBe(1);
		expect(reconnectCallbacks).toHaveLength(1);

		reconnectCallbacks.shift()?.();
		await Promise.resolve();
		await second.control.accept();
		expect(client.getDiagnostics()).toMatchObject({
			accepted: true,
			attachmentGeneration: 2,
			lastHelloResponse: {
				sessionId: '44444444-4444-4444-8444-444444444444',
			},
		});
		client.close();
	});

	it('bounds authority handlers while an exact pending safety result still completes', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const fake = createFakeSocket({ connectionId, sessionId });
		const heldHandler = deferred();
		let handlerStarts = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => fake.socket,
			dispatcher: {
				dispatch: async () => {
					handlerStarts += 1;
					await heldHandler.promise;
					return undefined;
				},
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => 1,
			policyByOperation: {
				control_ping: 'acked_idempotent',
				lease_get: 'acked_idempotent',
			},
			refreshExtraHeaders: async () => ({}),
			resolveInboundStablePrincipal: () => 'a'.repeat(64),
		});
		await client.ready;
		const pingMessageId = '55555555-5555-4555-8555-555555555555';
		const pingPromise = client.emitApplicationMessage(
			{
				...inboundEnvelope({
					connectionId,
					kind: 'command',
					messageId: pingMessageId,
					operation: 'control_ping',
					sequence: 99,
					sessionId,
				}),
			},
			{ kind: 'command', operation: 'control_ping' },
			{ kind: 'command', operation: 'control_ping', payload: {} },
		);
		await flushImmediate();

		const authorityReceipts = await Promise.all(
			Array.from({ length: 6 }, (_, index) => index + 1).map((sequence) =>
				fake.control.receive(
					inboundEnvelope({
						connectionId,
						kind: 'command',
						messageId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
						operation: 'lease_get',
						sequence,
						sessionId,
					}),
					leaseGetMessage(`lease-${String(sequence)}`),
				),
			),
		);
		for (const receipt of authorityReceipts) {
			expect(receipt).toEqual({ received: true });
		}
		await flushImmediate();
		expect(handlerStarts).toBe(4);

		const resultReceipt = await fake.control.receive(
			inboundEnvelope({
				connectionId,
				kind: 'command_result',
				messageId: '66666666-6666-4666-8666-666666666666',
				operation: 'control_ping',
				sequence: 7,
				sessionId,
			}),
			{
				kind: 'command_result',
				operation: 'control_ping',
				payload: { responseToMessageId: pingMessageId, result: 'ok' },
			},
		);
		expect(resultReceipt).toEqual({ received: true });
		await expect(pingPromise).resolves.toMatchObject({ kind: 'command_result' });
		expect(handlerStarts).toBe(4);
		client.close();
		heldHandler.resolve(undefined);
	});

	it('acks a fail-closed authority refusal and accepts the next contiguous frame', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const fake = createFakeSocket({ connectionId, sessionId });
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => fake.socket,
			dispatcher: {
				dispatch: async () => undefined,
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => 1,
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: { lease_get: 'acked_idempotent' },
			refreshExtraHeaders: async () => ({}),
		});
		await client.ready;

		expect(
			await fake.control.receive(
				inboundEnvelope({
					connectionId,
					kind: 'command',
					messageId: '55555555-5555-4555-8555-555555555555',
					operation: 'lease_get',
					sequence: 1,
					sessionId,
				}),
				leaseGetMessage('lease-refused'),
			),
		).toEqual({ received: true });
		expect(
			await fake.control.receive(
				{
					...inboundEnvelope({
						connectionId,
						kind: 'heartbeat',
						messageId: '66666666-6666-4666-8666-666666666666',
						sequence: 2,
						sessionId,
					}),
					deliveryPolicy: 'critical_idempotent',
				},
				{ kind: 'heartbeat', payload: { observedAtMs: 2 } },
			),
		).toEqual({ received: true });
		await flushImmediate();
		expect(fake.control.clientDisconnectCount).toBe(0);
		expect(fake.control.acknowledgedEnvelopes[0]?.sequence).toBe(1);
		client.close();
	});

	it('settles a replaced inbound command with a typed superseded result', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const fake = createFakeSocket({ connectionId, sessionId });
		const immediateCallbacks: Array<() => void> = [];
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => fake.socket,
			dispatcher: {
				dispatch: async () => undefined,
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => 1,
			policyByOperation: { lease_renew: 'single_use_critical' },
			refreshExtraHeaders: async () => ({}),
			resolveInboundStablePrincipal: () => 'a'.repeat(64),
			scheduleImmediate: (callback) => immediateCallbacks.push(callback),
		});
		await client.ready;
		const messageIds = [
			'55555555-5555-4555-8555-555555555555',
			'66666666-6666-4666-8666-666666666666',
		] as const;
		const receipts = await Promise.all(
			messageIds.map((messageId, index) =>
				fake.control.receive(
					{
						...inboundEnvelope({
							connectionId,
							kind: 'command',
							messageId,
							operation: 'lease_renew',
							sequence: index + 1,
							sessionId,
						}),
						deliveryPolicy: 'single_use_critical',
					},
					leaseRenewMessage('lease-a'),
				),
			),
		);
		expect(receipts).toEqual([{ received: true }, { received: true }]);

		for (const callback of immediateCallbacks.splice(0)) {
			callback();
		}
		await Promise.resolve();
		for (const callback of immediateCallbacks.splice(0)) {
			callback();
		}
		await Promise.resolve();
		expect(fake.control.acknowledgedPayloads).toContainEqual({
			kind: 'command_result',
			operation: 'lease_renew',
			payload: {
				error: {
					errorClass: 'gateway_control_admission_superseded',
					retryable: true,
					safeMessage: 'Gateway control command was superseded before execution.',
				},
				responseToMessageId: messageIds[0],
				result: 'failed',
			},
		});
		client.close();
	});

	it('fences an exact-session command result without a matching pending command', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		const reconnectCallbacks: Array<() => void> = [];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByOperation: { control_ping: 'acked_idempotent' },
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleReconnectTimer: (callback) => {
				reconnectCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		await client.ready;

		await first.control.receive(
			inboundEnvelope({
				connectionId: '11111111-1111-4111-8111-111111111111',
				kind: 'command_result',
				messageId: '55555555-5555-4555-8555-555555555555',
				operation: 'control_ping',
				sequence: 1,
				sessionId: '22222222-2222-4222-8222-222222222222',
			}),
			{
				kind: 'command_result',
				operation: 'control_ping',
				payload: {
					responseToMessageId: '66666666-6666-4666-8666-666666666666',
					result: 'ok',
				},
			},
		);

		expect(first.control.clientDisconnectCount).toBe(1);
		expect(reconnectCallbacks).toHaveLength(1);
		reconnectCallbacks.shift()?.();
		await Promise.resolve();
		await second.control.accept();
		expect(client.getDiagnostics()).toMatchObject({ accepted: true, attachmentGeneration: 2 });
		client.close();
	});

	it('fences a frame carrying a different process epoch before admission', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
		});
		await client.ready;
		await first.control.receive(
			{
				...inboundEnvelope({
					connectionId: '11111111-1111-4111-8111-111111111111',
					kind: 'heartbeat',
					messageId: '55555555-5555-4555-8555-555555555555',
					sequence: 1,
					sessionId: '22222222-2222-4222-8222-222222222222',
				}),
				bootId: 'process-stale',
				deliveryPolicy: 'critical_idempotent',
			},
			{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
		);

		expect(first.control.clientDisconnectCount).toBe(1);
		client.close();
	});

	it('fences a valid inbound frame without an acknowledgement callback before dispatch', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		let attachmentGeneration = 0;
		let dispatchCount = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			dispatcher: {
				dispatch: async () => {
					dispatchCount += 1;
					return undefined;
				},
				register: () => undefined,
				validate: () => undefined,
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
		});
		await client.ready;
		first.control.receiveWithoutAcknowledge(
			{
				...inboundEnvelope({
					connectionId: '11111111-1111-4111-8111-111111111111',
					kind: 'heartbeat',
					messageId: '55555555-5555-4555-8555-555555555555',
					sequence: 1,
					sessionId: '22222222-2222-4222-8222-222222222222',
				}),
				deliveryPolicy: 'critical_idempotent',
			},
			{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
		);
		await flushImmediate();

		expect(dispatchCount).toBe(0);
		expect(first.control.clientDisconnectCount).toBe(1);
		client.close();
	});

	it('allocates the attachment sequence only when admitted egress actually sends', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const fake = createFakeSocket({ connectionId, sessionId });
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => fake.socket,
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => 1,
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: {},
			refreshExtraHeaders: async () => ({}),
		});
		await client.ready;
		await fake.control.accept();

		await client.emitApplicationMessage(
			{
				...latestWinsEnvelope({
					connectionId,
					messageId: '55555555-5555-4555-8555-555555555555',
					sequence: 73,
					sessionId,
				}),
				deliveryPolicy: 'critical_idempotent',
				operation: undefined,
			},
			{ kind: 'heartbeat' },
			{
				kind: 'heartbeat',
				payload: { observedAtMs: 1 },
			},
		);

		expect(fake.control.acknowledgedEnvelopes).toHaveLength(1);
		expect(fake.control.acknowledgedEnvelopes[0]?.sequence).toBe(1);
		client.close();
	});

	it('fences the attempt when a coalesced sequenced frame is not receipted', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			messageReceiptFailure: new Error('receipt transport lost'),
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByKind: { heartbeat: 'latest_wins' },
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
		});
		await client.ready;

		await client.emitApplicationMessage(
			latestWinsEnvelope({
				connectionId: '11111111-1111-4111-8111-111111111111',
				messageId: '55555555-5555-4555-8555-555555555555',
				sequence: 73,
				sessionId: '22222222-2222-4222-8222-222222222222',
			}),
			{ kind: 'heartbeat' },
			{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
		);
		await flushImmediate();

		expect(first.control.acknowledgedEnvelopes).toMatchObject([
			{ messageId: '55555555-5555-4555-8555-555555555555', sequence: 1 },
		]);
		expect(first.control.volatileMessageIds).toEqual([]);
		expect(first.control.clientDisconnectCount).toBe(1);
		client.close();
	});

	it('reuses one immutable pending result for concurrent exact message retries', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const messageId = '55555555-5555-4555-8555-555555555555';
		const fake = createFakeSocket({ connectionId, sessionId });
		const client = createGatewayDisposableControlSessionClient({
			commandResultTimeoutMsByOperation: { control_ping: 1_000 },
			createSocket: () => fake.socket,
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => 1,
			policyByOperation: { control_ping: 'acked_idempotent' },
			refreshExtraHeaders: async () => ({}),
		});
		const hello = await client.ready;
		const commandEnvelope = {
			...inboundEnvelope({
				connectionId,
				kind: 'command',
				messageId,
				operation: 'control_ping',
				sequence: 99,
				sessionId: hello.sessionId,
			}),
		} satisfies ControlEnvelope;
		const firstResult = client.emitApplicationMessage(
			commandEnvelope,
			{ kind: 'command', operation: 'control_ping' },
			{ kind: 'command', operation: 'control_ping', payload: {} },
		);
		await flushImmediate();
		const retriedResult = client.emitApplicationMessage(
			commandEnvelope,
			{ kind: 'command', operation: 'control_ping' },
			{ kind: 'command', operation: 'control_ping', payload: {} },
		);
		await flushImmediate();
		expect(fake.control.acknowledgedEnvelopes).toMatchObject([
			{ messageId, sequence: 1 },
			{ messageId, sequence: 2 },
		]);

		await fake.control.receive(
			inboundEnvelope({
				connectionId,
				kind: 'command_result',
				messageId: '66666666-6666-4666-8666-666666666666',
				operation: 'control_ping',
				sequence: 1,
				sessionId,
			}),
			{
				kind: 'command_result',
				operation: 'control_ping',
				payload: { responseToMessageId: messageId, result: 'ok' },
			},
		);
		await expect(Promise.all([firstResult, retriedResult])).resolves.toMatchObject([
			{ kind: 'command_result' },
			{ kind: 'command_result' },
		]);
		client.close();
	});

	it('fences a concurrent message-id retry that changes operation identity', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const messageId = '55555555-5555-4555-8555-555555555555';
		const first = createFakeSocket({ connectionId, sessionId });
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			commandResultTimeoutMsByOperation: { control_ping: 1_000 },
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByOperation: {
				control_ping: 'acked_idempotent',
				recovery_command: 'critical_idempotent',
			},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
		});
		await client.ready;
		const firstResult = client
			.emitApplicationMessage(
				inboundEnvelope({
					connectionId,
					kind: 'command',
					messageId,
					operation: 'control_ping',
					sequence: 1,
					sessionId,
				}),
				{ kind: 'command', operation: 'control_ping' },
				{ kind: 'command', operation: 'control_ping', payload: {} },
			)
			.catch((error: unknown) => error);
		await flushImmediate();
		await expect(
			client.emitApplicationMessage(
				{
					...inboundEnvelope({
						connectionId,
						kind: 'command',
						messageId,
						operation: 'recovery_command',
						sequence: 2,
						sessionId,
					}),
					deliveryPolicy: 'critical_idempotent',
				},
				{ kind: 'command', operation: 'recovery_command' },
				{
					kind: 'command',
					operation: 'recovery_command',
					payload: { action: 'refresh_runtime_status' },
				},
			),
		).rejects.toThrow('gateway control pending result identity collision');
		await firstResult;
		expect(first.control.acknowledgedEnvelopes).toHaveLength(1);
		expect(first.control.clientDisconnectCount).toBe(1);
		client.close();
	});

	it('does not let an old-attempt latest-wins callback suppress or clear the new attempt', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		const immediateCallbacks: Array<() => void> = [];
		const reconnectCallbacks: Array<() => void> = [];
		let attachmentGeneration = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			policyByKind: { heartbeat: 'latest_wins' },
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleImmediate: (callback) => immediateCallbacks.push(callback),
			scheduleReconnectTimer: (callback) => {
				reconnectCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		await client.ready;
		await first.control.accept();
		await client.emitApplicationMessage(
			latestWinsEnvelope({
				connectionId: '11111111-1111-4111-8111-111111111111',
				messageId: '55555555-5555-4555-8555-555555555555',
				sequence: 1,
				sessionId: '22222222-2222-4222-8222-222222222222',
			}),
			{ kind: 'heartbeat' },
			{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
		);
		first.control.disconnectFromPeer();
		expect(reconnectCallbacks).toHaveLength(1);
		reconnectCallbacks.shift()?.();
		await Promise.resolve();
		await second.control.accept();
		await client.emitApplicationMessage(
			latestWinsEnvelope({
				connectionId: '33333333-3333-4333-8333-333333333333',
				messageId: '66666666-6666-4666-8666-666666666666',
				sequence: 1,
				sessionId: '44444444-4444-4444-8444-444444444444',
			}),
			{ kind: 'heartbeat' },
			{ kind: 'heartbeat', payload: { observedAtMs: 2 } },
		);

		expect(immediateCallbacks).toHaveLength(2);
		immediateCallbacks[0]?.();
		immediateCallbacks[1]?.();
		await Promise.resolve();
		expect(first.control.volatileMessageIds).toEqual([]);
		expect(second.control.volatileMessageIds).toEqual([]);
		expect(second.control.acknowledgedEnvelopes).toMatchObject([
			{ messageId: '66666666-6666-4666-8666-666666666666', sequence: 1 },
		]);
		client.close();
	});

	it('replaces queued liveness without consuming an outbound sequence', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const fake = createFakeSocket({ connectionId, sessionId });
		const immediateCallbacks: Array<() => void> = [];
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => fake.socket,
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => 1,
			policyByKind: { heartbeat: 'latest_wins' },
			policyByOperation: {},
			refreshExtraHeaders: async () => ({}),
			scheduleImmediate: (callback) => immediateCallbacks.push(callback),
		});
		await client.ready;

		await client.emitApplicationMessage(
			latestWinsEnvelope({
				connectionId,
				messageId: '55555555-5555-4555-8555-555555555555',
				sequence: 20,
				sessionId,
			}),
			{ kind: 'heartbeat' },
			{ kind: 'heartbeat', payload: { observedAtMs: 1 } },
		);
		await client.emitApplicationMessage(
			latestWinsEnvelope({
				connectionId,
				messageId: '66666666-6666-4666-8666-666666666666',
				sequence: 40,
				sessionId,
			}),
			{ kind: 'heartbeat' },
			{ kind: 'heartbeat', payload: { observedAtMs: 2 } },
		);

		expect(immediateCallbacks).toHaveLength(1);
		immediateCallbacks[0]?.();
		await Promise.resolve();
		expect(fake.control.volatileMessageIds).toEqual([]);
		expect(fake.control.volatileSequences).toEqual([]);
		expect(fake.control.acknowledgedEnvelopes).toMatchObject([
			{
				messageId: '66666666-6666-4666-8666-666666666666',
				sequence: 1,
			},
		]);
		client.close();
	});
});
