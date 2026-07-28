import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_QUEUE_LIMITS,
	CONTROL_SESSION_TIMING_MS,
	buildControlHandshakeSignaturePayload,
	type ControlEnvelope,
	type ControlHandshakeProof,
	type ControlReadyRequestProof,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlHelloSchema,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	type GatewayControlControllerToGatewayEvents,
	type GatewayControlGatewayToControllerEvents,
	type GatewayControlHello,
	type GatewayControlHelloResponse,
} from '@agent-vm/gateway-control-contracts';
import { Server as EngineIoServer } from 'engine.io';
import type { Socket } from 'socket.io';
import { Server as SocketIoServer } from 'socket.io';

import { GATEWAY_CONTROL_BOOTSTRAP_AUTHORITY_KEY } from './gateway-control-admission-runtime.js';
import { createGatewayControlApplicationMessageRuntime } from './gateway-control-application-message-runtime.js';
import {
	parseHandshakeProofFromHeaders,
	parseReadyRequestProofFromHeaders,
	proofMatchesCredential,
	readyProofMatchesIdentity,
	requestHasQueryParameters,
	requestHasValidSocketIoUpgradeQuery,
	verifyGatewayControlProofSignature,
	verifyGatewayControlReadyProofSignature,
} from './gateway-control-authentication.js';
import {
	GatewayControlSessionUnavailableError,
	GatewayControlSessionWaiterOverflowError,
	GatewayControlAcceptedSessionObserverOverflowError,
} from './gateway-control-endpoint-contracts.js';
import type {
	GatewayControlAcceptedSessionObserver,
	GatewayControlAcceptedSessionObserverFailureHandler,
	GatewayControlSessionStateObserver,
	ConsumedReadyRequest,
	FailedUpgradeAttemptWindow,
	GatewayControlAcceptedSession,
	GatewayControlEmitApplicationMessageOptions,
	GatewayControlIdentity,
	GatewayControlIssuedCredential,
	GatewayControlPublicIdentity,
	GatewayControlService,
	GatewayControlServiceOptions,
	PendingGatewayControlCommandResult,
	ReadyProofConsumptionResult,
	StoredGatewayControlCredential,
} from './gateway-control-endpoint-contracts.js';

export const GATEWAY_CONTROL_READY_PATH = '/__agent-vm/ready';
export const GATEWAY_CONTROL_SOCKET_PATH = '/__agent-vm/gateway-control';
export const GATEWAY_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT = 8;
export const GATEWAY_CONTROL_ACCEPTED_SESSION_OBSERVER_LIMIT = 32;

export {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	GATEWAY_CONTROL_BOOTSTRAP_AUTHORITY_KEY,
	GatewayControlAcceptedSessionObserverOverflowError,
	GatewayControlSessionUnavailableError,
	GatewayControlSessionWaiterOverflowError,
	buildControlHandshakeSignaturePayload as buildGatewayControlSignaturePayload,
};
export type {
	GatewayControlAcceptedSession,
	GatewayControlAcceptedSessionObservation,
	GatewayControlAcceptedSessionObserver,
	GatewayControlAcceptedSessionObserverFailureHandler,
	GatewayControlApplicationMessageContext,
	GatewayControlApplicationMessageHandler,
	GatewayControlApplicationMessageIntent,
	GatewayControlEmitApplicationMessageOptions,
	GatewayControlIdentity,
	GatewayControlIssuedCredential,
	GatewayControlNonceState,
	GatewayControlPublicIdentity,
	GatewayControlReadyRejectionReason,
	GatewayControlService,
	GatewayControlServiceOptions,
} from './gateway-control-endpoint-contracts.js';

function gatewayControlPublicIdentityFor(
	identity: GatewayControlIdentity,
): GatewayControlPublicIdentity {
	return {
		bootId: identity.bootId,
		controllerEpoch: identity.controllerEpoch,
		generationId: identity.generationId,
		peerId: identity.peerId,
		zoneId: identity.zoneId,
	};
}

function writeTextResponse(res: ServerResponse, statusCode: number, body: string): void {
	res.statusCode = statusCode;
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	res.end(body);
}

function writeUpgradeFailure(socket: Duplex, statusLine = '400 Bad Request'): void {
	socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

export function createGatewayControlService(
	options: GatewayControlServiceOptions,
): GatewayControlService {
	const now = options.now ?? Date.now;
	const nonceTtlMs = options.nonceTtlMs ?? CONTROL_SESSION_TIMING_MS.connectTimeout;
	const clockSkewToleranceMs = CONTROL_SESSION_TIMING_MS.clockSkewTolerance;
	const credentials = new Map<string, StoredGatewayControlCredential>();
	const consumedReadyRequestIds = new Map<string, ConsumedReadyRequest>();
	const failedUpgradeAttemptsBySource = new Map<string, FailedUpgradeAttemptWindow>();
	const pendingCommandResults = new Map<string, PendingGatewayControlCommandResult>();
	const commandExecutionTimeoutMsByOperation: Readonly<Record<string, number>> =
		gatewayControlCommandExecutionTimeoutMsByOperation;
	let acceptedSocket:
		| Socket<GatewayControlControllerToGatewayEvents, GatewayControlGatewayToControllerEvents>
		| undefined;
	let acceptedSession: GatewayControlAcceptedSession | undefined;
	let highestAcceptedAttachmentGeneration = 0;
	let lastSeenControllerSequence = 0;
	let lastSeenPeerSequence = 0;
	let nextPeerSequenceValue = 1;
	const acceptedSessionWaiters: ((session: GatewayControlAcceptedSession | undefined) => void)[] =
		[];
	const acceptedSessionObservers = new Map<
		GatewayControlAcceptedSessionObserver,
		GatewayControlAcceptedSessionObserverFailureHandler
	>();
	const sessionStateObservers = new Map<
		GatewayControlSessionStateObserver,
		GatewayControlAcceptedSessionObserverFailureHandler
	>();

	function reservePeerSequence(): number {
		const sequence = Math.max(nextPeerSequenceValue, lastSeenPeerSequence + 1);
		nextPeerSequenceValue = sequence + 1;
		return sequence;
	}

	function recordLastSeenPeerSequence(sequence: number): void {
		lastSeenPeerSequence = Math.max(lastSeenPeerSequence, sequence);
		nextPeerSequenceValue = Math.max(nextPeerSequenceValue, lastSeenPeerSequence + 1);
	}

	function resolveAcceptedSessionWaiters(session: GatewayControlAcceptedSession | undefined): void {
		for (const waiter of acceptedSessionWaiters.splice(0)) waiter(session);
	}

	function notifyAcceptedSessionObservers(session: GatewayControlAcceptedSession): void {
		for (const [observer, onObserverFailure] of acceptedSessionObservers) {
			try {
				observer(session);
			} catch (error: unknown) {
				try {
					onObserverFailure(error);
				} catch {
					// Observer failure reporting cannot break accepted-session establishment.
				}
			}
		}
	}

	function notifySessionStateObservers(session: GatewayControlAcceptedSession | undefined): void {
		for (const [observer, onObserverFailure] of sessionStateObservers) {
			try {
				observer(session);
			} catch (error: unknown) {
				try {
					onObserverFailure(error);
				} catch {
					// Observer failure reporting cannot break session retirement or establishment.
				}
			}
		}
	}

	function rejectPendingGatewayControlCommandResults(error: Error): void {
		for (const [messageId, pendingResult] of pendingCommandResults) {
			clearTimeout(pendingResult.timeout);
			pendingCommandResults.delete(messageId);
			pendingResult.reject(error);
		}
	}

	function closeGatewayControlSessionForSequenceGap(
		socket: Socket<
			GatewayControlControllerToGatewayEvents,
			GatewayControlGatewayToControllerEvents
		>,
		safeMessage: string,
	): void {
		if (acceptedSocket === socket) {
			acceptedSocket = undefined;
			acceptedSession = undefined;
			notifySessionStateObservers(undefined);
			applicationMessageRuntime.close(`sequence_gap: ${safeMessage}`);
			resolveAcceptedSessionWaiters(undefined);
		}
		rejectPendingGatewayControlCommandResults(new Error(`sequence_gap: ${safeMessage}`));
		socket.disconnect(true);
	}

	function resetGatewayControlStateForAcceptedAttachment(): void {
		applicationMessageRuntime.reset('gateway control attachment replaced');
		lastSeenControllerSequence = 0;
		lastSeenPeerSequence = 0;
		nextPeerSequenceValue = 1;
		rejectPendingGatewayControlCommandResults(
			new Error('stale_attachment: gateway control session was superseded'),
		);
	}

	function assertInboundEnvelopeMatchesAcceptedSession(
		socket: Socket<
			GatewayControlControllerToGatewayEvents,
			GatewayControlGatewayToControllerEvents
		>,
		envelope: ControlEnvelope,
	): void {
		const session = acceptedSession;
		if (
			session === undefined ||
			acceptedSocket !== socket ||
			envelope.sessionId !== session.sessionId ||
			envelope.connectionId !== session.connectionId ||
			envelope.bootId !== session.bootId ||
			envelope.controllerEpoch !== session.controllerEpoch ||
			envelope.domain !== 'gateway_control' ||
			envelope.peerId !== session.peerId ||
			envelope.zoneId !== session.zoneId
		) {
			throw new Error('gateway control inbound message did not match accepted session');
		}
	}

	function commandResultTimeoutMsFor(
		envelope: ControlEnvelope,
		emitOptions: GatewayControlEmitApplicationMessageOptions | undefined,
	): number {
		if (emitOptions?.commandResultTimeoutMs !== undefined) {
			return emitOptions.commandResultTimeoutMs;
		}
		return envelope.operation === undefined
			? CONTROL_SESSION_TIMING_MS.commandAckTimeout
			: (commandExecutionTimeoutMsByOperation[envelope.operation] ??
					CONTROL_SESSION_TIMING_MS.commandAckTimeout);
	}

	const applicationMessageRuntime = createGatewayControlApplicationMessageRuntime({
		...(options.applicationMessageHandler === undefined
			? {}
			: { applicationMessageHandler: options.applicationMessageHandler }),
		assertInboundEnvelopeMatchesAcceptedSession,
		closeForProtocolFailure: closeGatewayControlSessionForSequenceGap,
		closeForResponseFailure: (socket, error) =>
			closeGatewayControlSessionForSequenceGap(
				socket,
				error instanceof Error ? error.message : 'gateway control response receipt failed',
			),
		commandResultTimeoutMsFor,
		getAcceptedSession: () => acceptedSession,
		getAcceptedSocket: () => acceptedSocket,
		getLastSeenControllerSequence: () => lastSeenControllerSequence,
		pendingCommandResults,
		recordLastSeenControllerSequence: (sequence) => {
			lastSeenControllerSequence = sequence;
		},
		recordLastSeenPeerSequence,
		reservePeerSequence,
	});

	const engine = new EngineIoServer({
		allowUpgrades: false,
		maxHttpBufferSize: CONTROL_QUEUE_LIMITS.maxHttpBufferBytes,
		perMessageDeflate: false,
		pingInterval: CONTROL_SESSION_TIMING_MS.engineIoPingInterval,
		pingTimeout: CONTROL_SESSION_TIMING_MS.engineIoPingTimeout,
		transports: ['websocket'],
	});
	const handleEngineUpgrade =
		options.handleEngineUpgrade ??
		((req: IncomingMessage, socket: Duplex, head: Buffer): void => {
			engine.handleUpgrade(req, socket, head);
		});
	const socketServer = new SocketIoServer<
		GatewayControlControllerToGatewayEvents,
		GatewayControlGatewayToControllerEvents
	>({ serveClient: false });
	socketServer.bind(engine);

	socketServer.on('connection', (socket) => {
		socket.once('disconnect', () => {
			if (acceptedSocket !== socket) return;
			acceptedSocket = undefined;
			acceptedSession = undefined;
			notifySessionStateObservers(undefined);
			applicationMessageRuntime.close(
				'control_session_disconnect: gateway control session disconnected',
			);
			resolveAcceptedSessionWaiters(undefined);
			rejectPendingGatewayControlCommandResults(
				new Error('control_session_disconnect: gateway control session disconnected'),
			);
		});
		socket.on('control:hello', (payload: GatewayControlHello, acknowledge) => {
			const parsedHello = GatewayControlHelloSchema.safeParse(payload);
			const responseAttachmentGeneration = parsedHello.success
				? parsedHello.data.attachmentGeneration
				: Math.max(1, highestAcceptedAttachmentGeneration);
			if (
				!parsedHello.success ||
				parsedHello.data.controllerEpoch !== options.identity.controllerEpoch ||
				parsedHello.data.domain !== 'gateway_control' ||
				parsedHello.data.gatewayEpoch !== options.identity.generationId ||
				parsedHello.data.peerId !== options.identity.peerId ||
				parsedHello.data.processEpoch !== options.identity.processEpoch ||
				parsedHello.data.protocolVersion !== CONTROL_PROTOCOL_VERSION
			) {
				const response = {
					attachmentGeneration: responseAttachmentGeneration,
					connectionId: randomUUID(),
					controllerEpoch: options.identity.controllerEpoch,
					outcome: parsedHello.success ? 'generation_mismatch' : 'rejected',
					sessionId: randomUUID(),
				} satisfies GatewayControlHelloResponse;
				acknowledge(response);
				socket.disconnect(true);
				return;
			}
			if (parsedHello.data.attachmentGeneration <= highestAcceptedAttachmentGeneration) {
				const response = {
					attachmentGeneration: parsedHello.data.attachmentGeneration,
					connectionId: randomUUID(),
					controllerEpoch: options.identity.controllerEpoch,
					outcome: 'stale_attachment',
					sessionId: randomUUID(),
				} satisfies GatewayControlHelloResponse;
				acknowledge(response);
				socket.disconnect(true);
				return;
			}
			const response = {
				attachmentGeneration: parsedHello.data.attachmentGeneration,
				connectionId: randomUUID(),
				controllerEpoch: options.identity.controllerEpoch,
				outcome: 'accepted',
				sessionId: randomUUID(),
			} satisfies GatewayControlHelloResponse;
			const supersededSocket = acceptedSocket;
			highestAcceptedAttachmentGeneration = parsedHello.data.attachmentGeneration;
			resetGatewayControlStateForAcceptedAttachment();
			acceptedSocket = socket;
			acceptedSession = Object.freeze({
				...gatewayControlPublicIdentityFor(options.identity),
				bootId: options.identity.processEpoch,
				attachmentGeneration: parsedHello.data.attachmentGeneration,
				connectionId: response.connectionId,
				gatewayEpoch: parsedHello.data.gatewayEpoch,
				processEpoch: parsedHello.data.processEpoch,
				sessionId: response.sessionId,
			});
			acknowledge(response);
			resolveAcceptedSessionWaiters(acceptedSession);
			notifyAcceptedSessionObservers(acceptedSession);
			notifySessionStateObservers(acceptedSession);
			if (supersededSocket !== undefined && supersededSocket !== socket) {
				supersededSocket.disconnect(true);
			}
		});
		applicationMessageRuntime.bindSocket(socket);
	});

	function expireIssuedCredentials(): void {
		const observedAtMs = now();
		for (const [credentialId, storedCredential] of credentials) {
			if (
				(storedCredential.state === 'issued' || storedCredential.state === 'consuming') &&
				storedCredential.credential.expiresAtMs <= observedAtMs
			) {
				storedCredential.state = 'expired';
				storedCredential.terminalAtMs = observedAtMs;
			}
			if (
				storedCredential.terminalAtMs !== undefined &&
				observedAtMs - storedCredential.terminalAtMs >= nonceTtlMs
			) {
				credentials.delete(credentialId);
			}
		}
	}

	function expireConsumedReadyRequests(): void {
		const observedAtMs = now();
		for (const [requestId, consumedReadyRequest] of consumedReadyRequestIds) {
			if (observedAtMs - consumedReadyRequest.consumedAtMs >= nonceTtlMs) {
				consumedReadyRequestIds.delete(requestId);
			}
		}
	}

	function expireFailedUpgradeAttempts(observedAtMs = now()): void {
		for (const [credentialId, attemptWindow] of failedUpgradeAttemptsBySource) {
			const windowAgeMs = observedAtMs - attemptWindow.windowStartedAtMs;
			if (windowAgeMs < 0 || windowAgeMs >= nonceTtlMs) {
				failedUpgradeAttemptsBySource.delete(credentialId);
			}
		}
	}

	function failedUpgradeAttemptLimitReached(proof: ControlHandshakeProof): boolean {
		const observedAtMs = now();
		expireFailedUpgradeAttempts(observedAtMs);
		const attemptWindow = failedUpgradeAttemptsBySource.get(proof.credentialId);
		return (
			attemptWindow !== undefined &&
			attemptWindow.count >= GATEWAY_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT
		);
	}

	function recordFailedUpgradeAttempt(proof: ControlHandshakeProof): void {
		const observedAtMs = now();
		expireFailedUpgradeAttempts(observedAtMs);
		const attemptWindow = failedUpgradeAttemptsBySource.get(proof.credentialId);
		if (attemptWindow === undefined) {
			failedUpgradeAttemptsBySource.set(proof.credentialId, {
				count: 1,
				windowStartedAtMs: observedAtMs,
			});
			return;
		}
		attemptWindow.count += 1;
	}

	function issueCredential(): GatewayControlIssuedCredential {
		expireIssuedCredentials();
		if (credentials.size >= CONTROL_QUEUE_LIMITS.queueMessageCap) {
			throw new Error('gateway control credential queue is full');
		}
		const issuedAtMs = now();
		const credential: GatewayControlIssuedCredential = {
			...gatewayControlPublicIdentityFor(options.identity),
			audience: 'gateway_control',
			credentialId: randomUUID(),
			expiresAtMs: issuedAtMs + nonceTtlMs,
			issuedAtMs,
			nonce: randomBytes(32).toString('base64url'),
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		};
		credentials.set(credential.credentialId, { credential, state: 'issued' });
		return credential;
	}

	function consumeReadyProofForCredentialIssue(
		proof: ControlReadyRequestProof,
	): ReadyProofConsumptionResult {
		expireConsumedReadyRequests();
		if (consumedReadyRequestIds.has(proof.requestId)) {
			return { accepted: false, reason: 'replayed_ready_request' };
		}
		const observedAtMs = now();
		if (proof.issuedAtMs - clockSkewToleranceMs > observedAtMs) {
			return { accepted: false, reason: 'future_ready_request' };
		}
		if (proof.issuedAtMs + nonceTtlMs + clockSkewToleranceMs <= observedAtMs) {
			return { accepted: false, reason: 'expired_ready_request' };
		}
		if (!readyProofMatchesIdentity(proof, options.identity)) {
			return { accepted: false, reason: 'identity_mismatch' };
		}
		if (!verifyGatewayControlReadyProofSignature(proof, options.verifierPublicKeyPem)) {
			return { accepted: false, reason: 'signature_mismatch' };
		}
		consumedReadyRequestIds.set(proof.requestId, { consumedAtMs: observedAtMs });
		return { accepted: true };
	}

	function consumeCredentialForUpgrade(proof: ControlHandshakeProof): boolean {
		expireIssuedCredentials();
		const storedCredential = credentials.get(proof.credentialId);
		if (storedCredential?.state !== 'issued') return false;
		storedCredential.state = 'consuming';
		if (
			proof.expiresAtMs + clockSkewToleranceMs <= now() ||
			!proofMatchesCredential(proof, storedCredential.credential) ||
			!verifyGatewayControlProofSignature(proof, options.verifierPublicKeyPem)
		) {
			storedCredential.state = 'failed';
			storedCredential.terminalAtMs = now();
			return false;
		}
		storedCredential.state = 'accepted';
		storedCredential.terminalAtMs = now();
		return true;
	}

	return {
		close: async () => {
			applicationMessageRuntime.close('gateway control service closed');
			resolveAcceptedSessionWaiters(undefined);
			acceptedSession = undefined;
			acceptedSocket = undefined;
			notifySessionStateObservers(undefined);
			acceptedSessionObservers.clear();
			sessionStateObservers.clear();
			rejectPendingGatewayControlCommandResults(new GatewayControlSessionUnavailableError());
			await socketServer.close();
		},
		emitApplicationMessage: (intent, emitOptions) =>
			applicationMessageRuntime.emitApplicationMessage(intent, emitOptions),
		getCredentialState: (credentialId) => {
			expireIssuedCredentials();
			return credentials.get(credentialId)?.state;
		},
		getCurrentAcceptedSession: () => acceptedSession,
		handleReadyRequest: (req, res) => {
			if (req.method !== 'GET') {
				writeTextResponse(res, 405, 'method not allowed\n');
				return true;
			}
			const readyProof = requestHasQueryParameters(req)
				? undefined
				: parseReadyRequestProofFromHeaders(req);
			if (readyProof === undefined || !consumeReadyProofForCredentialIssue(readyProof).accepted) {
				writeTextResponse(res, 401, 'unauthorized\n');
				return true;
			}
			try {
				const credential = issueCredential();
				res.statusCode = 200;
				res.setHeader('cache-control', 'no-store');
				res.setHeader('content-type', 'application/json; charset=utf-8');
				res.end(`${JSON.stringify(credential)}\n`);
			} catch (error: unknown) {
				writeTextResponse(
					res,
					429,
					error instanceof Error ? `${error.message}\n` : 'too many credentials\n',
				);
			}
			return true;
		},
		handleUpgrade: (req, socket, head) => {
			const proof = requestHasValidSocketIoUpgradeQuery(req)
				? parseHandshakeProofFromHeaders(req)
				: undefined;
			if (proof === undefined || failedUpgradeAttemptLimitReached(proof)) {
				writeUpgradeFailure(socket);
				return true;
			}
			if (!consumeCredentialForUpgrade(proof)) {
				recordFailedUpgradeAttempt(proof);
				writeUpgradeFailure(socket);
				return true;
			}
			try {
				handleEngineUpgrade(req, socket, head);
			} catch (error: unknown) {
				const storedCredential = credentials.get(proof.credentialId);
				if (storedCredential?.state === 'accepted') {
					storedCredential.state = 'failed';
					storedCredential.terminalAtMs = now();
				}
				throw error;
			}
			return true;
		},
		observeAcceptedSessions: (observer, onObserverFailure) => {
			if (acceptedSessionObservers.size >= GATEWAY_CONTROL_ACCEPTED_SESSION_OBSERVER_LIMIT) {
				throw new GatewayControlAcceptedSessionObserverOverflowError(
					GATEWAY_CONTROL_ACCEPTED_SESSION_OBSERVER_LIMIT,
				);
			}
			acceptedSessionObservers.set(observer, onObserverFailure);
			return {
				unsubscribe: (): void => {
					acceptedSessionObservers.delete(observer);
				},
			};
		},
		observeSessionState: (observer, onObserverFailure) => {
			if (sessionStateObservers.size >= GATEWAY_CONTROL_ACCEPTED_SESSION_OBSERVER_LIMIT) {
				throw new GatewayControlAcceptedSessionObserverOverflowError(
					GATEWAY_CONTROL_ACCEPTED_SESSION_OBSERVER_LIMIT,
				);
			}
			sessionStateObservers.set(observer, onObserverFailure);
			return {
				unsubscribe: (): void => {
					sessionStateObservers.delete(observer);
				},
			};
		},
		waitForAcceptedSession: async () => {
			const session = acceptedSession;
			if (session !== undefined && acceptedSocket?.connected === true) return session;
			if (acceptedSessionWaiters.length >= CONTROL_QUEUE_LIMITS.queueMessageCap) {
				throw new GatewayControlSessionWaiterOverflowError(CONTROL_QUEUE_LIMITS.queueMessageCap);
			}
			const accepted = await new Promise<GatewayControlAcceptedSession | undefined>((resolve) => {
				const finish = (result: GatewayControlAcceptedSession | undefined): void => {
					clearTimeout(timeout);
					const waiterIndex = acceptedSessionWaiters.indexOf(finish);
					if (waiterIndex >= 0) acceptedSessionWaiters.splice(waiterIndex, 1);
					resolve(result);
				};
				const timeout = setTimeout(
					() => finish(undefined),
					CONTROL_SESSION_TIMING_MS.connectTimeout,
				);
				timeout.unref?.();
				acceptedSessionWaiters.push(finish);
			});
			if (accepted === undefined) throw new GatewayControlSessionUnavailableError();
			return accepted;
		},
	};
}
