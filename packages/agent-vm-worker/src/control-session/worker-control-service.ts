import { createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_QUEUE_LIMITS,
	CONTROL_READY_HEADER_NAMES,
	CONTROL_SESSION_TIMING_MS,
	ControlDeliveryPolicySchema,
	ControlEnvelopeSchema,
	ControlHandshakeProofSchema,
	ControlReadyRequestProofSchema,
	assertControlMessageReceiptAccepted,
	assertControlEnvelopeMatchesDomainMessage,
	assertDerivedControlDeliveryPolicy,
	buildControlMessageExceptionRejectionReceipt,
	buildControlMessageReceipt,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
	evaluateControlSequenceContinuity,
	extractDomainCommandResultResponseToMessageId,
	orderControlMessagesByEnvelopeSequence,
	type ControlDeliveryPolicy,
	type ControlEnvelope,
	type ControlHandshakeCredential,
	type ControlHandshakeProof,
	type ControlReadyRequestProof,
	type ControlSequenceContinuityDecision,
	type DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import {
	WorkerControlHelloSchema,
	WorkerControlRpcMessageSchema,
	type WorkerControlHello,
	type WorkerControlHelloResponse,
	workerControlCommandExecutionTimeoutMsByOperation,
	workerControlDeliveryPolicyByOperation,
	type WorkerControlControllerToWorkerEvents,
	type WorkerControlWorkerToControllerEvents,
} from '@agent-vm/worker-control-contracts';
import { Server as EngineIoServer } from 'engine.io';
import type { Socket } from 'socket.io';
import { Server as SocketIoServer } from 'socket.io';

export const WORKER_CONTROL_READY_PATH = '/__agent-vm/worker-ready';
export const WORKER_CONTROL_SOCKET_PATH = '/__agent-vm/worker-control';
export const WORKER_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT = 8;

export const WORKER_CONTROL_ENV_NAMES = {
	bootId: 'AGENT_VM_WORKER_CONTROL_BOOT_ID',
	controllerEpoch: 'AGENT_VM_WORKER_CONTROL_CONTROLLER_EPOCH',
	generationId: 'AGENT_VM_WORKER_CONTROL_GENERATION_ID',
	peerId: 'AGENT_VM_WORKER_CONTROL_PEER_ID',
	verifierPublicKeyPem: 'AGENT_VM_WORKER_CONTROL_PUBLIC_KEY_PEM',
	zoneId: 'AGENT_VM_ZONE_ID',
} as const;

export {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	buildControlHandshakeSignaturePayload as buildWorkerControlSignaturePayload,
} from '@agent-vm/control-protocol-contracts';

export type WorkerControlNonceState = 'issued' | 'consuming' | 'accepted' | 'failed' | 'expired';

export interface WorkerControlIdentity {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly zoneId: string;
}

export interface WorkerControlServiceOptions {
	readonly applicationMessageHandler?: WorkerControlApplicationMessageHandler;
	readonly handleEngineUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
	readonly identity: WorkerControlIdentity;
	readonly nonceTtlMs?: number;
	readonly now?: () => number;
	readonly verifierPublicKeyPem: string;
}

export interface WorkerControlApplicationMessageHandler {
	buildHandlerFailureResult?(
		context: WorkerControlApplicationMessageContext,
		error: unknown,
	): unknown;
	handle(context: WorkerControlApplicationMessageContext): Promise<unknown>;
	messageIdentity(context: WorkerControlApplicationMessageContext): DomainControlMessageIdentity;
}

export interface WorkerControlApplicationMessageContext {
	readonly envelope: ControlEnvelope;
	readonly payload: unknown;
}

type ControlHelloWithSequenceContinuity = WorkerControlHello & {
	readonly lastSeenControllerSequence: number;
	readonly lastSeenPeerSequence: number;
};

function helloHasSequenceContinuity(
	hello: WorkerControlHello,
): hello is ControlHelloWithSequenceContinuity {
	return hello.lastSeenControllerSequence !== undefined && hello.lastSeenPeerSequence !== undefined;
}

export type WorkerControlIssuedCredential = WorkerControlIdentity & ControlHandshakeCredential;

export interface WorkerControlAcceptedSession extends WorkerControlIdentity {
	readonly connectionId: string;
	readonly sessionId: string;
}

interface StoredWorkerControlCredential {
	readonly credential: WorkerControlIssuedCredential;
	terminalAtMs?: number | undefined;
	state: WorkerControlNonceState;
}

interface FailedUpgradeAttemptWindow {
	count: number;
	readonly windowStartedAtMs: number;
}

interface ConsumedReadyRequest {
	readonly consumedAtMs: number;
}

interface PendingWorkerControlCommandResult {
	readonly promise: Promise<unknown>;
	readonly reject: (error: Error) => void;
	readonly resolve: (payload: unknown) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface LatestWinsWorkerControlMessage {
	readonly envelope: ControlEnvelope;
	readonly payload: ReturnType<typeof WorkerControlRpcMessageSchema.parse>;
}

export interface WorkerControlEmitApplicationMessageOptions {
	readonly commandResultTimeoutMs?: number;
}

export interface WorkerControlService {
	readonly emitApplicationMessage: (
		envelope: ControlEnvelope,
		domainMessage: DomainControlMessageIdentity,
		payload: unknown,
		options?: WorkerControlEmitApplicationMessageOptions,
	) => Promise<unknown>;
	readonly getAcceptedSession: () => Promise<WorkerControlAcceptedSession>;
	readonly getCredentialState: (credentialId: string) => WorkerControlNonceState | undefined;
	readonly nextPeerSequence: (options?: {
		readonly deliveryPolicy?: ControlDeliveryPolicy;
	}) => number;
	readonly handleReadyRequest: (req: IncomingMessage, res: ServerResponse) => boolean;
	readonly issueCredentialForReadyHeaders: (headers: Headers) => WorkerControlIssuedCredential;
	readonly handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	readonly close: () => Promise<void>;
}

function writeTextResponse(res: ServerResponse, statusCode: number, body: string): void {
	res.statusCode = statusCode;
	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	res.end(body);
}

export function writeWorkerControlUpgradeFailure(socket: Duplex, statusCode = 400): void {
	socket.write(`HTTP/1.1 ${String(statusCode)} Bad Request\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
}

function buildLatestWinsWorkerControlKey(envelope: ControlEnvelope): string {
	return [
		envelope.domain,
		envelope.zoneId,
		envelope.peerId,
		envelope.kind,
		envelope.operation ?? '<none>',
	].join('\u0000');
}

function parseIntegerHeader(req: IncomingMessage, name: string): number | undefined {
	const value = firstHeader(req, name);
	if (value === undefined || !/^[0-9]+$/u.test(value)) {
		return undefined;
	}
	return Number.parseInt(value, 10);
}

function requestHasQueryParameters(req: IncomingMessage): boolean {
	const url = new URL(req.url ?? '/', 'http://worker.local');
	return [...url.searchParams.keys()].length > 0;
}

function requestHasValidSocketIoUpgradeQuery(req: IncomingMessage): boolean {
	const url = new URL(req.url ?? '/', 'http://worker.local');
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

function parseReadyRequestProofFromHeaderReader(
	readHeader: (name: string) => string | undefined,
): ControlReadyRequestProof | undefined {
	if (readHeader(CONTROL_READY_HEADER_NAMES.protocol) !== CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE) {
		return undefined;
	}
	const issuedAtMsValue = readHeader(CONTROL_READY_HEADER_NAMES.issuedAtMs);
	if (issuedAtMsValue === undefined || !/^[0-9]+$/u.test(issuedAtMsValue)) {
		return undefined;
	}
	const parsed = ControlReadyRequestProofSchema.safeParse({
		audience: readHeader(CONTROL_READY_HEADER_NAMES.domain),
		bootId: readHeader(CONTROL_READY_HEADER_NAMES.bootId),
		controllerEpoch: readHeader(CONTROL_READY_HEADER_NAMES.controllerEpoch),
		generationId: readHeader(CONTROL_READY_HEADER_NAMES.generationId),
		issuedAtMs: Number.parseInt(issuedAtMsValue, 10),
		peerId: readHeader(CONTROL_READY_HEADER_NAMES.peerId),
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: readHeader(CONTROL_READY_HEADER_NAMES.requestId),
		signature: readHeader(CONTROL_READY_HEADER_NAMES.signature),
		zoneId: readHeader(CONTROL_READY_HEADER_NAMES.zoneId),
	});
	return parsed.success ? parsed.data : undefined;
}

function parseReadyRequestProofFromIncomingMessage(
	req: IncomingMessage,
): ControlReadyRequestProof | undefined {
	return parseReadyRequestProofFromHeaderReader((name) => firstHeader(req, name));
}

function parseReadyRequestProofFromHeaders(headers: Headers): ControlReadyRequestProof | undefined {
	return parseReadyRequestProofFromHeaderReader((name) => headers.get(name) ?? undefined);
}

function proofMatchesCredential(
	proof: ControlHandshakeProof,
	credential: WorkerControlIssuedCredential,
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

function verifyWorkerControlProofSignature(
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
	identity: WorkerControlIdentity,
): boolean {
	return (
		proof.audience === 'worker_control' &&
		proof.bootId === identity.bootId &&
		proof.controllerEpoch === identity.controllerEpoch &&
		proof.generationId === identity.generationId &&
		proof.peerId === identity.peerId &&
		proof.protocolVersion === CONTROL_PROTOCOL_VERSION &&
		proof.zoneId === identity.zoneId
	);
}

function verifyWorkerControlReadyProofSignature(
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

function buildWorkerControlResponseEnvelope(options: {
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

function isPriorityWorkerControlMessage(envelope: ControlEnvelope): boolean {
	return envelope.kind === 'heartbeat' || envelope.operation === 'operation_cancel';
}

function waitForWorkerControlCommandResult(options: {
	readonly messageId: string;
	readonly pendingCommandResults: Map<string, PendingWorkerControlCommandResult>;
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
				new Error(`worker control command result timed out: ${options.messageId}`),
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
	const pendingResult: PendingWorkerControlCommandResult = {
		promise,
		reject: rejectPromise,
		resolve: resolvePromise,
		timeout: setTimeout(() => {
			if (options.pendingCommandResults.get(options.messageId) === pendingResult) {
				options.pendingCommandResults.delete(options.messageId);
			}
			rejectPromise(new Error(`worker control command result timed out: ${options.messageId}`));
		}, options.timeoutMs),
	};
	pendingResult.timeout.unref?.();
	options.pendingCommandResults.set(options.messageId, pendingResult);
	return promise;
}

function readRequiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	return value === undefined || value.length === 0 ? undefined : value;
}

export function createWorkerControlServiceOptionsFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): WorkerControlServiceOptions | undefined {
	const bootId = readRequiredEnvironmentValue(env, WORKER_CONTROL_ENV_NAMES.bootId);
	const controllerEpoch = readRequiredEnvironmentValue(
		env,
		WORKER_CONTROL_ENV_NAMES.controllerEpoch,
	);
	const generationId = readRequiredEnvironmentValue(env, WORKER_CONTROL_ENV_NAMES.generationId);
	const peerId = readRequiredEnvironmentValue(env, WORKER_CONTROL_ENV_NAMES.peerId);
	const verifierPublicKeyPem = readRequiredEnvironmentValue(
		env,
		WORKER_CONTROL_ENV_NAMES.verifierPublicKeyPem,
	);
	const zoneId = readRequiredEnvironmentValue(env, WORKER_CONTROL_ENV_NAMES.zoneId);
	if (
		bootId === undefined &&
		controllerEpoch === undefined &&
		generationId === undefined &&
		peerId === undefined &&
		verifierPublicKeyPem === undefined
	) {
		return undefined;
	}
	const missingNames: string[] = [];
	if (bootId === undefined) missingNames.push(WORKER_CONTROL_ENV_NAMES.bootId);
	if (controllerEpoch === undefined) {
		missingNames.push(WORKER_CONTROL_ENV_NAMES.controllerEpoch);
	}
	if (generationId === undefined) missingNames.push(WORKER_CONTROL_ENV_NAMES.generationId);
	if (peerId === undefined) missingNames.push(WORKER_CONTROL_ENV_NAMES.peerId);
	if (verifierPublicKeyPem === undefined) {
		missingNames.push(WORKER_CONTROL_ENV_NAMES.verifierPublicKeyPem);
	}
	if (zoneId === undefined) missingNames.push(WORKER_CONTROL_ENV_NAMES.zoneId);
	if (
		bootId === undefined ||
		controllerEpoch === undefined ||
		generationId === undefined ||
		peerId === undefined ||
		verifierPublicKeyPem === undefined ||
		zoneId === undefined
	) {
		throw new Error(
			`Worker control service configuration is incomplete: missing ${missingNames.join(', ')}`,
		);
	}
	return {
		identity: {
			bootId,
			controllerEpoch,
			generationId,
			peerId,
			zoneId,
		},
		verifierPublicKeyPem,
	};
}

export function createWorkerControlService(
	options: WorkerControlServiceOptions,
): WorkerControlService {
	const now = options.now ?? (() => Date.now());
	const nonceTtlMs = options.nonceTtlMs ?? CONTROL_SESSION_TIMING_MS.connectTimeout;
	const clockSkewToleranceMs = CONTROL_SESSION_TIMING_MS.clockSkewTolerance;
	const maxCredentialRecords = CONTROL_QUEUE_LIMITS.queueMessageCap;
	const credentials = new Map<string, StoredWorkerControlCredential>();
	const consumedReadyRequestIds = new Map<string, ConsumedReadyRequest>();
	const failedUpgradeAttemptsBySource = new Map<string, FailedUpgradeAttemptWindow>();
	const pendingCommandResults = new Map<string, PendingWorkerControlCommandResult>();
	const latestWinsQueue = new Map<string, LatestWinsWorkerControlMessage>();
	const handleEngineUpgrade =
		options.handleEngineUpgrade ??
		((req: IncomingMessage, socket: Duplex, head: Buffer): void => {
			engine.handleUpgrade(req, socket, head);
		});
	let acceptedSocket:
		| Socket<WorkerControlControllerToWorkerEvents, WorkerControlWorkerToControllerEvents>
		| undefined;
	let acceptedSession: WorkerControlAcceptedSession | undefined;
	const pendingFullResyncSockets = new Set<
		Socket<WorkerControlControllerToWorkerEvents, WorkerControlWorkerToControllerEvents>
	>();
	let lastSeenControllerSequence = 0;
	let lastSeenPeerSequence = 0;
	let nextPeerSequenceValue = 1;
	let fullResyncPending = false;
	let latestWinsFlushScheduled = false;
	let outboundResponseQueue: Promise<void> = Promise.resolve();
	let outboundResponseQueueGeneration = 0;
	const acceptedSessionWaiters: ((session: WorkerControlAcceptedSession | undefined) => void)[] =
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

	function releaseUnreceiptedPriorityPeerSequence(sequence: number): void {
		if (lastSeenPeerSequence >= sequence) {
			return;
		}
		if (nextPeerSequenceValue !== sequence + 1) {
			return;
		}
		nextPeerSequenceValue = sequence;
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

	function resolveAcceptedSessionWaiters(session: WorkerControlAcceptedSession | undefined): void {
		for (const waiter of acceptedSessionWaiters.splice(0)) {
			waiter(session);
		}
	}

	function rejectPendingWorkerControlCommandResults(error: Error): void {
		for (const [messageId, pendingResult] of pendingCommandResults) {
			clearTimeout(pendingResult.timeout);
			pendingCommandResults.delete(messageId);
			pendingResult.reject(error);
		}
	}

	function closeWorkerControlSessionForSequenceGap(
		socket: Socket<WorkerControlControllerToWorkerEvents, WorkerControlWorkerToControllerEvents>,
		safeMessage: string,
	): void {
		if (acceptedSocket === socket) {
			acceptedSocket = undefined;
			acceptedSession = undefined;
			fullResyncPending = false;
			latestWinsQueue.clear();
			outboundResponseQueueGeneration += 1;
			outboundResponseQueue = Promise.resolve();
			resolveAcceptedSessionWaiters(undefined);
		}
		rejectPendingWorkerControlCommandResults(new Error(`sequence_gap: ${safeMessage}`));
		socket.disconnect(true);
	}

	function closeWorkerControlSessionForReservedResponseFailure(
		socket: Socket<WorkerControlControllerToWorkerEvents, WorkerControlWorkerToControllerEvents>,
		error: unknown,
	): void {
		closeWorkerControlSessionForSequenceGap(
			socket,
			error instanceof Error ? error.message : 'reserved worker control response receipt failed',
		);
	}

	function resetWorkerControlSessionForFullResync(
		socket: Socket<WorkerControlControllerToWorkerEvents, WorkerControlWorkerToControllerEvents>,
	): void {
		fullResyncPending = true;
		pendingFullResyncSockets.add(socket);
	}

	function refreshWorkerFullResyncPending(): void {
		fullResyncPending = pendingFullResyncSockets.size > 0;
	}

	function pruneDisconnectedFullResyncSockets(): void {
		for (const pendingSocket of pendingFullResyncSockets) {
			if (!pendingSocket.connected) {
				pendingFullResyncSockets.delete(pendingSocket);
			}
		}
		refreshWorkerFullResyncPending();
	}

	function resetWorkerControlStateAfterAcceptedFullResync(
		winningSocket: Socket<
			WorkerControlControllerToWorkerEvents,
			WorkerControlWorkerToControllerEvents
		>,
	): void {
		for (const pendingSocket of pendingFullResyncSockets) {
			if (pendingSocket !== winningSocket) {
				pendingSocket.disconnect(true);
			}
		}
		pendingFullResyncSockets.clear();
		fullResyncPending = false;
		latestWinsQueue.clear();
		lastSeenControllerSequence = 0;
		lastSeenPeerSequence = 0;
		nextPeerSequenceValue = 1;
		outboundResponseQueueGeneration += 1;
		outboundResponseQueue = Promise.resolve();
		rejectPendingWorkerControlCommandResults(
			new Error('resync_required: worker control session requires full hello resync'),
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
		WorkerControlControllerToWorkerEvents,
		WorkerControlWorkerToControllerEvents
	>({
		serveClient: false,
	});
	socketServer.bind(engine);
	const commandExecutionTimeoutMsByOperation: Readonly<Record<string, number>> =
		workerControlCommandExecutionTimeoutMsByOperation;

	function acceptHelloSequenceContinuity(
		hello: ControlHelloWithSequenceContinuity,
	): WorkerControlHelloResponse['outcome'] {
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

	function helloContinuityOutcome(
		socket: Socket<WorkerControlControllerToWorkerEvents, WorkerControlWorkerToControllerEvents>,
		hello: WorkerControlHello,
	): WorkerControlHelloResponse['outcome'] {
		if (pendingFullResyncSockets.has(socket) && hello.previousSessionId === undefined) {
			return 'accepted';
		}
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
			pendingFullResyncSockets.delete(socket);
			refreshWorkerFullResyncPending();
			if (acceptedSocket === socket) {
				acceptedSocket = undefined;
				acceptedSession = undefined;
				latestWinsQueue.clear();
				outboundResponseQueueGeneration += 1;
				outboundResponseQueue = Promise.resolve();
				resolveAcceptedSessionWaiters(undefined);
				rejectPendingWorkerControlCommandResults(
					new Error('control_session_disconnect: worker control session disconnected'),
				);
			}
		});
		socket.on(
			'control:hello',
			(
				payload: WorkerControlHello,
				acknowledge: (response: WorkerControlHelloResponse) => void,
			) => {
				const parsedHello = WorkerControlHelloSchema.safeParse(payload);
				if (
					!parsedHello.success ||
					parsedHello.data.bootId !== options.identity.bootId ||
					parsedHello.data.controllerEpoch !== options.identity.controllerEpoch ||
					parsedHello.data.domain !== 'worker_control' ||
					parsedHello.data.peerId !== options.identity.peerId ||
					parsedHello.data.protocolVersion !== CONTROL_PROTOCOL_VERSION
				) {
					const response = {
						connectionId: randomUUID(),
						controllerEpoch: options.identity.controllerEpoch,
						outcome: 'rejected',
						sessionId: randomUUID(),
					} satisfies WorkerControlHelloResponse;
					acknowledge(response);
					socket.disconnect(true);
					return;
				}
				const outcome = helloContinuityOutcome(socket, parsedHello.data);
				const response = {
					connectionId: randomUUID(),
					controllerEpoch: options.identity.controllerEpoch,
					outcome,
					sessionId: randomUUID(),
				} satisfies WorkerControlHelloResponse;
				if (outcome !== 'accepted') {
					if (outcome === 'resync_required') {
						resetWorkerControlSessionForFullResync(socket);
						acknowledge(response);
						return;
					}
					acknowledge(response);
					socket.disconnect(true);
					return;
				}
				const acceptedAfterFullResync = pendingFullResyncSockets.delete(socket);
				if (acceptedAfterFullResync) {
					resetWorkerControlStateAfterAcceptedFullResync(socket);
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
			},
		);
		socket.on('control:message', (envelopePayload, payload, acknowledge) => {
			void (async () => {
				try {
					const envelope = ControlEnvelopeSchema.parse(envelopePayload);
					const workerPayload = WorkerControlRpcMessageSchema.parse(payload);
					if (envelope.deliveryPolicy === 'forbidden_bulk') {
						throw new Error('forbidden bulk message cannot be sent on the worker control session');
					}
					assertInboundEnvelopeMatchesAcceptedSession(socket, envelope);
					const responseToMessageId = extractDomainCommandResultResponseToMessageId(workerPayload);
					const sequenceDecision = evaluateControlSequenceContinuity({
						envelope,
						lastSeenSequence: lastSeenControllerSequence,
					});
					if (sequenceDecision.action === 'drop') {
						acknowledge?.(buildControlMessageReceipt());
						return;
					}
					if (sequenceDecision.action === 'stale') {
						closeWorkerControlSessionForSequenceGap(socket, sequenceDecision.safeMessage);
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
						throw new Error('no worker control application message handler configured');
					}
					const applicationMessageHandler = options.applicationMessageHandler;
					assertControlEnvelopeMatchesDomainMessage(
						envelope,
						applicationMessageHandler.messageIdentity({
							envelope,
							payload: workerPayload,
						}),
					);
					assertDerivedControlDeliveryPolicy({
						envelope,
						policyByOperation: workerControlDeliveryPolicyByOperation,
					});
					acknowledge?.(buildControlMessageReceipt());
					const responsePayloadPromise = (async (): Promise<unknown> => {
						try {
							return await applicationMessageHandler.handle({
								envelope,
								payload: workerPayload,
							});
						} catch (error) {
							if (
								envelope.kind !== 'command' ||
								applicationMessageHandler.buildHandlerFailureResult === undefined
							) {
								throw error;
							}
							return await applicationMessageHandler.buildHandlerFailureResult(
								{ envelope, payload: workerPayload },
								error,
							);
						}
					})();
					if (envelope.kind !== 'command') {
						void responsePayloadPromise.catch((error: unknown) => {
							closeWorkerControlSessionForReservedResponseFailure(socket, error);
						});
						return;
					}
					const responseQueueGeneration = outboundResponseQueueGeneration;
					outboundResponseQueue = outboundResponseQueue
						.catch(() => undefined)
						.then(async () => {
							const responsePayload = await responsePayloadPromise;
							if (
								responsePayload === undefined ||
								responseQueueGeneration !== outboundResponseQueueGeneration ||
								socket !== acceptedSocket
							) {
								return;
							}
							const parsedResponsePayload = WorkerControlRpcMessageSchema.parse(responsePayload);
							const responseSequence = reservePeerSequence();
							const responseEnvelope = buildWorkerControlResponseEnvelope({
								requestEnvelope: envelope,
								sequence: responseSequence,
							});
							const receiptPayload = await socket
								.timeout(CONTROL_SESSION_TIMING_MS.commandAckTimeout)
								.emitWithAck('control:message', responseEnvelope, parsedResponsePayload);
							assertControlMessageReceiptAccepted(receiptPayload);
							recordLastSeenPeerSequence(responseSequence);
						})
						.catch((error: unknown) => {
							if (
								responseQueueGeneration !== outboundResponseQueueGeneration ||
								socket !== acceptedSocket
							) {
								return;
							}
							closeWorkerControlSessionForReservedResponseFailure(socket, error);
						});
				} catch (error: unknown) {
					acknowledge?.(
						buildControlMessageExceptionRejectionReceipt({
							error,
							processingErrorClass: 'worker_control_message_processing_failed',
							safeMessage: 'worker control message was rejected',
						}),
					);
				}
			})();
		});
	});

	async function waitForAcceptedSession(): Promise<WorkerControlAcceptedSession | undefined> {
		pruneDisconnectedFullResyncSockets();
		const session = acceptedSession;
		const socket = acceptedSocket;
		if (session !== undefined && socket !== undefined && socket.connected) {
			return session;
		}
		if (fullResyncPending) {
			return undefined;
		}
		return await new Promise<WorkerControlAcceptedSession | undefined>((resolve) => {
			const timeout = setTimeout(() => {
				finish(undefined);
			}, CONTROL_SESSION_TIMING_MS.connectTimeout);
			const finish = (sessionResult: WorkerControlAcceptedSession | undefined): void => {
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
		emitOptions?: WorkerControlEmitApplicationMessageOptions,
	): Promise<unknown> {
		ControlEnvelopeSchema.parse(envelope);
		assertControlEnvelopeMatchesDomainMessage(envelope, domainMessage);
		assertDerivedControlDeliveryPolicy({
			envelope,
			policyByOperation: workerControlDeliveryPolicyByOperation,
		});
		if (envelope.deliveryPolicy === 'forbidden_bulk') {
			throw new Error('forbidden bulk message cannot be sent on the worker control session');
		}
		const session = await waitForAcceptedSession();
		const socket = acceptedSocket;
		if (session === undefined || socket === undefined || !socket.connected) {
			throw new Error('worker control session is not connected');
		}
		if (
			envelope.sessionId !== session.sessionId ||
			envelope.connectionId !== session.connectionId
		) {
			throw new Error('worker control envelope session identity does not match accepted session');
		}
		const sequenceDecision = evaluateReservedOutboundPeerSequence(envelope);
		if (sequenceDecision.action === 'drop') {
			throw new Error(sequenceDecision.safeMessage);
		}
		if (sequenceDecision.action === 'stale') {
			closeWorkerControlSessionForSequenceGap(socket, sequenceDecision.safeMessage);
			throw new Error(sequenceDecision.safeMessage);
		}
		const workerPayload = WorkerControlRpcMessageSchema.parse(payload);
		if (envelope.deliveryPolicy === 'latest_wins') {
			latestWinsQueue.set(buildLatestWinsWorkerControlKey(envelope), {
				envelope,
				payload: workerPayload,
			});
			recordLastSeenPeerSequence(sequenceDecision.nextLastSeenSequence);
			scheduleLatestWinsFlush();
			return undefined;
		}
		if (envelope.deliveryPolicy === 'droppable') {
			socket.volatile.emit('control:message', envelope, workerPayload, () => undefined);
			recordLastSeenPeerSequence(sequenceDecision.nextLastSeenSequence);
			return undefined;
		}
		const commandResultPromise =
			envelope.kind === 'command'
				? waitForWorkerControlCommandResult({
						messageId: envelope.messageId,
						pendingCommandResults,
						timeoutMs: commandResultTimeoutMsFor(envelope, emitOptions),
					})
				: undefined;
		commandResultPromise?.catch(() => undefined);
		try {
			const receiptPayload = await socket
				.timeout(CONTROL_SESSION_TIMING_MS.commandAckTimeout)
				.emitWithAck('control:message', envelope, workerPayload);
			assertControlMessageReceiptAccepted(receiptPayload);
			recordLastSeenPeerSequence(sequenceDecision.nextLastSeenSequence);
			if (commandResultPromise === undefined) {
				return receiptPayload;
			}
		} catch (error) {
			if (isPriorityWorkerControlMessage(envelope)) {
				releaseUnreceiptedPriorityPeerSequence(sequenceDecision.nextLastSeenSequence);
			}
			throw error;
		}
		if (commandResultPromise !== undefined) {
			return await commandResultPromise;
		}
		return undefined;
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
		socket: Socket<WorkerControlControllerToWorkerEvents, WorkerControlWorkerToControllerEvents>,
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
			envelope.domain !== 'worker_control' ||
			envelope.peerId !== session.peerId ||
			envelope.zoneId !== session.zoneId
		) {
			throw new Error('worker control inbound message did not match accepted session');
		}
	}

	function commandResultTimeoutMsFor(
		envelope: ControlEnvelope,
		emitOptions: WorkerControlEmitApplicationMessageOptions | undefined,
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
			attemptWindow.count >= WORKER_CONTROL_FAILED_UPGRADE_ATTEMPT_LIMIT
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

	function issueCredential(): WorkerControlIssuedCredential {
		expireIssuedCredentials();
		if (credentials.size >= maxCredentialRecords) {
			throw new Error('worker control credential queue is full');
		}
		const issuedAtMs = now();
		const credential: WorkerControlIssuedCredential = {
			...options.identity,
			audience: 'worker_control',
			credentialId: randomUUID(),
			expiresAtMs: issuedAtMs + nonceTtlMs,
			issuedAtMs,
			nonce: randomBytes(32).toString('base64url'),
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		};
		credentials.set(credential.credentialId, { credential, state: 'issued' });
		return credential;
	}

	function consumeReadyProofForCredentialIssue(proof: ControlReadyRequestProof): boolean {
		expireConsumedReadyRequests();
		if (consumedReadyRequestIds.has(proof.requestId)) {
			return false;
		}
		const observedAtMs = now();
		if (
			proof.issuedAtMs - clockSkewToleranceMs > observedAtMs ||
			proof.issuedAtMs + nonceTtlMs + clockSkewToleranceMs <= observedAtMs ||
			!readyProofMatchesIdentity(proof, options.identity) ||
			!verifyWorkerControlReadyProofSignature(proof, options.verifierPublicKeyPem)
		) {
			return false;
		}
		consumedReadyRequestIds.set(proof.requestId, { consumedAtMs: observedAtMs });
		return true;
	}

	function issueCredentialForReadyProof(
		readyProof: ControlReadyRequestProof | undefined,
	): WorkerControlIssuedCredential {
		if (readyProof === undefined || !consumeReadyProofForCredentialIssue(readyProof)) {
			throw new Error('worker control ready request is unauthorized');
		}
		return issueCredential();
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
			!verifyWorkerControlProofSignature(proof, options.verifierPublicKeyPem)
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
		getAcceptedSession: async () => {
			const session = await waitForAcceptedSession();
			if (session === undefined) {
				throw new Error('worker control session is not connected');
			}
			return session;
		},
		getCredentialState: (credentialId) => {
			expireIssuedCredentials();
			return credentials.get(credentialId)?.state;
		},
		nextPeerSequence,
		handleReadyRequest: (req, res) => {
			if (req.method !== 'GET') {
				writeTextResponse(res, 405, 'method not allowed\n');
				return true;
			}
			try {
				const credential = issueCredentialForReadyProof(
					requestHasQueryParameters(req)
						? undefined
						: parseReadyRequestProofFromIncomingMessage(req),
				);
				res.statusCode = 200;
				res.setHeader('cache-control', 'no-store');
				res.setHeader('content-type', 'application/json; charset=utf-8');
				res.end(`${JSON.stringify(credential)}\n`);
			} catch (error) {
				writeTextResponse(
					res,
					error instanceof Error && /unauthorized/u.test(error.message) ? 401 : 429,
					error instanceof Error && /unauthorized/u.test(error.message)
						? 'unauthorized\n'
						: error instanceof Error
							? `${error.message}\n`
							: 'too many credentials\n',
				);
			}
			return true;
		},
		issueCredentialForReadyHeaders: (headers) =>
			issueCredentialForReadyProof(parseReadyRequestProofFromHeaders(headers)),
		handleUpgrade: (req, socket, head) => {
			const proof = !requestHasValidSocketIoUpgradeQuery(req)
				? undefined
				: parseHandshakeProofFromHeaders(req);
			if (proof === undefined) {
				writeWorkerControlUpgradeFailure(socket);
				return true;
			}
			if (failedUpgradeAttemptLimitReached(proof)) {
				writeWorkerControlUpgradeFailure(socket);
				return true;
			}
			if (!consumeCredentialForUpgrade(proof)) {
				recordFailedUpgradeAttempt(proof);
				writeWorkerControlUpgradeFailure(socket);
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
