import { randomBytes, randomUUID, verify as verifySignature, createPublicKey } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import {
	CONTROL_PROTOCOL_VERSION,
	CONTROL_READY_HEADER_NAMES,
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_QUEUE_LIMITS,
	CONTROL_SESSION_TIMING_MS,
	ControlHandshakeProofSchema,
	ControlReadyRequestProofSchema,
	type ControlEnvelope,
	type ControlHandshakeProof,
	type ControlReadyRequestProof,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
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

import { createGatewayControlApplicationMessageRuntime } from './gateway-control-application-message-runtime.js';
import {
	GatewayControlSessionUnavailableError,
	GatewayControlSessionWaiterOverflowError,
} from './gateway-control-service-contracts.js';
import type {
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
} from './gateway-control-service-contracts.js';

export const GATEWAY_CONTROL_READY_PATH = '/__agent-vm/ready';
export const GATEWAY_CONTROL_SOCKET_PATH = '/__agent-vm/gateway-control';
export const GATEWAY_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT = 8;
export {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	buildControlHandshakeSignaturePayload as buildGatewayControlSignaturePayload,
} from '@agent-vm/control-protocol-contracts';
export { GATEWAY_CONTROL_BOOTSTRAP_AUTHORITY_KEY } from './gateway-control-admission-runtime.js';
export {
	GatewayControlSessionUnavailableError,
	GatewayControlSessionWaiterOverflowError,
} from './gateway-control-service-contracts.js';
export type {
	GatewayControlAcceptedSession,
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
} from './gateway-control-service-contracts.js';

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

function writeUpgradeFailure(socket: Duplex): void {
	socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
	socket.destroy();
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
}

function parseIntegerHeader(req: IncomingMessage, name: string): number | undefined {
	const value = firstHeader(req, name);
	if (value === undefined || !/^[0-9]+$/u.test(value)) {
		return undefined;
	}
	return Number.parseInt(value, 10);
}

function requestHasQueryParameters(req: IncomingMessage): boolean {
	const url = new URL(req.url ?? '/', 'http://openclaw.local');
	return [...url.searchParams.keys()].length > 0;
}

function requestHasValidSocketIoUpgradeQuery(req: IncomingMessage): boolean {
	const url = new URL(req.url ?? '/', 'http://openclaw.local');
	const allowedEntries = new Set(['EIO', 'transport']);
	for (const key of url.searchParams.keys()) {
		if (!allowedEntries.has(key)) {
			return false;
		}
	}
	return (
		url.searchParams.getAll('EIO').length === 1 &&
		url.searchParams.get('EIO') === '4' &&
		url.searchParams.getAll('transport').length === 1 &&
		url.searchParams.get('transport') === 'websocket'
	);
}

function failedUpgradeAttemptCredentialKey(proof: ControlHandshakeProof): string {
	return proof.credentialId;
}

function parseHandshakeProofFromHeaders(req: IncomingMessage): ControlHandshakeProof | undefined {
	if (
		firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.protocol) !==
		CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE
	) {
		return undefined;
	}
	const issuedAtMs = parseIntegerHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.issuedAtMs);
	const expiresAtMs = parseIntegerHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.expiresAtMs);
	if (issuedAtMs === undefined || expiresAtMs === undefined) {
		return undefined;
	}
	const parsed = ControlHandshakeProofSchema.safeParse({
		audience: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.domain),
		bootId: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.bootId),
		controllerEpoch: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch),
		credentialId: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.credentialId),
		expiresAtMs,
		generationId: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.generationId),
		issuedAtMs,
		nonce: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.nonce),
		peerId: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.peerId),
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		signature: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.signature),
		zoneId: firstHeader(req, CONTROL_HANDSHAKE_HEADER_NAMES.zoneId),
	});
	return parsed.success ? parsed.data : undefined;
}

function parseReadyRequestProofFromHeaders(
	req: IncomingMessage,
): ControlReadyRequestProof | undefined {
	if (
		firstHeader(req, CONTROL_READY_HEADER_NAMES.protocol) !==
		CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE
	) {
		return undefined;
	}
	const issuedAtMs = parseIntegerHeader(req, CONTROL_READY_HEADER_NAMES.issuedAtMs);
	if (issuedAtMs === undefined) {
		return undefined;
	}
	const parsed = ControlReadyRequestProofSchema.safeParse({
		audience: firstHeader(req, CONTROL_READY_HEADER_NAMES.domain),
		bootId: firstHeader(req, CONTROL_READY_HEADER_NAMES.bootId),
		controllerEpoch: firstHeader(req, CONTROL_READY_HEADER_NAMES.controllerEpoch),
		generationId: firstHeader(req, CONTROL_READY_HEADER_NAMES.generationId),
		issuedAtMs,
		peerId: firstHeader(req, CONTROL_READY_HEADER_NAMES.peerId),
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: firstHeader(req, CONTROL_READY_HEADER_NAMES.requestId),
		signature: firstHeader(req, CONTROL_READY_HEADER_NAMES.signature),
		zoneId: firstHeader(req, CONTROL_READY_HEADER_NAMES.zoneId),
	});
	return parsed.success ? parsed.data : undefined;
}

function proofMatchesCredential(
	proof: ControlHandshakeProof,
	credential: GatewayControlIssuedCredential,
): boolean {
	return (
		proof.audience === credential.audience &&
		proof.bootId === credential.bootId &&
		proof.controllerEpoch === credential.controllerEpoch &&
		proof.credentialId === credential.credentialId &&
		proof.expiresAtMs === credential.expiresAtMs &&
		proof.generationId === credential.generationId &&
		proof.issuedAtMs === credential.issuedAtMs &&
		proof.nonce === credential.nonce &&
		proof.peerId === credential.peerId &&
		proof.protocolVersion === credential.protocolVersion &&
		proof.zoneId === credential.zoneId
	);
}

function verifyGatewayControlProofSignature(
	proof: ControlHandshakeProof,
	verifierPublicKeyPem: string,
): boolean {
	const { signature, ...signedProof } = proof;
	return verifySignature(
		null,
		Buffer.from(buildControlHandshakeSignaturePayload(signedProof)),
		createPublicKey(verifierPublicKeyPem),
		Buffer.from(signature, 'base64url'),
	);
}

function readyProofMatchesIdentity(
	proof: ControlReadyRequestProof,
	identity: GatewayControlIdentity,
): boolean {
	return (
		proof.audience === 'gateway_control' &&
		proof.bootId === identity.bootId &&
		proof.controllerEpoch === identity.controllerEpoch &&
		proof.generationId === identity.generationId &&
		proof.peerId === identity.peerId &&
		proof.protocolVersion === CONTROL_PROTOCOL_VERSION &&
		proof.zoneId === identity.zoneId
	);
}

function verifyGatewayControlReadyProofSignature(
	proof: ControlReadyRequestProof,
	verifierPublicKeyPem: string,
): boolean {
	const { signature, ...signedProof } = proof;
	return verifySignature(
		null,
		Buffer.from(buildControlReadyRequestSignaturePayload(signedProof)),
		createPublicKey(verifierPublicKeyPem),
		Buffer.from(signature, 'base64url'),
	);
}

export function createGatewayControlService(
	options: GatewayControlServiceOptions,
): GatewayControlService {
	const now = options.now ?? (() => Date.now());
	const nonceTtlMs = options.nonceTtlMs ?? CONTROL_SESSION_TIMING_MS.connectTimeout;
	const clockSkewToleranceMs = CONTROL_SESSION_TIMING_MS.clockSkewTolerance;
	const maxCredentialRecords = CONTROL_QUEUE_LIMITS.queueMessageCap;
	const credentials = new Map<string, StoredGatewayControlCredential>();
	const consumedReadyRequestIds = new Map<string, ConsumedReadyRequest>();
	const failedUpgradeAttemptsBySource = new Map<string, FailedUpgradeAttemptWindow>();
	const pendingCommandResults = new Map<string, PendingGatewayControlCommandResult>();
	const handleEngineUpgrade =
		options.handleEngineUpgrade ??
		((req: IncomingMessage, socket: Duplex, head: Buffer): void => {
			engine.handleUpgrade(req, socket, head);
		});
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
	const applicationMessageRuntime = createGatewayControlApplicationMessageRuntime({
		...(options.applicationMessageHandler === undefined
			? {}
			: { applicationMessageHandler: options.applicationMessageHandler }),
		assertInboundEnvelopeMatchesAcceptedSession,
		closeForProtocolFailure: closeGatewayControlSessionForSequenceGap,
		closeForResponseFailure: closeGatewayControlSessionForReservedResponseFailure,
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
		for (const waiter of acceptedSessionWaiters.splice(0)) {
			waiter(session);
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
			applicationMessageRuntime.close(`sequence_gap: ${safeMessage}`);
			resolveAcceptedSessionWaiters(undefined);
		}
		rejectPendingGatewayControlCommandResults(new Error(`sequence_gap: ${safeMessage}`));
		socket.disconnect(true);
	}

	function closeGatewayControlSessionForReservedResponseFailure(
		socket: Socket<
			GatewayControlControllerToGatewayEvents,
			GatewayControlGatewayToControllerEvents
		>,
		error: unknown,
	): void {
		closeGatewayControlSessionForSequenceGap(
			socket,
			error instanceof Error ? error.message : 'reserved gateway control response receipt failed',
		);
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

	const engine = new EngineIoServer({
		allowUpgrades: false,
		maxHttpBufferSize: CONTROL_QUEUE_LIMITS.maxHttpBufferBytes,
		perMessageDeflate: false,
		pingInterval: CONTROL_SESSION_TIMING_MS.engineIoPingInterval,
		pingTimeout: CONTROL_SESSION_TIMING_MS.engineIoPingTimeout,
		transports: ['websocket'],
	});
	const socketServer = new SocketIoServer<
		GatewayControlControllerToGatewayEvents,
		GatewayControlGatewayToControllerEvents
	>({
		serveClient: false,
	});
	socketServer.bind(engine);

	const commandExecutionTimeoutMsByOperation: Readonly<Record<string, number>> =
		gatewayControlCommandExecutionTimeoutMsByOperation;

	socketServer.on('connection', (socket) => {
		socket.once('disconnect', () => {
			if (acceptedSocket === socket) {
				acceptedSocket = undefined;
				acceptedSession = undefined;
				applicationMessageRuntime.close(
					'control_session_disconnect: gateway control session disconnected',
				);
				resolveAcceptedSessionWaiters(undefined);
				rejectPendingGatewayControlCommandResults(
					new Error('control_session_disconnect: gateway control session disconnected'),
				);
			}
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
			acceptedSession = {
				...gatewayControlPublicIdentityFor(options.identity),
				bootId: options.identity.processEpoch,
				attachmentGeneration: parsedHello.data.attachmentGeneration,
				connectionId: response.connectionId,
				gatewayEpoch: parsedHello.data.gatewayEpoch,
				processEpoch: parsedHello.data.processEpoch,
				sessionId: response.sessionId,
			};
			acknowledge(response);
			resolveAcceptedSessionWaiters(acceptedSession);
			if (supersededSocket !== undefined && supersededSocket !== socket) {
				supersededSocket.disconnect(true);
			}
		});
		applicationMessageRuntime.bindSocket(socket);
	});

	async function waitForAcceptedSession(): Promise<GatewayControlAcceptedSession | undefined> {
		const session = acceptedSession;
		const socket = acceptedSocket;
		if (session !== undefined && socket !== undefined && socket.connected) {
			return session;
		}
		if (acceptedSessionWaiters.length >= CONTROL_QUEUE_LIMITS.queueMessageCap) {
			throw new GatewayControlSessionWaiterOverflowError(CONTROL_QUEUE_LIMITS.queueMessageCap);
		}
		return await new Promise<GatewayControlAcceptedSession | undefined>((resolve) => {
			const timeout = setTimeout(() => {
				finish(undefined);
			}, CONTROL_SESSION_TIMING_MS.connectTimeout);
			const finish = (sessionResult: GatewayControlAcceptedSession | undefined): void => {
				clearTimeout(timeout);
				const waiterIndex = acceptedSessionWaiters.indexOf(finish);
				if (waiterIndex >= 0) {
					acceptedSessionWaiters.splice(waiterIndex, 1);
				}
				resolve(sessionResult);
			};
			timeout.unref?.();
			acceptedSessionWaiters.push(finish);
		});
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
		if (envelope.operation !== undefined) {
			return (
				commandExecutionTimeoutMsByOperation[envelope.operation] ??
				CONTROL_SESSION_TIMING_MS.commandAckTimeout
			);
		}
		return CONTROL_SESSION_TIMING_MS.commandAckTimeout;
	}

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
		for (const [sourceKey, attemptWindow] of failedUpgradeAttemptsBySource) {
			const windowAgeMs = observedAtMs - attemptWindow.windowStartedAtMs;
			if (windowAgeMs < 0 || windowAgeMs >= nonceTtlMs) {
				failedUpgradeAttemptsBySource.delete(sourceKey);
			}
		}
	}

	function failedUpgradeAttemptLimitReached(proof: ControlHandshakeProof): boolean {
		const observedAtMs = now();
		expireFailedUpgradeAttempts(observedAtMs);
		const attemptWindow = failedUpgradeAttemptsBySource.get(
			failedUpgradeAttemptCredentialKey(proof),
		);
		return (
			attemptWindow !== undefined &&
			attemptWindow.count >= GATEWAY_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT
		);
	}

	function recordFailedUpgradeAttempt(proof: ControlHandshakeProof): void {
		const observedAtMs = now();
		expireFailedUpgradeAttempts(observedAtMs);
		const sourceKey = failedUpgradeAttemptCredentialKey(proof);
		const attemptWindow = failedUpgradeAttemptsBySource.get(sourceKey);
		if (attemptWindow === undefined) {
			failedUpgradeAttemptsBySource.set(sourceKey, {
				count: 1,
				windowStartedAtMs: observedAtMs,
			});
			return;
		}
		attemptWindow.count += 1;
	}

	function issueCredential(): GatewayControlIssuedCredential {
		expireIssuedCredentials();
		if (credentials.size >= maxCredentialRecords) {
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
		if (storedCredential?.state !== 'issued') {
			return false;
		}
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
			await socketServer.close();
		},
		emitApplicationMessage: (intent, emitOptions) =>
			applicationMessageRuntime.emitApplicationMessage(intent, emitOptions),
		getCurrentAcceptedSession: () => acceptedSession,
		waitForAcceptedSession: async () => {
			const session = await waitForAcceptedSession();
			if (session === undefined) {
				throw new GatewayControlSessionUnavailableError();
			}
			return session;
		},
		getCredentialState: (credentialId) => {
			expireIssuedCredentials();
			return credentials.get(credentialId)?.state;
		},
		handleReadyRequest: (req, res) => {
			if (req.method !== 'GET') {
				writeTextResponse(res, 405, 'method not allowed\n');
				return true;
			}
			const readyProof = requestHasQueryParameters(req)
				? undefined
				: parseReadyRequestProofFromHeaders(req);
			if (readyProof === undefined) {
				writeTextResponse(res, 401, 'unauthorized\n');
				return true;
			}
			const proofConsumption = consumeReadyProofForCredentialIssue(readyProof);
			if (!proofConsumption.accepted) {
				writeTextResponse(res, 401, 'unauthorized\n');
				return true;
			}
			try {
				const credential = issueCredential();
				res.statusCode = 200;
				res.setHeader('cache-control', 'no-store');
				res.setHeader('content-type', 'application/json; charset=utf-8');
				res.end(`${JSON.stringify(credential)}\n`);
			} catch (error) {
				writeTextResponse(
					res,
					429,
					error instanceof Error ? `${error.message}\n` : 'too many credentials\n',
				);
			}
			return true;
		},
		handleUpgrade: (req, socket, head) => {
			const proof = !requestHasValidSocketIoUpgradeQuery(req)
				? undefined
				: parseHandshakeProofFromHeaders(req);
			if (proof === undefined) {
				writeUpgradeFailure(socket);
				return true;
			}
			if (failedUpgradeAttemptLimitReached(proof)) {
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
			} catch (error) {
				const storedCredential = credentials.get(proof.credentialId);
				if (storedCredential?.state === 'accepted') {
					storedCredential.state = 'failed';
					storedCredential.terminalAtMs = now();
				}
				throw error;
			}
			return true;
		},
	};
}
