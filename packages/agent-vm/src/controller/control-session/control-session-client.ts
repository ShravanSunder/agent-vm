import { randomUUID } from 'node:crypto';

import {
	CONTROL_QUEUE_LIMITS,
	CONTROL_SESSION_TIMING_MS,
	CONTROL_PROTOCOL_VERSION,
	ControlEnvelopeSchema,
	ControlHelloResponseSchema,
	ControlHelloSchema,
	assertControlMessageReceiptAccepted,
	assertControlEnvelopeMatchesDomainMessage,
	assertDerivedControlDeliveryPolicy,
	buildControlMessageRejectionReceipt,
	buildControlMessageReceipt,
	evaluateControlSequenceContinuity,
	extractDomainCommandResultResponseToMessageId,
	orderControlMessagesByEnvelopeSequence,
	type ControlDeliveryPolicy,
	type ControlDomain,
	type ControlEnvelope,
	type ControlHello,
	type ControlHelloResponse,
	type ControlMessageAcknowledge,
	type ControlSequenceContinuityDecision,
	type ControlSessionControllerToPeerEvents,
	type ControlSessionCloseReason,
	type ControlSessionPeerToControllerEvents,
	type DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import { io, type Socket } from 'socket.io-client';

import type { ControlSessionDispatcher } from './control-session-dispatcher.js';

export const CONTROL_SESSION_EVENT_NAMES = {
	close: 'control:close',
	hello: 'control:hello',
	message: 'control:message',
} as const;

export const DEFAULT_GATEWAY_CONTROL_PATH = '/__agent-vm/gateway-control';
export const DEFAULT_WORKER_CONTROL_PATH = '/__agent-vm/worker-control';

export interface ControlSessionEndpoint {
	readonly host: string;
	readonly path: string;
	readonly port: number;
}

export interface ControlSessionIdentity {
	readonly bootId: string;
	readonly controllerEpoch?: string;
	readonly domain: ControlDomain;
	readonly lastSeenControllerSequence?: number;
	readonly lastSeenPeerSequence?: number;
	readonly peerId: string;
	readonly previousSessionId?: string;
}

export interface ControlSessionClientOptions {
	readonly commandResultTimeoutMsByOperation?: Partial<Record<string, number>>;
	readonly createSocket?: (options: CreateControlSessionSocketOptions) => ControlSessionSocket;
	readonly dispatcher?: ControlSessionDispatcher;
	readonly endpoint: ControlSessionEndpoint;
	readonly extraHeaders?: Readonly<Record<string, string>>;
	readonly identity: ControlSessionIdentity;
	readonly onHelloResponse?: (response: ControlHelloResponse) => void;
	readonly policyByKind?: Partial<Record<ControlEnvelope['kind'], ControlDeliveryPolicy>>;
	readonly policyByOperation: Readonly<Record<string, ControlDeliveryPolicy>>;
	readonly refreshExtraHeaders?: (() => Promise<Readonly<Record<string, string>>>) | undefined;
	readonly timeoutMs?: number;
}

export interface CreateControlSessionSocketOptions {
	readonly endpoint: ControlSessionEndpoint;
	readonly extraHeaders?: Readonly<Record<string, string>>;
	readonly manualReconnect: boolean;
	readonly timeoutMs: number;
}

export type ControlSessionSocket = Socket<
	ControlSessionPeerToControllerEvents<unknown>,
	ControlSessionControllerToPeerEvents<unknown>
>;

export interface ControlSessionClient {
	readonly ready: Promise<ControlHelloResponse>;
	close(): void;
	emitApplicationMessage(
		envelope: ControlEnvelope,
		domainMessage: DomainControlMessageIdentity,
		payload: unknown,
		options?: ControlSessionEmitApplicationMessageOptions,
	): Promise<unknown>;
	getDiagnostics(): ControlSessionDiagnostics;
}

export interface ControlSessionEmitApplicationMessageOptions {
	readonly commandResultTimeoutMs?: number;
}

export interface ControlSessionDiagnostics {
	readonly accepted: boolean;
	readonly connected: boolean;
	readonly endpointPath: string;
	readonly helloCount: number;
	readonly lastHelloResponse?: ControlHelloResponse | undefined;
	readonly ready: boolean;
	readonly transportName?: string | undefined;
}

function buildControlSessionUrl(endpoint: ControlSessionEndpoint): string {
	return `http://${endpoint.host}:${String(endpoint.port)}`;
}

export function createSocketIoControlSessionSocket(
	options: CreateControlSessionSocketOptions,
): ControlSessionSocket {
	return io(buildControlSessionUrl(options.endpoint), {
		addTrailingSlash: false,
		...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
		forceNew: true,
		path: options.endpoint.path,
		reconnection: !options.manualReconnect,
		timeout: options.timeoutMs,
		transports: ['websocket'],
	});
}

export function clearControlSessionSendBuffer(socket: ControlSessionSocket): void {
	socket.sendBuffer.splice(0, socket.sendBuffer.length);
}

export function buildControlHello(identity: ControlSessionIdentity): ControlHello {
	return ControlHelloSchema.parse({
		bootId: identity.bootId,
		...(identity.controllerEpoch === undefined
			? {}
			: { controllerEpoch: identity.controllerEpoch }),
		domain: identity.domain,
		...(identity.lastSeenControllerSequence === undefined
			? {}
			: { lastSeenControllerSequence: identity.lastSeenControllerSequence }),
		...(identity.lastSeenPeerSequence === undefined
			? {}
			: { lastSeenPeerSequence: identity.lastSeenPeerSequence }),
		peerId: identity.peerId,
		...(identity.previousSessionId === undefined
			? {}
			: { previousSessionId: identity.previousSessionId }),
		protocolVersion: CONTROL_PROTOCOL_VERSION,
	});
}

export function assertControlSessionDispatchAllowed(options: {
	readonly assertEnvelopeDeliveryPolicy?: (envelope: ControlEnvelope) => void;
	readonly domainMessage: DomainControlMessageIdentity;
	readonly envelope: ControlEnvelope;
	readonly policyByKind?: Partial<Record<ControlEnvelope['kind'], ControlDeliveryPolicy>>;
	readonly policyByOperation: Readonly<Record<string, ControlDeliveryPolicy>>;
}): void {
	ControlEnvelopeSchema.parse(options.envelope);
	assertControlEnvelopeMatchesDomainMessage(options.envelope, options.domainMessage);
	if (options.assertEnvelopeDeliveryPolicy === undefined) {
		assertDerivedControlDeliveryPolicy({
			envelope: options.envelope,
			policyByOperation: options.policyByOperation,
			...(options.policyByKind === undefined ? {} : { policyByKind: options.policyByKind }),
		});
		return;
	}
	options.assertEnvelopeDeliveryPolicy(options.envelope);
}

export function measureControlSessionMessageBytes(
	envelope: ControlEnvelope,
	payload: unknown,
): number {
	const serializedMessage = JSON.stringify([envelope, payload]);
	if (serializedMessage === undefined) {
		throw new Error('control message payload must be JSON serializable');
	}
	return Buffer.byteLength(serializedMessage, 'utf8');
}

interface PendingControlSessionQueue {
	byteCount: number;
	messageCount: number;
}

interface StaleControlSessionState {
	reason: ControlSessionCloseReason;
	safeMessage: string;
	sessionId: string;
}

interface LatestWinsControlSessionMessage {
	readonly envelope: ControlEnvelope;
	readonly payload: unknown;
}

interface PendingControlSessionCommandResult {
	readonly promise: Promise<unknown>;
	readonly reject: (error: Error) => void;
	readonly resolve: (payload: unknown) => void;
	timeout: ReturnType<typeof setTimeout>;
}

function staleReasonForHelloOutcome(
	response: ControlHelloResponse,
): Pick<StaleControlSessionState, 'reason' | 'safeMessage'> | undefined {
	if (response.outcome === 'accepted') {
		return undefined;
	}
	if (response.outcome === 'generation_mismatch') {
		return {
			reason: 'generation_mismatch',
			safeMessage: 'control session hello rejected by generation mismatch',
		};
	}
	return {
		reason: 'auth_failed',
		safeMessage: 'control session hello was rejected',
	};
}

export function assertControlSessionMessageWithinBounds(
	envelope: ControlEnvelope,
	payload: unknown,
): void {
	if (envelope.deliveryPolicy === 'forbidden_bulk') {
		throw new Error('forbidden bulk message cannot be sent on the control session');
	}
	const messageByteLength = measureControlSessionMessageBytes(envelope, payload);
	if (messageByteLength > CONTROL_QUEUE_LIMITS.maxHttpBufferBytes) {
		throw new Error(
			`control message exceeds maxHttpBufferBytes: ${String(messageByteLength)} > ${String(CONTROL_QUEUE_LIMITS.maxHttpBufferBytes)}`,
		);
	}
}

export function reservePendingControlSessionMessage(
	queue: PendingControlSessionQueue,
	messageByteLength: number,
): void {
	if (
		queue.messageCount + 1 > CONTROL_QUEUE_LIMITS.queueMessageCap ||
		queue.byteCount + messageByteLength > CONTROL_QUEUE_LIMITS.queueByteCap
	) {
		throw new Error(
			`control session pending queue overflow: messages=${String(queue.messageCount + 1)}/${String(CONTROL_QUEUE_LIMITS.queueMessageCap)} bytes=${String(queue.byteCount + messageByteLength)}/${String(CONTROL_QUEUE_LIMITS.queueByteCap)}`,
		);
	}
	queue.messageCount += 1;
	queue.byteCount += messageByteLength;
}

export function releasePendingControlSessionMessage(
	queue: PendingControlSessionQueue,
	messageByteLength: number,
): void {
	queue.messageCount = Math.max(0, queue.messageCount - 1);
	queue.byteCount = Math.max(0, queue.byteCount - messageByteLength);
}

export function isPriorityControlSessionMessage(envelope: ControlEnvelope): boolean {
	return envelope.kind === 'heartbeat' || envelope.operation === 'operation_cancel';
}

export function buildLatestWinsControlSessionKey(envelope: ControlEnvelope): string {
	return [
		envelope.domain,
		envelope.zoneId,
		envelope.peerId,
		envelope.kind,
		envelope.operation ?? '<none>',
	].join('\u0000');
}

function buildControlSessionResponseEnvelope(options: {
	readonly requestEnvelope: ControlEnvelope;
	readonly sequence: number;
}): ControlEnvelope {
	return ControlEnvelopeSchema.parse({
		...options.requestEnvelope,
		createdAtMs: Date.now(),
		kind: 'command_result',
		messageId: randomUUID(),
		sequence: options.sequence,
	});
}

function waitForControlSessionCommandResult(options: {
	readonly messageId: string;
	readonly pendingCommandResults: Map<string, PendingControlSessionCommandResult>;
	readonly timeoutMs: number;
}): Promise<unknown> {
	const existingPendingResult = options.pendingCommandResults.get(options.messageId);
	if (existingPendingResult !== undefined) {
		clearTimeout(existingPendingResult.timeout);
		existingPendingResult.timeout = setTimeout(() => {
			if (options.pendingCommandResults.get(options.messageId) === existingPendingResult) {
				options.pendingCommandResults.delete(options.messageId);
			}
			existingPendingResult.reject(
				new Error(`control command result timed out: ${options.messageId}`),
			);
		}, options.timeoutMs);
		existingPendingResult.timeout.unref?.();
		return existingPendingResult.promise;
	}

	let resolvePromise!: (payload: unknown) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<unknown>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	const pendingResult: PendingControlSessionCommandResult = {
		promise,
		reject: rejectPromise,
		resolve: resolvePromise,
		timeout: setTimeout(() => {
			if (options.pendingCommandResults.get(options.messageId) === pendingResult) {
				options.pendingCommandResults.delete(options.messageId);
			}
			rejectPromise(new Error(`control command result timed out: ${options.messageId}`));
		}, options.timeoutMs),
	};
	pendingResult.timeout.unref?.();
	options.pendingCommandResults.set(options.messageId, pendingResult);
	return promise;
}

export function createControlSessionClient(
	options: ControlSessionClientOptions,
): ControlSessionClient {
	const timeoutMs = options.timeoutMs ?? CONTROL_SESSION_TIMING_MS.commandAckTimeout;
	const manualReconnect = options.refreshExtraHeaders !== undefined;
	const socket = (options.createSocket ?? createSocketIoControlSessionSocket)({
		endpoint: options.endpoint,
		...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
		manualReconnect,
		timeoutMs,
	});
	const pendingQueue: PendingControlSessionQueue = {
		byteCount: 0,
		messageCount: 0,
	};
	const latestWinsQueue = new Map<string, LatestWinsControlSessionMessage>();
	const pendingCommandResults = new Map<string, PendingControlSessionCommandResult>();
	let latestWinsFlushScheduled = false;
	let staleState: StaleControlSessionState | undefined;
	let hasAcceptedHello = options.identity.previousSessionId !== undefined;
	let currentConnectionAccepted = false;
	let lastAcceptedConnectionId: string | undefined;
	let lastAcceptedSessionId = options.identity.previousSessionId;
	let lastSeenControllerSequence = options.identity.lastSeenControllerSequence ?? 0;
	let lastSeenPeerSequence = options.identity.lastSeenPeerSequence ?? 0;
	let nextControllerSequenceValue = lastSeenControllerSequence + 1;
	let initialHelloCompleted = false;
	let helloCount = 0;
	let lastHelloResponse: ControlHelloResponse | undefined;
	let latestHelloPromise: Promise<ControlHelloResponse> | undefined;
	let closeRequested = false;
	let manualReconnectTimer: NodeJS.Timeout | undefined;
	let manualReconnectInFlight = false;
	let outboundResponseQueue: Promise<void> = Promise.resolve();

	function buildNextHello(): ControlHello {
		return buildControlHello({
			...options.identity,
			...(hasAcceptedHello
				? {
						lastSeenControllerSequence,
						lastSeenPeerSequence,
						...(lastAcceptedSessionId === undefined
							? {}
							: { previousSessionId: lastAcceptedSessionId }),
					}
				: {}),
		});
	}

	function resetHelloContinuityForFullResync(): void {
		hasAcceptedHello = false;
		currentConnectionAccepted = false;
		lastAcceptedConnectionId = undefined;
		lastAcceptedSessionId = undefined;
		lastSeenControllerSequence = 0;
		lastSeenPeerSequence = 0;
		nextControllerSequenceValue = 1;
		clearControlSessionSendBuffer(socket);
	}

	function sendControlSessionHello(optionsForHello: {
		readonly allowResyncRetry: boolean;
	}): Promise<ControlHelloResponse> {
		const helloPromise = socket
			.timeout(timeoutMs)
			.emitWithAck(CONTROL_SESSION_EVENT_NAMES.hello, buildNextHello())
			.then((responsePayload: unknown) => {
				const parsedResponse = ControlHelloResponseSchema.parse(responsePayload);
				helloCount += 1;
				lastHelloResponse = parsedResponse;
				options.onHelloResponse?.(parsedResponse);
				if (parsedResponse.outcome === 'resync_required') {
					if (optionsForHello.allowResyncRetry) {
						resetHelloContinuityForFullResync();
						return sendControlSessionHello({ allowResyncRetry: false });
					}
					markControlSessionStale({
						reason: 'resync_timeout',
						safeMessage: 'control session hello requires resync before application traffic',
						sessionId: parsedResponse.sessionId,
					});
					throw new Error(
						'control session hello outcome was resync_required: control session hello requires resync before application traffic',
					);
				}
				const staleReason = staleReasonForHelloOutcome(parsedResponse);
				if (staleReason !== undefined) {
					markControlSessionStale({
						...staleReason,
						sessionId: parsedResponse.sessionId,
					});
					throw new Error(
						`control session hello outcome was ${parsedResponse.outcome}: ${staleReason.safeMessage}`,
					);
				}
				hasAcceptedHello = true;
				currentConnectionAccepted = true;
				lastAcceptedConnectionId = parsedResponse.connectionId;
				lastAcceptedSessionId = parsedResponse.sessionId;
				nextControllerSequenceValue = lastSeenControllerSequence + 1;
				return parsedResponse;
			});
		latestHelloPromise = helloPromise;
		return helloPromise;
	}

	function handleReconnectHelloFailure(): void {
		if (staleState !== undefined || closeRequested) {
			return;
		}
		clearControlSessionSendBuffer(socket);
		socket.io.engine?.close();
		if (manualReconnect) {
			queueManualReconnect(Math.min(timeoutMs, 1_000));
		}
	}

	function reserveOutboundControllerSequence(
		envelope: ControlEnvelope,
	): ControlSequenceContinuityDecision {
		const sequenceDecision = evaluateControlSequenceContinuity({
			envelope,
			lastSeenSequence: nextControllerSequenceValue - 1,
		});
		if (sequenceDecision.action === 'accept') {
			nextControllerSequenceValue = sequenceDecision.nextLastSeenSequence + 1;
		}
		return sequenceDecision;
	}

	function waitForManualReconnectAttempt(): Promise<'connected' | 'failed'> {
		return new Promise((resolve) => {
			let settled = false;
			const cleanup = (): void => {
				socket.off('connect', handleConnect);
				socket.off('connect_error', handleFailed);
				socket.off('disconnect', handleFailed);
				clearTimeout(timer);
			};
			const settle = (outcome: 'connected' | 'failed'): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(outcome);
			};
			const handleConnect = (): void => {
				settle('connected');
			};
			const handleFailed = (): void => {
				settle('failed');
			};
			const timer = setTimeout(() => {
				settle('failed');
			}, timeoutMs);
			socket.once('connect', handleConnect);
			socket.once('connect_error', handleFailed);
			socket.once('disconnect', handleFailed);
		});
	}

	function clearManualReconnectTimer(): void {
		if (manualReconnectTimer !== undefined) {
			clearTimeout(manualReconnectTimer);
			manualReconnectTimer = undefined;
		}
	}

	function setSocketExtraHeaders(headers: Readonly<Record<string, string>>): void {
		socket.io.opts.extraHeaders = { ...headers };
	}

	function queueManualReconnect(delayMs = 0): void {
		if (
			options.refreshExtraHeaders === undefined ||
			closeRequested ||
			staleState !== undefined ||
			socket.connected ||
			manualReconnectInFlight ||
			manualReconnectTimer !== undefined
		) {
			return;
		}
		manualReconnectTimer = setTimeout(() => {
			manualReconnectTimer = undefined;
			void runManualReconnect();
		}, delayMs);
	}

	async function runManualReconnect(): Promise<void> {
		if (
			options.refreshExtraHeaders === undefined ||
			closeRequested ||
			staleState !== undefined ||
			socket.connected ||
			manualReconnectInFlight
		) {
			return;
		}
		manualReconnectInFlight = true;
		try {
			const refreshedHeaders = await options.refreshExtraHeaders();
			if (closeRequested || staleState !== undefined || socket.connected) {
				return;
			}
			setSocketExtraHeaders(refreshedHeaders);
			clearControlSessionSendBuffer(socket);
			socket.connect();
			const outcome = await waitForManualReconnectAttempt();
			if (outcome === 'connected') {
				return;
			}
		} catch {
			// Reconnect retry is best-effort until the broader death-grace owner decides recovery.
		} finally {
			manualReconnectInFlight = false;
		}
		queueManualReconnect(Math.min(timeoutMs, 1_000));
	}

	const ready = new Promise<ControlHelloResponse>((resolve, reject) => {
		socket.once('connect', () => {
			currentConnectionAccepted = false;
			clearControlSessionSendBuffer(socket);
			sendControlSessionHello({ allowResyncRetry: hasAcceptedHello })
				.then((responsePayload) => {
					initialHelloCompleted = true;
					resolve(responsePayload);
				})
				.catch((error: unknown) => {
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
		socket.once('connect_error', (error: Error) => {
			reject(error);
		});
	});

	socket.on('connect', () => {
		currentConnectionAccepted = false;
		clearManualReconnectTimer();
		clearControlSessionSendBuffer(socket);
		if (initialHelloCompleted) {
			sendControlSessionHello({ allowResyncRetry: true }).catch(handleReconnectHelloFailure);
		}
	});
	socket.on('disconnect', () => {
		currentConnectionAccepted = false;
		if (initialHelloCompleted) {
			queueManualReconnect();
		}
	});
	socket.on('connect_error', () => {
		if (initialHelloCompleted) {
			queueManualReconnect(Math.min(timeoutMs, 1_000));
		}
	});
	socket.on(
		CONTROL_SESSION_EVENT_NAMES.message,
		(envelopePayload: unknown, payload: unknown, acknowledge?: ControlMessageAcknowledge) => {
			void (async () => {
				try {
					const envelope = ControlEnvelopeSchema.parse(envelopePayload);
					assertControlSessionMessageWithinBounds(envelope, payload);
					assertInboundEnvelopeMatchesAcceptedSession(envelope);
					const sequenceDecision = evaluateControlSequenceContinuity({
						envelope,
						lastSeenSequence: lastSeenPeerSequence,
					});
					if (sequenceDecision.action === 'drop') {
						acknowledge?.(buildControlMessageReceipt());
						return;
					}
					if (sequenceDecision.action === 'stale') {
						markControlSessionStale({
							reason: sequenceDecision.closeReason,
							safeMessage: sequenceDecision.safeMessage,
							sessionId: envelope.sessionId,
						});
						return;
					}
					lastSeenPeerSequence = sequenceDecision.nextLastSeenSequence;
					const responseToMessageId = extractDomainCommandResultResponseToMessageId(payload);
					if (envelope.kind === 'command_result' && responseToMessageId !== undefined) {
						acknowledge?.(buildControlMessageReceipt());
						const pendingResult = pendingCommandResults.get(responseToMessageId);
						if (pendingResult !== undefined) {
							clearTimeout(pendingResult.timeout);
							pendingCommandResults.delete(responseToMessageId);
							pendingResult.resolve(payload);
						}
						return;
					}
					if (options.dispatcher === undefined) {
						throw new Error('no control session dispatcher configured');
					}
					options.dispatcher.validate({ envelope, payload });
					acknowledge?.(buildControlMessageReceipt());
					const responsePayload = await options.dispatcher.dispatch({ envelope, payload });
					if (responsePayload !== undefined) {
						outboundResponseQueue = outboundResponseQueue
							.catch(() => undefined)
							.then(async () => {
								const responseSequence = nextControllerSequenceValue;
								const responseEnvelope = buildControlSessionResponseEnvelope({
									requestEnvelope: envelope,
									sequence: responseSequence,
								});
								const outboundSequenceDecision =
									reserveOutboundControllerSequence(responseEnvelope);
								if (outboundSequenceDecision.action !== 'accept') {
									throw new Error(outboundSequenceDecision.safeMessage);
								}
								const receiptPayload: unknown = await socket
									.timeout(timeoutMs)
									.emitWithAck(
										CONTROL_SESSION_EVENT_NAMES.message,
										responseEnvelope,
										responsePayload,
									);
								assertControlMessageReceiptAccepted(receiptPayload);
								lastSeenControllerSequence = Math.max(
									lastSeenControllerSequence,
									outboundSequenceDecision.nextLastSeenSequence,
								);
							})
							.catch((error: unknown) => {
								markControlSessionStale({
									reason: 'sequence_gap',
									safeMessage:
										error instanceof Error
											? error.message
											: 'control response receipt failed after sequence reservation',
									sessionId: envelope.sessionId,
								});
							});
					}
				} catch {
					acknowledge?.(
						buildControlMessageRejectionReceipt({
							errorClass: 'schema_validation_failed',
							safeMessage: 'control message was rejected',
						}),
					);
				}
			})();
		},
	);
	socket.io.on('reconnect', () => {
		clearControlSessionSendBuffer(socket);
	});

	function markControlSessionStale(state: StaleControlSessionState): void {
		if (staleState !== undefined) {
			return;
		}
		staleState = state;
		latestWinsQueue.clear();
		for (const [messageId, pendingResult] of pendingCommandResults) {
			clearTimeout(pendingResult.timeout);
			pendingCommandResults.delete(messageId);
			pendingResult.reject(new Error(`${state.reason}: ${state.safeMessage}`));
		}
		clearControlSessionSendBuffer(socket);
		if (socket.connected) {
			const closeTimeoutMs = Math.min(timeoutMs, 100);
			const closeTimer = setTimeout(() => {
				socket.close();
			}, closeTimeoutMs);
			socket
				.timeout(closeTimeoutMs)
				.emitWithAck(CONTROL_SESSION_EVENT_NAMES.close, state)
				.catch(() => undefined)
				.finally(() => {
					clearTimeout(closeTimer);
					socket.close();
				});
			return;
		}
		socket.close();
	}

	function assertInboundEnvelopeMatchesAcceptedSession(envelope: ControlEnvelope): void {
		if (
			lastAcceptedConnectionId === undefined ||
			lastAcceptedSessionId === undefined ||
			envelope.connectionId !== lastAcceptedConnectionId ||
			envelope.sessionId !== lastAcceptedSessionId ||
			envelope.bootId !== options.identity.bootId ||
			envelope.domain !== options.identity.domain ||
			envelope.peerId !== options.identity.peerId ||
			(options.identity.controllerEpoch !== undefined &&
				envelope.controllerEpoch !== options.identity.controllerEpoch)
		) {
			throw new Error('control session inbound message did not match accepted session');
		}
	}

	function commandResultTimeoutMsFor(
		envelope: ControlEnvelope,
		emitOptions: ControlSessionEmitApplicationMessageOptions | undefined,
	): number {
		if (emitOptions?.commandResultTimeoutMs !== undefined) {
			return emitOptions.commandResultTimeoutMs;
		}
		if (envelope.operation !== undefined) {
			const operationTimeoutMs = options.commandResultTimeoutMsByOperation?.[envelope.operation];
			if (operationTimeoutMs !== undefined) {
				return operationTimeoutMs;
			}
		}
		return timeoutMs;
	}

	function scheduleLatestWinsFlush(): void {
		if (latestWinsFlushScheduled) {
			return;
		}
		latestWinsFlushScheduled = true;
		setImmediate(() => {
			latestWinsFlushScheduled = false;
			if (staleState !== undefined || !socket.connected) {
				latestWinsQueue.clear();
				return;
			}
			const messages = [...latestWinsQueue.values()];
			latestWinsQueue.clear();
			for (const message of orderControlMessagesByEnvelopeSequence(messages)) {
				socket.volatile.emit(
					CONTROL_SESSION_EVENT_NAMES.message,
					message.envelope,
					message.payload,
					() => undefined,
				);
			}
		});
	}

	return {
		ready,
		close: () => {
			closeRequested = true;
			clearManualReconnectTimer();
			latestWinsQueue.clear();
			for (const [messageId, pendingResult] of pendingCommandResults) {
				clearTimeout(pendingResult.timeout);
				pendingCommandResults.delete(messageId);
				pendingResult.reject(new Error('control session closed before command result'));
			}
			socket.close();
		},
		getDiagnostics: () => ({
			accepted: socket.connected && currentConnectionAccepted,
			connected: socket.connected,
			endpointPath: options.endpoint.path,
			helloCount,
			...(lastHelloResponse === undefined ? {} : { lastHelloResponse }),
			ready: socket.connected && currentConnectionAccepted,
			transportName: socket.io.engine?.transport?.name,
		}),
		emitApplicationMessage: async (envelope, domainMessage, payload, emitOptions) => {
			if (staleState !== undefined) {
				throw new Error(
					`control session is stale: ${staleState.reason}: ${staleState.safeMessage}`,
				);
			}
			ControlEnvelopeSchema.parse(envelope);
			assertControlSessionMessageWithinBounds(envelope, payload);
			assertControlSessionDispatchAllowed({
				domainMessage,
				envelope,
				policyByOperation: options.policyByOperation,
				...(options.policyByKind === undefined ? {} : { policyByKind: options.policyByKind }),
			});
			const messageByteLength = measureControlSessionMessageBytes(envelope, payload);
			const isDroppableDelivery =
				envelope.deliveryPolicy === 'droppable' || envelope.deliveryPolicy === 'latest_wins';
			if (!socket.connected) {
				clearControlSessionSendBuffer(socket);
				if (isDroppableDelivery) {
					return undefined;
				}
				throw new Error('control session is not connected; refusing to buffer application message');
			}
			if (latestHelloPromise !== undefined) {
				await latestHelloPromise;
			}
			const sequenceDecision = reserveOutboundControllerSequence(envelope);
			if (sequenceDecision.action === 'drop') {
				throw new Error(sequenceDecision.safeMessage);
			}
			if (sequenceDecision.action === 'stale') {
				markControlSessionStale({
					reason: sequenceDecision.closeReason,
					safeMessage: sequenceDecision.safeMessage,
					sessionId: envelope.sessionId,
				});
				throw new Error(sequenceDecision.safeMessage);
			}
			if (envelope.deliveryPolicy === 'latest_wins') {
				latestWinsQueue.set(buildLatestWinsControlSessionKey(envelope), { envelope, payload });
				lastSeenControllerSequence = sequenceDecision.nextLastSeenSequence;
				scheduleLatestWinsFlush();
				return undefined;
			}
			if (envelope.deliveryPolicy === 'droppable') {
				socket.volatile.emit(
					CONTROL_SESSION_EVENT_NAMES.message,
					envelope,
					payload,
					() => undefined,
				);
				lastSeenControllerSequence = sequenceDecision.nextLastSeenSequence;
				return undefined;
			}
			const shouldReservePendingCapacity = !isPriorityControlSessionMessage(envelope);
			if (shouldReservePendingCapacity) {
				try {
					reservePendingControlSessionMessage(pendingQueue, messageByteLength);
				} catch (error) {
					markControlSessionStale({
						reason: 'queue_overflow',
						safeMessage: 'control session pending queue overflow',
						sessionId: envelope.sessionId,
					});
					throw error;
				}
			}
			try {
				const commandResultPromise =
					envelope.kind === 'command'
						? waitForControlSessionCommandResult({
								messageId: envelope.messageId,
								pendingCommandResults,
								timeoutMs: commandResultTimeoutMsFor(envelope, emitOptions),
							})
						: undefined;
				commandResultPromise?.catch(() => undefined);
				const receiptPayload: unknown = await socket
					.timeout(timeoutMs)
					.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, envelope, payload);
				assertControlMessageReceiptAccepted(receiptPayload);
				lastSeenControllerSequence = Math.max(
					lastSeenControllerSequence,
					sequenceDecision.nextLastSeenSequence,
				);
				if (commandResultPromise !== undefined) {
					return await commandResultPromise;
				}
				return receiptPayload;
			} catch (error) {
				if (isPriorityControlSessionMessage(envelope)) {
					markControlSessionStale({
						reason: 'transport_error',
						safeMessage: 'control session priority heartbeat timed out',
						sessionId: envelope.sessionId,
					});
				}
				throw error;
			} finally {
				if (shouldReservePendingCapacity) {
					releasePendingControlSessionMessage(pendingQueue, messageByteLength);
				}
			}
		},
	};
}
