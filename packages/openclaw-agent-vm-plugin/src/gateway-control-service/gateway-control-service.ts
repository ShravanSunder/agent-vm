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
	ControlDeliveryPolicySchema,
	ControlHandshakeProofSchema,
	ControlReadyRequestProofSchema,
	ControlEnvelopeSchema,
	ControlHelloSchema,
	assertControlMessageReceiptAccepted,
	assertControlEnvelopeMatchesDomainMessage,
	buildControlMessageRejectionReceipt,
	buildControlMessageReceipt,
	evaluateControlSequenceContinuity,
	extractDomainCommandResultResponseToMessageId,
	orderControlMessagesByEnvelopeSequence,
	type ControlDeliveryPolicy,
	type ControlHandshakeCredential,
	type ControlEnvelope,
	type ControlHandshakeProof,
	type ControlHello,
	type ControlHelloResponse,
	type ControlReadyRequestProof,
	type ControlSequenceContinuityDecision,
	type DomainControlMessageIdentity,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcMessageSchema,
	assertGatewayControlEnvelopeDeliveryPolicy,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	type GatewayControlControllerToGatewayEvents,
	type GatewayControlGatewayToControllerEvents,
} from '@agent-vm/gateway-control-contracts';
import { Server as EngineIoServer } from 'engine.io';
import type { Socket } from 'socket.io';
import { Server as SocketIoServer } from 'socket.io';

export const GATEWAY_CONTROL_READY_PATH = '/__agent-vm/ready';
export const GATEWAY_CONTROL_SOCKET_PATH = '/__agent-vm/gateway-control';
export const GATEWAY_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT = 8;
export {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	buildControlHandshakeSignaturePayload as buildGatewayControlSignaturePayload,
} from '@agent-vm/control-protocol-contracts';

export type GatewayControlNonceState = 'issued' | 'consuming' | 'accepted' | 'failed' | 'expired';
export type GatewayControlReadyRejectionReason =
	| 'expired_ready_request'
	| 'future_ready_request'
	| 'identity_mismatch'
	| 'invalid_ready_proof'
	| 'replayed_ready_request'
	| 'signature_mismatch';

export interface GatewayControlIdentity {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly zoneId: string;
}

export interface GatewayControlServiceOptions {
	readonly applicationMessageHandler?: GatewayControlApplicationMessageHandler;
	readonly handleEngineUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
	readonly identity: GatewayControlIdentity;
	readonly nonceTtlMs?: number;
	readonly now?: () => number;
	readonly verifierPublicKeyPem: string;
}

export interface GatewayControlApplicationMessageHandler {
	buildHandlerFailureResult?(
		context: GatewayControlApplicationMessageContext,
		error: unknown,
	): unknown;
	handle(context: GatewayControlApplicationMessageContext): Promise<unknown>;
	messageIdentity(context: GatewayControlApplicationMessageContext): DomainControlMessageIdentity;
}

export interface GatewayControlApplicationMessageContext {
	readonly envelope: ControlEnvelope;
	readonly payload: unknown;
}

type ControlHelloWithSequenceContinuity = ControlHello & {
	readonly lastSeenControllerSequence: number;
	readonly lastSeenPeerSequence: number;
};

function helloHasSequenceContinuity(
	hello: ControlHello,
): hello is ControlHelloWithSequenceContinuity {
	return hello.lastSeenControllerSequence !== undefined && hello.lastSeenPeerSequence !== undefined;
}

export type GatewayControlIssuedCredential = GatewayControlIdentity & ControlHandshakeCredential;

export interface GatewayControlAcceptedSession extends GatewayControlIdentity {
	readonly connectionId: string;
	readonly sessionId: string;
}

interface StoredGatewayControlCredential {
	readonly credential: GatewayControlIssuedCredential;
	terminalAtMs?: number | undefined;
	state: GatewayControlNonceState;
}

interface FailedUpgradeAttemptWindow {
	count: number;
	readonly windowStartedAtMs: number;
}

interface ConsumedReadyRequest {
	readonly consumedAtMs: number;
}

interface PendingGatewayControlCommandResult {
	readonly promise: Promise<unknown>;
	readonly reject: (error: Error) => void;
	readonly resolve: (payload: unknown) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface LatestWinsGatewayControlMessage {
	readonly envelope: ControlEnvelope;
	readonly payload: ReturnType<typeof GatewayControlRpcMessageSchema.parse>;
}

export interface GatewayControlEmitApplicationMessageOptions {
	readonly commandResultTimeoutMs?: number;
	readonly waitForReceipt?: boolean;
}

type ReadyProofConsumptionResult =
	| { readonly accepted: true }
	| {
			readonly accepted: false;
			readonly reason: GatewayControlReadyRejectionReason;
	  };

export interface GatewayControlService {
	readonly handleReadyRequest: (req: IncomingMessage, res: ServerResponse) => boolean;
	readonly handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	readonly getCredentialState: (credentialId: string) => GatewayControlNonceState | undefined;
	readonly nextPeerSequence: (options?: {
		readonly deliveryPolicy?: ControlDeliveryPolicy;
	}) => number;
	readonly emitApplicationMessage: (
		envelope: ControlEnvelope,
		domainMessage: DomainControlMessageIdentity,
		payload: unknown,
		options?: GatewayControlEmitApplicationMessageOptions,
	) => Promise<unknown>;
	readonly getAcceptedSession: () => Promise<GatewayControlAcceptedSession>;
	readonly close: () => Promise<void>;
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

function buildLatestWinsGatewayControlKey(envelope: ControlEnvelope): string {
	return [
		envelope.domain,
		envelope.zoneId,
		envelope.peerId,
		envelope.kind,
		envelope.operation ?? '<none>',
	].join('\u0000');
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

function buildGatewayControlResponseEnvelope(options: {
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

function waitForGatewayControlCommandResult(options: {
	readonly messageId: string;
	readonly pendingCommandResults: Map<string, PendingGatewayControlCommandResult>;
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
				new Error(`gateway control command result timed out: ${options.messageId}`),
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
	const pendingResult: PendingGatewayControlCommandResult = {
		promise,
		reject: rejectPromise,
		resolve: resolvePromise,
		timeout: setTimeout(() => {
			if (options.pendingCommandResults.get(options.messageId) === pendingResult) {
				options.pendingCommandResults.delete(options.messageId);
			}
			rejectPromise(new Error(`gateway control command result timed out: ${options.messageId}`));
		}, options.timeoutMs),
	};
	pendingResult.timeout.unref?.();
	options.pendingCommandResults.set(options.messageId, pendingResult);
	return promise;
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
	const latestWinsQueue = new Map<string, LatestWinsGatewayControlMessage>();
	const handleEngineUpgrade =
		options.handleEngineUpgrade ??
		((req: IncomingMessage, socket: Duplex, head: Buffer): void => {
			engine.handleUpgrade(req, socket, head);
		});
	let acceptedSocket:
		| Socket<GatewayControlControllerToGatewayEvents, GatewayControlGatewayToControllerEvents>
		| undefined;
	let acceptedSession: GatewayControlAcceptedSession | undefined;
	let lastSeenControllerSequence = 0;
	let lastSeenPeerSequence = 0;
	let nextPeerSequenceValue = 1;
	let latestWinsFlushScheduled = false;
	const acceptedSessionWaiters: ((session: GatewayControlAcceptedSession | undefined) => void)[] =
		[];

	function reservePeerSequence(): number {
		const sequence = Math.max(nextPeerSequenceValue, lastSeenPeerSequence + 1);
		nextPeerSequenceValue = sequence + 1;
		return sequence;
	}

	function nextPeerSequence(
		sequenceRequest: { readonly deliveryPolicy?: ControlDeliveryPolicy } = {},
	): number {
		if (
			sequenceRequest.deliveryPolicy === 'droppable' ||
			sequenceRequest.deliveryPolicy === 'latest_wins'
		) {
			return lastSeenPeerSequence + 1;
		}
		return reservePeerSequence();
	}

	function recordLastSeenPeerSequence(sequence: number): void {
		lastSeenPeerSequence = Math.max(lastSeenPeerSequence, sequence);
		nextPeerSequenceValue = Math.max(nextPeerSequenceValue, lastSeenPeerSequence + 1);
	}

	function evaluateReservedOutboundPeerSequence(
		envelope: ControlEnvelope,
	): ControlSequenceContinuityDecision {
		const deliveryPolicy: ControlDeliveryPolicy = ControlDeliveryPolicySchema.parse(
			envelope.deliveryPolicy,
		);
		if (deliveryPolicy === 'droppable' || deliveryPolicy === 'latest_wins') {
			return evaluateControlSequenceContinuity({
				envelope,
				lastSeenSequence: lastSeenPeerSequence,
			});
		}
		if (envelope.sequence <= lastSeenPeerSequence) {
			return evaluateControlSequenceContinuity({
				envelope,
				lastSeenSequence: lastSeenPeerSequence,
			});
		}
		const reservedPeerSequenceFrontier = nextPeerSequenceValue - 1;
		if (envelope.sequence <= reservedPeerSequenceFrontier) {
			return {
				action: 'accept',
				nextLastSeenSequence: envelope.sequence,
			};
		}
		return {
			action: 'stale',
			closeReason: 'sequence_gap',
			nextLastSeenSequence: lastSeenPeerSequence,
			safeMessage: `control sequence was not reserved: last=${String(lastSeenPeerSequence)} reserved=${String(reservedPeerSequenceFrontier)} received=${String(envelope.sequence)} kind=${envelope.kind} operation=${envelope.operation ?? '<none>'} delivery=${envelope.deliveryPolicy} sessionId=${envelope.sessionId}`,
		};
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
			latestWinsQueue.clear();
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

	function resetGatewayControlSessionForFullResync(
		socket: Socket<
			GatewayControlControllerToGatewayEvents,
			GatewayControlGatewayToControllerEvents
		>,
	): void {
		const previousSocket = acceptedSocket;
		acceptedSocket = undefined;
		acceptedSession = undefined;
		latestWinsQueue.clear();
		lastSeenControllerSequence = 0;
		lastSeenPeerSequence = 0;
		nextPeerSequenceValue = 1;
		resolveAcceptedSessionWaiters(undefined);
		rejectPendingGatewayControlCommandResults(
			new Error('resync_required: gateway control session requires full hello resync'),
		);
		if (previousSocket !== undefined && previousSocket !== socket) {
			previousSocket.disconnect(true);
		}
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

	function acceptHelloSequenceContinuity(
		hello: ControlHelloWithSequenceContinuity,
	): ControlHelloResponse['outcome'] {
		if (
			hello.lastSeenControllerSequence < lastSeenControllerSequence ||
			hello.lastSeenPeerSequence < lastSeenPeerSequence
		) {
			return 'resync_required';
		}
		lastSeenControllerSequence = Math.max(
			lastSeenControllerSequence,
			hello.lastSeenControllerSequence,
		);
		lastSeenPeerSequence = Math.max(lastSeenPeerSequence, hello.lastSeenPeerSequence);
		nextPeerSequenceValue = lastSeenPeerSequence + 1;
		return 'accepted';
	}

	function helloContinuityOutcome(hello: ControlHello): ControlHelloResponse['outcome'] {
		const previousSession = acceptedSession;
		if (previousSession === undefined) {
			if (hello.previousSessionId === undefined) {
				return 'accepted';
			}
			if (!helloHasSequenceContinuity(hello)) {
				return 'resync_required';
			}
			return acceptHelloSequenceContinuity(hello);
		}
		if (
			hello.previousSessionId !== previousSession.sessionId ||
			!helloHasSequenceContinuity(hello)
		) {
			return 'resync_required';
		}
		return acceptHelloSequenceContinuity(hello);
	}

	socketServer.on('connection', (socket) => {
		socket.once('disconnect', () => {
			if (acceptedSocket === socket) {
				acceptedSocket = undefined;
				acceptedSession = undefined;
				latestWinsQueue.clear();
				resolveAcceptedSessionWaiters(undefined);
				rejectPendingGatewayControlCommandResults(
					new Error('control_session_disconnect: gateway control session disconnected'),
				);
			}
		});
		socket.on('control:hello', (payload: ControlHello, acknowledge) => {
			const parsedHello = ControlHelloSchema.safeParse(payload);
			if (
				!parsedHello.success ||
				parsedHello.data.bootId !== options.identity.bootId ||
				parsedHello.data.controllerEpoch !== options.identity.controllerEpoch ||
				parsedHello.data.domain !== 'gateway_control' ||
				parsedHello.data.peerId !== options.identity.peerId ||
				parsedHello.data.protocolVersion !== CONTROL_PROTOCOL_VERSION
			) {
				const response = {
					connectionId: randomUUID(),
					controllerEpoch: options.identity.controllerEpoch,
					outcome: 'rejected',
					sessionId: randomUUID(),
				} satisfies ControlHelloResponse;
				acknowledge(response);
				socket.disconnect(true);
				return;
			}
			const outcome = helloContinuityOutcome(parsedHello.data);
			const response = {
				connectionId: randomUUID(),
				controllerEpoch: options.identity.controllerEpoch,
				outcome,
				sessionId: randomUUID(),
			} satisfies ControlHelloResponse;
			if (outcome !== 'accepted') {
				if (outcome === 'resync_required') {
					resetGatewayControlSessionForFullResync(socket);
					acknowledge(response);
					return;
				}
				acknowledge(response);
				socket.disconnect(true);
				return;
			}
			if (acceptedSocket !== undefined && acceptedSocket !== socket) {
				acceptedSocket.disconnect(true);
			}
			acceptedSocket = socket;
			acceptedSession = {
				...options.identity,
				connectionId: response.connectionId,
				sessionId: response.sessionId,
			};
			acknowledge(response);
			resolveAcceptedSessionWaiters(acceptedSession);
		});
		socket.on('control:message', (envelopePayload, payload, acknowledge) => {
			void (async () => {
				try {
					const envelope = ControlEnvelopeSchema.parse(envelopePayload);
					const gatewayPayload = GatewayControlRpcMessageSchema.parse(payload);
					if (envelope.deliveryPolicy === 'forbidden_bulk') {
						throw new Error('forbidden bulk message cannot be sent on the gateway control session');
					}
					assertInboundEnvelopeMatchesAcceptedSession(socket, envelope);
					const responseToMessageId = extractDomainCommandResultResponseToMessageId(gatewayPayload);
					const sequenceDecision = evaluateControlSequenceContinuity({
						envelope,
						lastSeenSequence: lastSeenControllerSequence,
					});
					if (sequenceDecision.action === 'drop') {
						acknowledge?.(buildControlMessageReceipt());
						return;
					}
					if (sequenceDecision.action === 'stale') {
						closeGatewayControlSessionForSequenceGap(socket, sequenceDecision.safeMessage);
						return;
					}
					lastSeenControllerSequence = sequenceDecision.nextLastSeenSequence;
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
					if (options.applicationMessageHandler === undefined) {
						throw new Error('no gateway control application message handler configured');
					}
					assertControlEnvelopeMatchesDomainMessage(
						envelope,
						options.applicationMessageHandler.messageIdentity({
							envelope,
							payload: gatewayPayload,
						}),
					);
					assertGatewayControlEnvelopeDeliveryPolicy(envelope);
					acknowledge?.(buildControlMessageReceipt());
					let responsePayload: unknown;
					try {
						responsePayload = await options.applicationMessageHandler.handle({
							envelope,
							payload: gatewayPayload,
						});
					} catch (error) {
						if (
							envelope.kind !== 'command' ||
							options.applicationMessageHandler.buildHandlerFailureResult === undefined
						) {
							throw error;
						}
						responsePayload = await options.applicationMessageHandler.buildHandlerFailureResult(
							{ envelope, payload: gatewayPayload },
							error,
						);
					}
					if (responsePayload !== undefined) {
						const parsedResponsePayload = GatewayControlRpcMessageSchema.parse(responsePayload);
						const responseSequence = reservePeerSequence();
						const responseEnvelope = buildGatewayControlResponseEnvelope({
							requestEnvelope: envelope,
							sequence: responseSequence,
						});
						void (async () => {
							const receiptPayload = await socket
								.timeout(CONTROL_SESSION_TIMING_MS.commandAckTimeout)
								.emitWithAck('control:message', responseEnvelope, parsedResponsePayload);
							assertControlMessageReceiptAccepted(receiptPayload);
							recordLastSeenPeerSequence(responseSequence);
						})().catch((error: unknown) => {
							closeGatewayControlSessionForReservedResponseFailure(socket, error);
						});
					}
				} catch {
					acknowledge?.(
						buildControlMessageRejectionReceipt({
							errorClass: 'schema_validation_failed',
							safeMessage: 'gateway control message was rejected',
						}),
					);
				}
			})();
		});
	});

	async function waitForAcceptedSession(): Promise<GatewayControlAcceptedSession | undefined> {
		const session = acceptedSession;
		const socket = acceptedSocket;
		if (session !== undefined && socket !== undefined && socket.connected) {
			return session;
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

	async function emitApplicationMessage(
		envelope: ControlEnvelope,
		domainMessage: DomainControlMessageIdentity,
		payload: unknown,
		emitOptions?: GatewayControlEmitApplicationMessageOptions,
	): Promise<unknown> {
		ControlEnvelopeSchema.parse(envelope);
		assertControlEnvelopeMatchesDomainMessage(envelope, domainMessage);
		assertGatewayControlEnvelopeDeliveryPolicy(envelope);
		if (envelope.deliveryPolicy === 'forbidden_bulk') {
			throw new Error('forbidden bulk message cannot be sent on the gateway control session');
		}
		const session = await waitForAcceptedSession();
		const socket = acceptedSocket;
		if (session === undefined || socket === undefined || !socket.connected) {
			throw new Error('gateway control session is not connected');
		}
		if (
			envelope.sessionId !== session.sessionId ||
			envelope.connectionId !== session.connectionId
		) {
			throw new Error('gateway control envelope session identity does not match accepted session');
		}
		const sequenceDecision = evaluateReservedOutboundPeerSequence(envelope);
		if (sequenceDecision.action === 'drop') {
			throw new Error(sequenceDecision.safeMessage);
		}
		if (sequenceDecision.action === 'stale') {
			closeGatewayControlSessionForSequenceGap(socket, sequenceDecision.safeMessage);
			throw new Error(sequenceDecision.safeMessage);
		}
		const gatewayPayload = GatewayControlRpcMessageSchema.parse(payload);
		if (envelope.deliveryPolicy === 'latest_wins') {
			const latestWinsKey = buildLatestWinsGatewayControlKey(envelope);
			if (emitOptions?.waitForReceipt === true) {
				latestWinsQueue.delete(latestWinsKey);
				const receiptPayload = await socket
					.timeout(CONTROL_SESSION_TIMING_MS.commandAckTimeout)
					.emitWithAck('control:message', envelope, gatewayPayload);
				assertControlMessageReceiptAccepted(receiptPayload);
				recordLastSeenPeerSequence(sequenceDecision.nextLastSeenSequence);
				return receiptPayload;
			}
			latestWinsQueue.set(latestWinsKey, {
				envelope,
				payload: gatewayPayload,
			});
			recordLastSeenPeerSequence(sequenceDecision.nextLastSeenSequence);
			scheduleLatestWinsFlush();
			return undefined;
		}
		if (envelope.deliveryPolicy === 'droppable') {
			socket.volatile.emit('control:message', envelope, gatewayPayload, () => undefined);
			recordLastSeenPeerSequence(sequenceDecision.nextLastSeenSequence);
			return undefined;
		}
		const commandResultPromise =
			envelope.kind === 'command'
				? waitForGatewayControlCommandResult({
						messageId: envelope.messageId,
						pendingCommandResults,
						timeoutMs: commandResultTimeoutMsFor(envelope, emitOptions),
					})
				: undefined;
		commandResultPromise?.catch(() => undefined);
		const receiptPayload = await socket
			.timeout(CONTROL_SESSION_TIMING_MS.commandAckTimeout)
			.emitWithAck('control:message', envelope, gatewayPayload);
		assertControlMessageReceiptAccepted(receiptPayload);
		recordLastSeenPeerSequence(sequenceDecision.nextLastSeenSequence);
		if (commandResultPromise !== undefined) {
			return await commandResultPromise;
		}
		return receiptPayload;
	}

	function scheduleLatestWinsFlush(): void {
		if (latestWinsFlushScheduled) {
			return;
		}
		latestWinsFlushScheduled = true;
		setImmediate(() => {
			latestWinsFlushScheduled = false;
			const socket = acceptedSocket;
			if (socket === undefined || !socket.connected) {
				latestWinsQueue.clear();
				return;
			}
			const messages = [...latestWinsQueue.values()];
			latestWinsQueue.clear();
			for (const message of orderControlMessagesByEnvelopeSequence(messages)) {
				socket.volatile.emit('control:message', message.envelope, message.payload, () => undefined);
			}
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
			...options.identity,
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
			latestWinsQueue.clear();
			await socketServer.close();
		},
		emitApplicationMessage,
		nextPeerSequence,
		getAcceptedSession: async () => {
			const session = await waitForAcceptedSession();
			if (session === undefined) {
				throw new Error('gateway control session is not connected');
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
