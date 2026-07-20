import { EventEmitter } from 'node:events';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
	type ControlMessageReceipt,
} from '@agent-vm/control-protocol-contracts';
import type {
	GatewayControlHello,
	GatewayControlHelloResponse,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
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

type ExpectedGatewayControlAttemptOutcome =
	| {
			readonly attachmentGeneration: number;
			readonly kind: 'connect_error';
	  }
	| {
			readonly attachmentGeneration: number;
			readonly kind: 'hello_response';
			readonly outcome: GatewayControlHelloResponse['outcome'];
	  };

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
	readonly connectError?: Error;
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
			if (options.connectError !== undefined) {
				events.emit('connect_error', options.connectError);
				return;
			}
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

async function receiveHeartbeat(options: {
	readonly connectionId: string;
	readonly control: FakeSocketControl;
	readonly messageId: string;
	readonly observedAtMs: number;
	readonly sequence: number;
	readonly sessionId: string;
}): Promise<void> {
	expect(
		await options.control.receive(
			{
				...inboundEnvelope({
					connectionId: options.connectionId,
					kind: 'heartbeat',
					messageId: options.messageId,
					sequence: options.sequence,
					sessionId: options.sessionId,
				}),
				deliveryPolicy: 'critical_idempotent',
			},
			{ kind: 'heartbeat', payload: { observedAtMs: options.observedAtMs } },
		),
	).toEqual({ received: true });
	await Promise.resolve();
}

function createFakeReconnectTimerQueue(): {
	readonly schedule: (callback: () => void, delayMs: number) => { cancel(): void; unref(): void };
	takeNextActive(): (() => void) | undefined;
} {
	const records: Array<{
		readonly callback: () => void;
		cancelled: boolean;
		readonly delayMs: number;
	}> = [];
	return {
		schedule: (callback, delayMs) => {
			const record = { callback, cancelled: false, delayMs };
			records.push(record);
			return {
				cancel: () => {
					record.cancelled = true;
				},
				unref: () => undefined,
			};
		},
		takeNextActive: () => {
			for (;;) {
				const record = records.shift();
				if (record === undefined) {
					return undefined;
				}
				if (!record.cancelled) {
					return record.callback;
				}
			}
		},
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

function toolPortalControllerHostActionMessage(): unknown {
	return {
		kind: 'command',
		operation: 'tool_portal_controller_host_action',
		payload: {
			actionId: 'workspace_git_push',
			callerContext: { callerContextId: '77777777-7777-4777-8777-777777777777' },
			correlation: {
				capability: {
					name: 'workspace_git_push',
					namespace: 'controller_host_action',
				},
			},
			expectedHead: '0123456789abcdef0123456789abcdef01234567',
		},
	};
}

describe('Gateway disposable control session client', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('reports one sanitized connect error outcome for an attachment attempt', async () => {
		const failed = createFakeSocket({
			connectError: new Error('Bearer private-credential must never escape'),
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const attemptOutcomes: ExpectedGatewayControlAttemptOutcome[] = [];
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => failed.socket,
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: { authorization: 'Bearer private-credential' },
			nextAttachmentGeneration: () => 7,
			onAttemptOutcome: (outcome: ExpectedGatewayControlAttemptOutcome) => {
				attemptOutcomes.push(outcome);
			},
			policyByOperation: {},
			refreshExtraHeaders: async () => ({ authorization: 'Bearer private-credential' }),
			scheduleReconnectTimer: () => ({ cancel: () => undefined }),
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(attemptOutcomes).toEqual([
			{
				attachmentGeneration: 7,
				kind: 'connect_error',
			},
		]);
		expect(JSON.stringify(attemptOutcomes)).not.toContain('private-credential');
		client.close();
	});

	it('reports a parsed hello outcome without letting observer failure affect readiness', async () => {
		const accepted = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const attemptOutcomes: ExpectedGatewayControlAttemptOutcome[] = [];
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => accepted.socket,
			endpoint: { host: '127.0.0.1', path: '/control', port: 1 },
			identity: {
				controllerEpoch: 'controller-a',
				gatewayEpoch: 'gateway-a',
				peerId: 'gateway-zone-a',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
			initialExtraHeaders: {},
			nextAttachmentGeneration: () => 11,
			onAttemptOutcome: (outcome: ExpectedGatewayControlAttemptOutcome) => {
				attemptOutcomes.push(outcome);
				throw new Error('attempt observer failed');
			},
			policyByOperation: {},
			refreshExtraHeaders: async () => ({}),
		});

		await expect(client.ready).resolves.toMatchObject({ outcome: 'accepted' });
		expect(attemptOutcomes).toEqual([
			{
				attachmentGeneration: 11,
				kind: 'hello_response',
				outcome: 'accepted',
			},
		]);
		client.close();
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
		const attachmentGapTransitions: unknown[] = [];
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
			now: () => 1_000,
			onAttachmentGap: (transition: unknown) => {
				attachmentGapTransitions.push(transition);
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
		expect(attachmentGapTransitions).toEqual([]);
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
		expect(attachmentGapTransitions).toEqual([
			{
				attachmentGeneration: 1,
				gapReason: 'reliability_test_disconnect',
				gatewayEpoch: 'gateway-a',
				kind: 'attachment_gap',
				observedAtMs: 1_000,
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
		]);
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

	it('reports max-attempt reconnect exhaustion exactly once for one accepted-session gap', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const failingReconnect = createFakeSocket({
			connectError: new Error('reconnect authentication unavailable'),
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const reconnectCallbacks: Array<() => void> = [];
		const reconnectExhaustedTransitions: unknown[] = [];
		let socketCreateCount = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				socketCreateCount += 1;
				return socketCreateCount === 1 ? first.socket : failingReconnect.socket;
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
			onReconnectExhausted: (transition: unknown) => {
				reconnectExhaustedTransitions.push(transition);
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

		first.control.disconnectFromPeer();
		let lastReconnectCallback: (() => void) | undefined;
		/* oxlint-disable no-await-in-loop -- each failed attempt synchronously schedules the next bounded reconnect */
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const reconnectCallback = reconnectCallbacks.shift();
			expect(reconnectCallback).toBeDefined();
			lastReconnectCallback = reconnectCallback;
			reconnectCallback?.();
			await flushImmediate();
		}
		/* oxlint-enable no-await-in-loop */

		expect(reconnectExhaustedTransitions).toEqual([
			{
				attempts: 16,
				exhaustionReason: 'attempt_limit',
				gapReason: 'gateway control attachment disconnected',
				gatewayEpoch: 'gateway-a',
				kind: 'reconnect_exhausted',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
		]);
		expect(client.getDiagnostics()).toMatchObject({ reconnectExhausted: true });

		lastReconnectCallback?.();
		await Promise.resolve();
		expect(reconnectExhaustedTransitions).toHaveLength(1);
		client.close();
	});

	it('keeps the original reconnect deadline after S2 accepts with fewer than three heartbeats', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		const reconnectTimers = createFakeReconnectTimerQueue();
		const reconnectExhaustedTransitions: unknown[] = [];
		let attachmentGeneration = 0;
		let nowMs = 1_000;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
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
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			now: () => nowMs,
			onReconnectExhausted: (transition: unknown) => {
				reconnectExhaustedTransitions.push(transition);
			},
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleReconnectTimer: reconnectTimers.schedule,
		});
		await client.ready;

		nowMs = 1_000;
		first.control.disconnectFromPeer();
		reconnectTimers.takeNextActive()?.();
		await Promise.resolve();
		await second.control.accept();
		expect(client.getDiagnostics()).toMatchObject({ reconnectAttempts: 1 });
		await receiveHeartbeat({
			connectionId: '33333333-3333-4333-8333-333333333333',
			control: second.control,
			messageId: '55555555-5555-4555-8555-555555555555',
			observedAtMs: 2_000,
			sequence: 1,
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		await receiveHeartbeat({
			connectionId: '33333333-3333-4333-8333-333333333333',
			control: second.control,
			messageId: '66666666-6666-4666-8666-666666666666',
			observedAtMs: 3_000,
			sequence: 2,
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		expect(client.getDiagnostics()).toMatchObject({
			accepted: true,
			attachmentGeneration: 2,
			reconnectAttempts: 1,
			reconnectExhausted: false,
		});

		nowMs = 61_000;
		const originalGapDeadlineCallback = reconnectTimers.takeNextActive();
		expect(originalGapDeadlineCallback).toBeDefined();
		originalGapDeadlineCallback?.();
		await Promise.resolve();

		expect(reconnectExhaustedTransitions).toEqual([
			{
				attempts: 1,
				exhaustionReason: 'deadline',
				gapReason: 'gateway control attachment disconnected',
				gatewayEpoch: 'gateway-a',
				kind: 'reconnect_exhausted',
				processEpoch: 'process-a',
				zoneId: 'zone-a',
			},
		]);

		originalGapDeadlineCallback?.();
		await Promise.resolve();
		expect(reconnectExhaustedTransitions).toHaveLength(1);
		client.close();
	});

	it('does not reset the reconnect episode when three S2 heartbeats arrive before 30 seconds', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const sockets = [first.socket, second.socket];
		const reconnectTimers = createFakeReconnectTimerQueue();
		const reconnectExhaustedTransitions: unknown[] = [];
		let attachmentGeneration = 0;
		let nowMs = 1_000;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					throw new Error('unexpected socket attempt');
				}
				return socket;
			},
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
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			now: () => nowMs,
			onReconnectExhausted: (transition: unknown) => {
				reconnectExhaustedTransitions.push(transition);
			},
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleReconnectTimer: reconnectTimers.schedule,
		});
		await client.ready;

		first.control.disconnectFromPeer();
		reconnectTimers.takeNextActive()?.();
		await Promise.resolve();
		nowMs = 2_000;
		await second.control.accept();
		/* oxlint-disable no-await-in-loop -- heartbeat sequence and injected clock must advance serially */
		for (const [index, messageId] of [
			'55555555-5555-4555-8555-555555555555',
			'66666666-6666-4666-8666-666666666666',
			'77777777-7777-4777-8777-777777777777',
		].entries()) {
			nowMs = 3_000 + index * 1_000;
			await receiveHeartbeat({
				connectionId: '33333333-3333-4333-8333-333333333333',
				control: second.control,
				messageId,
				observedAtMs: nowMs,
				sequence: index + 1,
				sessionId: '44444444-4444-4444-8444-444444444444',
			});
		}
		/* oxlint-enable no-await-in-loop */
		expect(client.getDiagnostics()).toMatchObject({ reconnectAttempts: 1 });

		nowMs = 61_000;
		const originalGapDeadlineCallback = reconnectTimers.takeNextActive();
		expect(originalGapDeadlineCallback).toBeDefined();
		originalGapDeadlineCallback?.();
		await Promise.resolve();
		expect(reconnectExhaustedTransitions).toMatchObject([
			{
				attempts: 1,
				exhaustionReason: 'deadline',
				gapReason: 'gateway control attachment disconnected',
			},
		]);
		client.close();
	});

	it('resets the reconnect episode only after three heartbeats and 30 seconds of S2 stability', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const failingThird = createFakeSocket({
			connectError: new Error('third attachment unavailable'),
			connectionId: '55555555-5555-4555-8555-555555555555',
			sessionId: '66666666-6666-4666-8666-666666666666',
		});
		const sockets = [first.socket, second.socket, failingThird.socket];
		const reconnectTimers = createFakeReconnectTimerQueue();
		const reconnectExhaustedTransitions: unknown[] = [];
		let attachmentGeneration = 0;
		let nowMs = 1_000;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				const socket = sockets.shift();
				if (socket === undefined) {
					return failingThird.socket;
				}
				return socket;
			},
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
			nextAttachmentGeneration: () => {
				attachmentGeneration += 1;
				return attachmentGeneration;
			},
			now: () => nowMs,
			onReconnectExhausted: (transition: unknown) => {
				reconnectExhaustedTransitions.push(transition);
			},
			policyByKind: { heartbeat: 'critical_idempotent' },
			policyByOperation: {},
			reconnectJitterRandom: () => 0.5,
			refreshExtraHeaders: async () => ({}),
			scheduleImmediate: (callback) => callback(),
			scheduleReconnectTimer: reconnectTimers.schedule,
		});
		await client.ready;

		first.control.disconnectFromPeer();
		reconnectTimers.takeNextActive()?.();
		await Promise.resolve();
		nowMs = 2_000;
		await second.control.accept();
		/* oxlint-disable no-await-in-loop -- heartbeat sequence and injected clock must advance serially */
		for (const [index, messageId] of [
			'77777777-7777-4777-8777-777777777777',
			'88888888-8888-4888-8888-888888888888',
			'99999999-9999-4999-8999-999999999999',
		].entries()) {
			nowMs = 3_000 + index * 1_000;
			await receiveHeartbeat({
				connectionId: '33333333-3333-4333-8333-333333333333',
				control: second.control,
				messageId,
				observedAtMs: nowMs,
				sequence: index + 1,
				sessionId: '44444444-4444-4444-8444-444444444444',
			});
		}
		/* oxlint-enable no-await-in-loop */
		expect(client.getDiagnostics()).toMatchObject({ reconnectAttempts: 1 });

		nowMs = 32_000;
		await receiveHeartbeat({
			connectionId: '33333333-3333-4333-8333-333333333333',
			control: second.control,
			messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			observedAtMs: nowMs,
			sequence: 4,
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		expect(client.getDiagnostics()).toMatchObject({
			reconnectAttempts: 0,
			reconnectExhausted: false,
		});

		nowMs = 40_000;
		second.control.disconnectFromPeer();
		const firstThirdGapCallback = reconnectTimers.takeNextActive();
		nowMs = 70_000;
		firstThirdGapCallback?.();
		await Promise.resolve();
		const secondThirdGapCallback = reconnectTimers.takeNextActive();
		nowMs = 100_000;
		secondThirdGapCallback?.();
		await Promise.resolve();
		expect(reconnectExhaustedTransitions).toMatchObject([
			{
				attempts: 1,
				exhaustionReason: 'deadline',
				gapReason: 'gateway control attachment disconnected',
			},
		]);
		client.close();
	});

	it('does not report reconnect exhaustion after the client is closed', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const reconnectCallbacks: Array<() => void> = [];
		const reconnectExhaustedTransitions: unknown[] = [];
		let nowMs = 1_000;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => first.socket,
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
			now: () => nowMs,
			onReconnectExhausted: (transition: unknown) => {
				reconnectExhaustedTransitions.push(transition);
			},
			policyByOperation: {},
			refreshExtraHeaders: async () => ({}),
			scheduleReconnectTimer: (callback) => {
				reconnectCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		await client.ready;

		first.control.disconnectFromPeer();
		const reconnectCallback = reconnectCallbacks.shift();
		client.close();
		nowMs = 61_000;
		reconnectCallback?.();
		await Promise.resolve();

		expect(reconnectExhaustedTransitions).toEqual([]);
	});

	it('does not create a reconnect socket when closed during header refresh', async () => {
		const first = createFakeSocket({
			connectionId: '11111111-1111-4111-8111-111111111111',
			sessionId: '22222222-2222-4222-8222-222222222222',
		});
		const second = createFakeSocket({
			connectError: new Error('reconnect authentication expired'),
			connectionId: '33333333-3333-4333-8333-333333333333',
			sessionId: '44444444-4444-4444-8444-444444444444',
		});
		const third = createFakeSocket({
			connectionId: '55555555-5555-4555-8555-555555555555',
			sessionId: '66666666-6666-4666-8666-666666666666',
		});
		const reconnectHeaders = deferred<Readonly<Record<string, string>>>();
		const reconnectCallbacks: Array<() => void> = [];
		const helloResponses: unknown[] = [];
		const attachmentGaps: unknown[] = [];
		const reconnectExhaustedTransitions: unknown[] = [];
		let socketCreateCount = 0;
		let refreshCount = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => {
				socketCreateCount += 1;
				return socketCreateCount === 1
					? first.socket
					: socketCreateCount === 2
						? second.socket
						: third.socket;
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
			nextAttachmentGeneration: () => socketCreateCount + 1,
			onAttachmentGap: (transition: unknown) => {
				attachmentGaps.push(transition);
			},
			onHelloResponse: (response: unknown) => {
				helloResponses.push(response);
			},
			onReconnectExhausted: (transition: unknown) => {
				reconnectExhaustedTransitions.push(transition);
			},
			policyByOperation: {},
			refreshExtraHeaders: () => {
				refreshCount += 1;
				return reconnectHeaders.promise;
			},
			scheduleReconnectTimer: (callback) => {
				reconnectCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		await client.ready;

		first.control.disconnectFromPeer();
		expect(reconnectCallbacks).toHaveLength(1);
		reconnectCallbacks.shift()?.();
		await Promise.resolve();
		expect(reconnectCallbacks).toHaveLength(1);
		reconnectCallbacks.shift()?.();
		expect(refreshCount).toBe(1);
		expect(socketCreateCount).toBe(2);
		const callbackCountsBeforeClose = {
			attachmentGaps: attachmentGaps.length,
			helloResponses: helloResponses.length,
			reconnectExhaustedTransitions: reconnectExhaustedTransitions.length,
		};

		client.close();
		reconnectHeaders.resolve({ authorization: 'refreshed' });
		await flushImmediate();

		expect(socketCreateCount).toBe(2);
		expect(third.control.clientDisconnectCount).toBe(0);
		expect({
			attachmentGaps: attachmentGaps.length,
			helloResponses: helloResponses.length,
			reconnectExhaustedTransitions: reconnectExhaustedTransitions.length,
		}).toEqual(callbackCountsBeforeClose);
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
			resolveInboundStablePrincipal: () => ({
				stablePrincipal: 'a'.repeat(64),
				status: 'accepted',
			}),
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

	it('represents an unavailable resolver as a fail-closed refusal and accepts the next frame', async () => {
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
		expect(fake.control.acknowledgedPayloads).toContainEqual({
			kind: 'command_result',
			operation: 'lease_get',
			payload: {
				error: {
					errorClass: 'gateway_control_admission_refused',
					retryable: true,
					safeMessage: 'Gateway control command was refused before execution.',
				},
				responseToMessageId: '55555555-5555-4555-8555-555555555555',
				result: 'failed',
			},
		});
		client.close();
	});

	it('keeps a rejected Tool Portal principal distinct while preserving generic admission refusal', async () => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const fake = createFakeSocket({ connectionId, sessionId });
		let dispatchCount = 0;
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => fake.socket,
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
			nextAttachmentGeneration: () => 1,
			policyByOperation: { tool_portal_controller_host_action: 'single_use_critical' },
			refreshExtraHeaders: async () => ({}),
			resolveInboundStablePrincipal: () => ({
				operation: 'tool_portal_controller_host_action',
				reason: 'caller_context_stale',
				status: 'principal_rejected',
			}),
		});
		await client.ready;

		expect(
			await fake.control.receive(
				inboundEnvelope({
					connectionId,
					kind: 'command',
					messageId: '55555555-5555-4555-8555-555555555555',
					operation: 'tool_portal_controller_host_action',
					sequence: 1,
					sessionId,
				}),
				toolPortalControllerHostActionMessage(),
			),
		).toEqual({ received: true });
		await flushImmediate();

		expect(dispatchCount).toBe(0);
		expect(fake.control.acknowledgedPayloads).toContainEqual(
			expect.objectContaining({
				kind: 'command_result',
				operation: 'tool_portal_controller_host_action',
				payload: expect.objectContaining({ result: 'failed' }),
			}),
		);
		expect(fake.control.clientDisconnectCount).toBe(0);
		client.close();
	});

	it('fences a resolver result whose typed operation does not match the inbound command', async () => {
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
			policyByOperation: { lease_get: 'acked_idempotent' },
			refreshExtraHeaders: async () => ({}),
			resolveInboundStablePrincipal: () => ({
				operation: 'tool_portal_controller_host_action',
				reason: 'caller_context_stale',
				status: 'principal_rejected',
			}),
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
				leaseGetMessage('lease-mismatched-resolution'),
			),
		).toEqual({
			errorClass: 'gateway_control_message_processing_failed',
			received: false,
			safeMessage: 'gateway control message was rejected',
		});

		expect(fake.control.clientDisconnectCount).toBe(1);
		expect(fake.control.acknowledgedPayloads).toHaveLength(0);
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
			resolveInboundStablePrincipal: () => ({
				stablePrincipal: 'a'.repeat(64),
				status: 'accepted',
			}),
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

	it.each([
		'caller_context_absent',
		'caller_context_stale',
		'caller_context_session_mismatch',
	] as const)('returns typed %s before lease renewal admission', async (leaseRejectionReason) => {
		const connectionId = '11111111-1111-4111-8111-111111111111';
		const sessionId = '22222222-2222-4222-8222-222222222222';
		const fake = createFakeSocket({ connectionId, sessionId });
		let dispatchCount = 0;
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const client = createGatewayDisposableControlSessionClient({
			createSocket: () => fake.socket,
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
			nextAttachmentGeneration: () => 1,
			now: () => 1_000,
			policyByOperation: { lease_renew: 'single_use_critical' },
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
				throw new Error('diagnostic sink unavailable');
			},
			refreshExtraHeaders: async () => ({}),
			resolveInboundStablePrincipal: () => ({
				leaseRejectionReason,
				operation: 'lease_renew',
				status: 'lease_rejected',
			}),
		});
		await client.ready;
		const messageId = '55555555-5555-4555-8555-555555555555';

		expect(
			await fake.control.receive(
				{
					...inboundEnvelope({
						connectionId,
						kind: 'command',
						messageId,
						operation: 'lease_renew',
						sequence: 1,
						sessionId,
					}),
					deliveryPolicy: 'single_use_critical',
				},
				leaseRenewMessage('lease-a'),
			),
		).toEqual({ received: true });
		await flushImmediate();

		expect(dispatchCount).toBe(0);
		expect(recordedHealthEvents).toEqual([
			{
				kind: 'caller-context-rejection',
				observedAtMs: 1_000,
				operation: 'lease_renew',
				reason: leaseRejectionReason,
				result: 'failed',
				zoneId: 'zone-a',
			},
		]);
		expect(fake.control.acknowledgedPayloads).toContainEqual({
			kind: 'command_result',
			operation: 'lease_renew',
			payload: {
				leaseRejectionReason,
				responseToMessageId: messageId,
				result: 'rejected',
			},
		});
		expect(fake.control.clientDisconnectCount).toBe(0);
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
