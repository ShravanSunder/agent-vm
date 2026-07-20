import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, lstat, unlink } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';

import {
	DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS,
	GATEWAY_RUNTIME_REQUEST_CANCEL_NOTIFICATION_METHOD,
	GatewayRuntimeFrameDecoder,
	encodeGatewayRuntimeFrame,
	type GatewayRuntimeFrameLimitOverrides,
	type GatewayRuntimeJsonRpcMessage,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import {
	GATEWAY_RUNTIME_ATTACHMENT_SNAPSHOT_VERSION,
	createGatewayRuntimeAttachmentSnapshot,
	type GatewayRuntimeAttachmentSnapshot,
} from '@agent-vm/gateway-control-contracts';

import {
	prepareGatewayRuntimeDirectory,
	type GatewayRuntimePaths,
} from './gateway-runtime-paths.js';
import {
	reduceManagedPluginAttachmentState,
	GATEWAY_RUNTIME_PROTOCOL_VERSION,
	GATEWAY_RUNTIME_SCHEMA_VERSION,
	type ManagedPluginAttachmentDecision,
	type ManagedPluginAttachmentState,
	type ManagedPluginHandshakeEvent,
} from './managed-plugin-attachment-policy.js';

const DEFAULT_MAXIMUM_CONNECTIONS = 8;
const DEFAULT_MAXIMUM_PENDING_REQUESTS_PER_CONNECTION = 64;
const MAXIMUM_CONFIGURED_CONNECTIONS = 256;
const MAXIMUM_CONFIGURED_PENDING_REQUESTS = 1_024;
const MAXIMUM_RETIREMENT_DRAIN_MILLISECONDS = 60_000;
const MAXIMUM_ATTACHMENT_SNAPSHOT_OBSERVERS = 32;
const MAXIMUM_WRITE_PRESSURE_RESPONSE_BUDGET = 2;
const MAXIMUM_WRITABLE_FRAMES_PER_CONNECTION = 2;
const MAXIMUM_WRITABLE_FRAMES_ACROSS_SERVER = DEFAULT_MAXIMUM_CONNECTIONS;

export type GatewayRuntimeUdsServerErrorCode =
	| 'active-socket-path-collision'
	| 'attachment-observer-limit-exceeded'
	| 'invalid-server-limit'
	| 'socket-probe-failed'
	| 'unsafe-socket-path-collision';

export class GatewayRuntimeUdsServerError extends Error {
	readonly code: GatewayRuntimeUdsServerErrorCode;

	constructor(code: GatewayRuntimeUdsServerErrorCode, message: string, options: ErrorOptions = {}) {
		super(message, options);
		this.name = 'GatewayRuntimeUdsServerError';
		this.code = code;
	}
}

export interface GatewayRuntimeUdsDispatchRequest {
	readonly connectionId: string;
	readonly method: string;
	readonly params: unknown;
	readonly signal: AbortSignal;
}

export type GatewayRuntimeUdsOperationDispatcher = (
	request: GatewayRuntimeUdsDispatchRequest,
) => Promise<unknown>;

export interface GatewayRuntimeUdsServerLimits {
	readonly maxConnections?: number;
	readonly maxPendingRequestsPerConnection?: number;
}

export interface StartGatewayRuntimeUdsServerOptions {
	readonly attachmentState: ManagedPluginAttachmentState;
	readonly dispatch: GatewayRuntimeUdsOperationDispatcher;
	readonly frameLimits?: GatewayRuntimeFrameLimitOverrides | undefined;
	readonly limits?: GatewayRuntimeUdsServerLimits;
	readonly paths: GatewayRuntimePaths;
	readonly resolveOperationGroup: (method: string) => string | undefined;
}

export interface GatewayRuntimeUdsServerReadiness {
	readonly kind: 'ready';
	readonly runtimeDirectoryMode: 0o700;
	readonly runtimeRoot: string;
	readonly socketMode: 0o600;
	readonly socketPath: string;
}

export interface GatewayRuntimeUdsRetirementOptions {
	readonly drainTimeoutMs?: number;
}

export interface GatewayRuntimeUdsRetirementReceipt {
	readonly abortedRequestCount: number;
	readonly destroyedConnectionCount: number;
	readonly drainOutcome: 'drained' | 'forced';
	readonly kind: 'retired';
	readonly pendingRequestCountAtRetirement: number;
	readonly socketRemoved: boolean;
}

export type GatewayRuntimeAttachmentSnapshotObserver = (
	snapshot: GatewayRuntimeAttachmentSnapshot,
) => void;

export type GatewayRuntimeAttachmentSnapshotObserverFailureHandler = (error: unknown) => void;

export interface GatewayRuntimeAttachmentSnapshotObservation {
	readonly currentSnapshot: GatewayRuntimeAttachmentSnapshot;
	readonly unsubscribe: () => void;
}

export interface GatewayRuntimeUdsServer {
	readonly getAttachmentSnapshot: () => GatewayRuntimeAttachmentSnapshot;
	readonly observeAttachmentSnapshots: (
		observer: GatewayRuntimeAttachmentSnapshotObserver,
		onObserverFailure: GatewayRuntimeAttachmentSnapshotObserverFailureHandler,
	) => GatewayRuntimeAttachmentSnapshotObservation;
	readonly readiness: GatewayRuntimeUdsServerReadiness;
	readonly retire: (
		options?: GatewayRuntimeUdsRetirementOptions,
	) => Promise<GatewayRuntimeUdsRetirementReceipt>;
}

type JsonRpcRequestId = number | string | null;

interface PendingDispatch {
	readonly cancellation: AbortController;
	readonly requestId: JsonRpcRequestId;
}

interface GatewayRuntimeUdsConnectionState {
	readonly connectionId: string;
	readonly completedRequestIds: Set<JsonRpcRequestId>;
	readonly decoder: GatewayRuntimeFrameDecoder;
	readonly pendingDispatches: Map<JsonRpcRequestId, PendingDispatch>;
	readonly socket: Socket;
	closed: boolean;
	writePressured: boolean;
	writePressureResponseBudgetUsed: number;
}

interface ResolvedGatewayRuntimeUdsServerLimits {
	readonly maxConnections: number;
	readonly maxPendingRequestsPerConnection: number;
}

interface ResolvedGatewayRuntimeWritableLimits {
	readonly acrossServerBytes: number;
	readonly perConnectionBytes: number;
}

interface OwnedSocketIdentity {
	readonly device: bigint | number;
	readonly inode: bigint | number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}

async function lstatIfPresent(filePath: string): Promise<BigIntStats | undefined> {
	try {
		return await lstat(filePath, { bigint: true });
	} catch (error: unknown) {
		if (nodeErrorCode(error) === 'ENOENT') return undefined;
		throw error;
	}
}

function socketIdentity(status: BigIntStats): OwnedSocketIdentity {
	return { device: status.dev, inode: status.ino };
}

function socketIdentityMatches(status: BigIntStats, identity: OwnedSocketIdentity): boolean {
	return status.dev === identity.device && status.ino === identity.inode;
}

function assertBoundedPositiveInteger(props: {
	readonly fieldName: string;
	readonly maximum: number;
	readonly value: number;
}): void {
	if (!Number.isSafeInteger(props.value) || props.value <= 0 || props.value > props.maximum) {
		throw new GatewayRuntimeUdsServerError(
			'invalid-server-limit',
			`${props.fieldName} must be a positive bounded safe integer.`,
		);
	}
}

function resolveServerLimits(
	limits: GatewayRuntimeUdsServerLimits = {},
): ResolvedGatewayRuntimeUdsServerLimits {
	const maxConnections = limits.maxConnections ?? DEFAULT_MAXIMUM_CONNECTIONS;
	const maxPendingRequestsPerConnection =
		limits.maxPendingRequestsPerConnection ?? DEFAULT_MAXIMUM_PENDING_REQUESTS_PER_CONNECTION;
	assertBoundedPositiveInteger({
		fieldName: 'maxConnections',
		maximum: MAXIMUM_CONFIGURED_CONNECTIONS,
		value: maxConnections,
	});
	assertBoundedPositiveInteger({
		fieldName: 'maxPendingRequestsPerConnection',
		maximum: MAXIMUM_CONFIGURED_PENDING_REQUESTS,
		value: maxPendingRequestsPerConnection,
	});
	return Object.freeze({ maxConnections, maxPendingRequestsPerConnection });
}

function resolveGatewayRuntimeWritableLimits(
	frameLimits: GatewayRuntimeFrameLimitOverrides,
): ResolvedGatewayRuntimeWritableLimits {
	const maxBufferedBytes =
		frameLimits.maxBufferedBytes ?? DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS.maxBufferedBytes;
	const perConnectionBytes = MAXIMUM_WRITABLE_FRAMES_PER_CONNECTION * maxBufferedBytes;
	const acrossServerBytes = MAXIMUM_WRITABLE_FRAMES_ACROSS_SERVER * maxBufferedBytes;
	if (
		!Number.isSafeInteger(maxBufferedBytes) ||
		maxBufferedBytes <= 0 ||
		maxBufferedBytes > DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS.maxBufferedBytes ||
		!Number.isSafeInteger(perConnectionBytes) ||
		!Number.isSafeInteger(acrossServerBytes)
	) {
		throw new GatewayRuntimeUdsServerError(
			'invalid-server-limit',
			'Gateway runtime maxBufferedBytes must be a positive safe integer no larger than the protocol default.',
		);
	}
	return Object.freeze({ acrossServerBytes, perConnectionBytes });
}

async function probeExistingSocket(socketPath: string): Promise<'active' | 'absent' | 'stale'> {
	const probeSocket = net.createConnection(socketPath);
	return await new Promise<'active' | 'absent' | 'stale'>((resolve, reject) => {
		const cleanup = (): void => {
			probeSocket.off('connect', onConnect);
			probeSocket.off('error', onError);
		};
		const onConnect = (): void => {
			cleanup();
			probeSocket.destroy();
			resolve('active');
		};
		const onError = (error: Error): void => {
			cleanup();
			probeSocket.destroy();
			const errorCode = nodeErrorCode(error);
			if (errorCode === 'ENOENT') {
				resolve('absent');
				return;
			}
			if (errorCode === 'ECONNREFUSED') {
				resolve('stale');
				return;
			}
			reject(
				new GatewayRuntimeUdsServerError(
					'socket-probe-failed',
					'Gateway runtime socket collision could not be classified safely.',
					{ cause: error },
				),
			);
		};
		probeSocket.once('connect', onConnect);
		probeSocket.once('error', onError);
	});
}

async function removeOnlyStaleSocket(socketPath: string): Promise<void> {
	const initialStatus = await lstatIfPresent(socketPath);
	if (initialStatus === undefined) return;
	if (!initialStatus.isSocket()) {
		throw new GatewayRuntimeUdsServerError(
			'unsafe-socket-path-collision',
			'Gateway runtime socket path collides with a non-socket filesystem node.',
		);
	}
	const initialIdentity = socketIdentity(initialStatus);
	const classification = await probeExistingSocket(socketPath);
	if (classification === 'active') {
		throw new GatewayRuntimeUdsServerError(
			'active-socket-path-collision',
			'Gateway runtime socket path is owned by an active listener.',
		);
	}
	if (classification === 'absent') return;

	const verifiedStatus = await lstatIfPresent(socketPath);
	if (
		verifiedStatus === undefined ||
		!verifiedStatus.isSocket() ||
		!socketIdentityMatches(verifiedStatus, initialIdentity)
	) {
		throw new GatewayRuntimeUdsServerError(
			'unsafe-socket-path-collision',
			'Gateway runtime socket path changed during stale-socket verification.',
		);
	}
	await unlink(socketPath);
}

async function removeOwnedSocket(
	socketPath: string,
	identity: OwnedSocketIdentity,
): Promise<boolean> {
	const status = await lstatIfPresent(socketPath);
	if (status === undefined) return true;
	if (!status.isSocket() || !socketIdentityMatches(status, identity)) return false;
	await unlink(socketPath);
	return true;
}

function jsonRpcRequestId(message: GatewayRuntimeJsonRpcMessage): JsonRpcRequestId | undefined {
	if (!Object.hasOwn(message, 'id')) return undefined;
	const requestId = message['id'];
	return typeof requestId === 'string' || typeof requestId === 'number' || requestId === null
		? requestId
		: undefined;
}

function createJsonRpcErrorResponse(props: {
	readonly code: number;
	readonly dataCode: string;
	readonly message: string;
	readonly requestId: JsonRpcRequestId;
}): GatewayRuntimeJsonRpcMessage {
	return {
		error: {
			code: props.code,
			data: { code: props.dataCode },
			message: props.message,
		},
		id: props.requestId,
		jsonrpc: '2.0',
	};
}

class GatewayRuntimeUdsServerRuntime implements GatewayRuntimeUdsServer {
	readonly #attachmentSnapshotObservers = new Map<
		GatewayRuntimeAttachmentSnapshotObserver,
		GatewayRuntimeAttachmentSnapshotObserverFailureHandler
	>();
	readonly #connections = new Set<GatewayRuntimeUdsConnectionState>();
	readonly #dispatch: GatewayRuntimeUdsOperationDispatcher;
	readonly #frameLimits: GatewayRuntimeFrameLimitOverrides;
	readonly #limits: ResolvedGatewayRuntimeUdsServerLimits;
	readonly #paths: GatewayRuntimePaths;
	readonly #resolveOperationGroup: (method: string) => string | undefined;
	readonly #server: Server;
	readonly #writableLimits: ResolvedGatewayRuntimeWritableLimits;
	#attachmentSnapshot: GatewayRuntimeAttachmentSnapshot;
	#attachmentState: ManagedPluginAttachmentState;
	#ownedSocketIdentity: OwnedSocketIdentity | undefined;
	#pendingRequestCount = 0;
	#readiness: GatewayRuntimeUdsServerReadiness | undefined;
	#retiring = false;
	#retirementPromise: Promise<GatewayRuntimeUdsRetirementReceipt> | undefined;
	#resolveDrained: (() => void) | undefined;

	constructor(options: StartGatewayRuntimeUdsServerOptions) {
		this.#attachmentState = options.attachmentState;
		this.#attachmentSnapshot = createGatewayRuntimeAttachmentSnapshot({
			expected: {
				attachmentGeneration: options.attachmentState.configuration.attachmentGeneration,
				clientKind: options.attachmentState.configuration.clientKind,
				configuredAgentIds: options.attachmentState.configuration.configuredAgentIds,
				frameworkEpoch: options.attachmentState.configuration.frameworkEpoch,
				gatewayEpoch: options.attachmentState.configuration.gatewayEpoch,
				protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
				projectionCohortDigest: options.attachmentState.configuration.projectionCohortDigest,
				runtimeEpoch: options.attachmentState.configuration.runtimeEpoch,
				schemaVersion: GATEWAY_RUNTIME_SCHEMA_VERSION,
			},
			observationSequence: 0,
			snapshotVersion: GATEWAY_RUNTIME_ATTACHMENT_SNAPSHOT_VERSION,
			status: options.attachmentState.status === 'retired' ? 'retired' : 'awaiting-attachment',
		});
		this.#dispatch = options.dispatch;
		this.#frameLimits = options.frameLimits ?? {};
		this.#limits = resolveServerLimits(options.limits);
		this.#writableLimits = resolveGatewayRuntimeWritableLimits(this.#frameLimits);
		this.#paths = options.paths;
		this.#resolveOperationGroup = options.resolveOperationGroup;
		this.#server = net.createServer((socket) => this.#acceptConnection(socket));
	}

	get readiness(): GatewayRuntimeUdsServerReadiness {
		if (this.#readiness === undefined) throw new Error('Gateway runtime UDS server is not ready.');
		return this.#readiness;
	}

	getAttachmentSnapshot(): GatewayRuntimeAttachmentSnapshot {
		return this.#attachmentSnapshot;
	}

	observeAttachmentSnapshots(
		observer: GatewayRuntimeAttachmentSnapshotObserver,
		onObserverFailure: GatewayRuntimeAttachmentSnapshotObserverFailureHandler,
	): GatewayRuntimeAttachmentSnapshotObservation {
		if (
			this.#attachmentSnapshot.status !== 'retired' &&
			this.#attachmentSnapshotObservers.size >= MAXIMUM_ATTACHMENT_SNAPSHOT_OBSERVERS
		) {
			throw new GatewayRuntimeUdsServerError(
				'attachment-observer-limit-exceeded',
				'Gateway runtime attachment observer capacity was reached.',
			);
		}
		let subscribed = this.#attachmentSnapshot.status !== 'retired';
		if (subscribed) this.#attachmentSnapshotObservers.set(observer, onObserverFailure);
		return Object.freeze({
			currentSnapshot: this.#attachmentSnapshot,
			unsubscribe: (): void => {
				if (!subscribed) return;
				subscribed = false;
				this.#attachmentSnapshotObservers.delete(observer);
			},
		});
	}

	#recordAttachmentSnapshot(
		status: GatewayRuntimeAttachmentSnapshot['status'],
		connectionId?: string,
	): void {
		this.#attachmentSnapshot = createGatewayRuntimeAttachmentSnapshot({
			...(connectionId === undefined ? {} : { connectionId }),
			expected: this.#attachmentSnapshot.expected,
			observationSequence: this.#attachmentSnapshot.observationSequence + 1,
			snapshotVersion: GATEWAY_RUNTIME_ATTACHMENT_SNAPSHOT_VERSION,
			status,
		});
		const snapshotObservers = Array.from(this.#attachmentSnapshotObservers.entries());
		for (const [observer, onObserverFailure] of snapshotObservers) {
			try {
				observer(this.#attachmentSnapshot);
			} catch (error: unknown) {
				this.#attachmentSnapshotObservers.delete(observer);
				onObserverFailure(error);
			}
		}
		if (status === 'retired') this.#attachmentSnapshotObservers.clear();
	}

	async publish(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			const onListening = (): void => {
				cleanup();
				resolve();
			};
			const cleanup = (): void => {
				this.#server.off('error', onError);
				this.#server.off('listening', onListening);
			};
			this.#server.once('error', onError);
			this.#server.once('listening', onListening);
			this.#server.listen(this.#paths.managedPluginSocketPath);
		});
		const publishedStatus = await lstat(this.#paths.managedPluginSocketPath, { bigint: true });
		if (!publishedStatus.isSocket()) {
			throw new GatewayRuntimeUdsServerError(
				'unsafe-socket-path-collision',
				'Published Gateway runtime path is not a Unix socket.',
			);
		}
		this.#ownedSocketIdentity = socketIdentity(publishedStatus);
		await chmod(this.#paths.managedPluginSocketPath, 0o600);
		this.#readiness = Object.freeze({
			kind: 'ready',
			runtimeDirectoryMode: 0o700,
			runtimeRoot: this.#paths.runtimeRoot,
			socketMode: 0o600,
			socketPath: this.#paths.managedPluginSocketPath,
		});
	}

	#acceptConnection(socket: Socket): void {
		if (this.#retiring || this.#connections.size >= this.#limits.maxConnections) {
			socket.destroy();
			return;
		}
		const connection: GatewayRuntimeUdsConnectionState = {
			closed: false,
			completedRequestIds: new Set(),
			connectionId: randomUUID(),
			decoder: new GatewayRuntimeFrameDecoder(this.#frameLimits),
			pendingDispatches: new Map(),
			socket,
			writePressured: false,
			writePressureResponseBudgetUsed: 0,
		};
		this.#connections.add(connection);
		socket.on('data', (chunk: Buffer) => this.#receiveChunk(connection, chunk));
		socket.once('close', () => this.#closeConnection(connection));
		socket.once('error', () => this.#closeConnection(connection));
	}

	#receiveChunk(connection: GatewayRuntimeUdsConnectionState, chunk: Uint8Array): void {
		if (connection.closed || this.#retiring) return;
		let messages: readonly GatewayRuntimeJsonRpcMessage[];
		try {
			messages = connection.decoder.push(chunk);
		} catch {
			connection.socket.destroy();
			return;
		}
		for (const message of messages) this.#receiveMessage(connection, message);
	}

	#receiveMessage(
		connection: GatewayRuntimeUdsConnectionState,
		message: GatewayRuntimeJsonRpcMessage,
	): void {
		if (connection.closed || typeof message['method'] !== 'string') {
			connection.socket.destroy();
			return;
		}
		const method = message['method'];
		if (method === GATEWAY_RUNTIME_REQUEST_CANCEL_NOTIFICATION_METHOD) {
			this.#receiveCancellation(connection, message['params']);
			return;
		}
		const requestId = jsonRpcRequestId(message);
		if (requestId === undefined) {
			connection.socket.destroy();
			return;
		}
		if (connection.writePressured) {
			if (connection.writePressureResponseBudgetUsed >= MAXIMUM_WRITE_PRESSURE_RESPONSE_BUDGET) {
				connection.socket.destroy();
				return;
			}
			connection.writePressureResponseBudgetUsed += 1;
			if (this.#resolveOperationGroup(method) !== 'sandbox.terminal') {
				this.#writeMessage(
					connection,
					createJsonRpcErrorResponse({
						code: -32_004,
						dataCode: 'pending-request-limit-exceeded',
						message: 'Gateway runtime pending request capacity was reached.',
						requestId,
					}),
				);
				return;
			}
		}
		if (method === 'managed-plugin.handshake') {
			this.#receiveHandshake(connection, requestId, message['params']);
			return;
		}

		const operationGroup = this.#resolveOperationGroup(method);
		if (
			operationGroup === undefined &&
			this.#attachmentState.activeConnectionId === connection.connectionId
		) {
			this.#writeMessage(
				connection,
				createJsonRpcErrorResponse({
					code: -32_601,
					dataCode: 'method-not-found',
					message: 'Gateway runtime method is not available.',
					requestId,
				}),
			);
			return;
		}
		const transition = reduceManagedPluginAttachmentState(this.#attachmentState, {
			connectionId: connection.connectionId,
			kind: 'method',
			operationGroup: operationGroup ?? 'unknown-method',
		});
		this.#attachmentState = transition.state;
		if (transition.decision.kind === 'rejected') {
			this.#writeMessage(
				connection,
				createJsonRpcErrorResponse({
					code: -32_003,
					dataCode: transition.decision.code,
					message: 'Gateway runtime method admission was rejected.',
					requestId,
				}),
			);
			if (transition.decision.code === 'method-before-handshake') connection.socket.end();
			return;
		}
		this.#dispatchMethod(connection, requestId, method, message['params']);
	}

	#receiveHandshake(
		connection: GatewayRuntimeUdsConnectionState,
		requestId: JsonRpcRequestId,
		params: unknown,
	): void {
		const publicHandshake = isRecord(params) ? params : {};
		const handshakeEvent = {
			...publicHandshake,
			connectionId: connection.connectionId,
			kind: 'handshake',
		} as ManagedPluginHandshakeEvent;
		const transition = reduceManagedPluginAttachmentState(this.#attachmentState, handshakeEvent);
		this.#attachmentState = transition.state;
		if (transition.decision.kind === 'accepted') {
			this.#recordAttachmentSnapshot('attached', connection.connectionId);
		}
		this.#writeHandshakeDecision(connection, requestId, transition.decision);
		if (transition.decision.kind === 'rejected') connection.socket.end();
	}

	#writeHandshakeDecision(
		connection: GatewayRuntimeUdsConnectionState,
		requestId: JsonRpcRequestId,
		decision: ManagedPluginAttachmentDecision,
	): void {
		this.#writeMessage(connection, { id: requestId, jsonrpc: '2.0', result: decision });
	}

	#receiveCancellation(connection: GatewayRuntimeUdsConnectionState, params: unknown): void {
		if (
			this.#attachmentState.activeConnectionId !== connection.connectionId ||
			!isRecord(params) ||
			Object.keys(params).length !== 1 ||
			!Object.hasOwn(params, 'requestId')
		) {
			connection.socket.destroy();
			return;
		}
		const requestId = params['requestId'];
		if (typeof requestId !== 'string' && typeof requestId !== 'number' && requestId !== null) {
			connection.socket.destroy();
			return;
		}
		const pendingDispatch = connection.pendingDispatches.get(requestId);
		if (pendingDispatch === undefined) {
			if (!connection.completedRequestIds.has(requestId)) connection.socket.destroy();
			return;
		}
		pendingDispatch.cancellation.abort(
			new Error('Gateway runtime request was cancelled locally by its attached client.'),
		);
	}

	#recordCompletedRequestId(
		connection: GatewayRuntimeUdsConnectionState,
		requestId: JsonRpcRequestId,
	): void {
		connection.completedRequestIds.add(requestId);
		while (connection.completedRequestIds.size > this.#limits.maxPendingRequestsPerConnection) {
			const oldestRequestId = connection.completedRequestIds.values().next().value;
			if (oldestRequestId === undefined) return;
			connection.completedRequestIds.delete(oldestRequestId);
		}
	}

	#dispatchMethod(
		connection: GatewayRuntimeUdsConnectionState,
		requestId: JsonRpcRequestId,
		method: string,
		params: unknown,
	): void {
		if (
			connection.pendingDispatches.has(requestId) ||
			connection.pendingDispatches.size >= this.#limits.maxPendingRequestsPerConnection
		) {
			this.#writeMessage(
				connection,
				createJsonRpcErrorResponse({
					code: -32_004,
					dataCode: 'pending-request-limit-exceeded',
					message: 'Gateway runtime pending request capacity was reached.',
					requestId,
				}),
			);
			return;
		}
		const cancellation = new AbortController();
		const pendingDispatch = { cancellation, requestId } satisfies PendingDispatch;
		connection.pendingDispatches.set(requestId, pendingDispatch);
		this.#pendingRequestCount += 1;
		void Promise.resolve()
			.then(
				async () =>
					await this.#dispatch({
						connectionId: connection.connectionId,
						method,
						params,
						signal: cancellation.signal,
					}),
			)
			.then(
				(result) => this.#settleDispatch(connection, pendingDispatch, { result }),
				() =>
					this.#settleDispatch(connection, pendingDispatch, {
						error: createJsonRpcErrorResponse({
							code: -32_603,
							dataCode: 'dispatch-failed',
							message: 'Gateway runtime method dispatch failed.',
							requestId,
						}),
					}),
			);
	}

	#settleDispatch(
		connection: GatewayRuntimeUdsConnectionState,
		pendingDispatch: PendingDispatch,
		settlement: { readonly error: GatewayRuntimeJsonRpcMessage } | { readonly result: unknown },
	): void {
		if (connection.pendingDispatches.get(pendingDispatch.requestId) !== pendingDispatch) return;
		connection.pendingDispatches.delete(pendingDispatch.requestId);
		this.#recordCompletedRequestId(connection, pendingDispatch.requestId);
		this.#pendingRequestCount -= 1;
		this.#notifyDrainedIfNeeded();
		if (connection.closed) return;
		if ('error' in settlement) {
			this.#writeMessage(connection, settlement.error);
			return;
		}
		try {
			this.#writeMessage(connection, {
				id: pendingDispatch.requestId,
				jsonrpc: '2.0',
				result: settlement.result,
			});
		} catch {
			this.#writeMessage(
				connection,
				createJsonRpcErrorResponse({
					code: -32_603,
					dataCode: 'invalid-dispatch-result',
					message: 'Gateway runtime method result could not be encoded.',
					requestId: pendingDispatch.requestId,
				}),
			);
		}
	}

	#writeMessage(connection: GatewayRuntimeUdsConnectionState, message: unknown): void {
		if (connection.closed || connection.socket.destroyed) return;
		const frame = encodeGatewayRuntimeFrame(message, this.#frameLimits);
		const connectionRetainedWritableBytes = connection.socket.writableLength + frame.byteLength;
		let serverRetainedWritableBytes = frame.byteLength;
		for (const activeConnection of this.#connections) {
			serverRetainedWritableBytes += activeConnection.socket.writableLength;
		}
		if (
			!Number.isSafeInteger(connectionRetainedWritableBytes) ||
			connectionRetainedWritableBytes > this.#writableLimits.perConnectionBytes ||
			!Number.isSafeInteger(serverRetainedWritableBytes) ||
			serverRetainedWritableBytes > this.#writableLimits.acrossServerBytes
		) {
			connection.socket.destroy();
			return;
		}
		if (connection.socket.write(frame) || connection.writePressured) return;
		connection.writePressured = true;
		connection.socket.once('drain', () => {
			connection.writePressured = false;
			connection.writePressureResponseBudgetUsed = 0;
		});
	}

	#closeConnection(connection: GatewayRuntimeUdsConnectionState): void {
		if (connection.closed) return;
		connection.closed = true;
		this.#connections.delete(connection);
		for (const pendingDispatch of connection.pendingDispatches.values()) {
			pendingDispatch.cancellation.abort(
				new Error('Gateway runtime client connection closed before dispatch completion.'),
			);
		}
		this.#pendingRequestCount -= connection.pendingDispatches.size;
		connection.pendingDispatches.clear();
		const transition = reduceManagedPluginAttachmentState(this.#attachmentState, {
			connectionId: connection.connectionId,
			kind: 'disconnected',
		});
		this.#attachmentState = transition.state;
		if (transition.decision.kind === 'accepted') {
			this.#recordAttachmentSnapshot('attachment-lost', connection.connectionId);
		}
		this.#notifyDrainedIfNeeded();
	}

	#notifyDrainedIfNeeded(): void {
		if (this.#pendingRequestCount !== 0) return;
		this.#resolveDrained?.();
		this.#resolveDrained = undefined;
	}

	async #waitForDrain(drainTimeoutMs: number): Promise<boolean> {
		if (this.#pendingRequestCount === 0) return true;
		const drained = Promise.withResolvers<void>();
		this.#resolveDrained = drained.resolve;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<false>((resolve) => {
			timeout = setTimeout(() => resolve(false), drainTimeoutMs);
		});
		try {
			return await Promise.race([drained.promise.then(() => true), deadline]);
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			this.#resolveDrained = undefined;
		}
	}

	async #closeListener(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.#server.close(() => resolve());
		});
	}

	async #retire(drainTimeoutMs: number): Promise<GatewayRuntimeUdsRetirementReceipt> {
		this.#retiring = true;
		const retirementTransition = reduceManagedPluginAttachmentState(this.#attachmentState, {
			kind: 'retired',
		});
		this.#attachmentState = retirementTransition.state;
		this.#recordAttachmentSnapshot('retired');
		const listenerClosed = this.#closeListener();
		const pendingRequestCountAtRetirement = this.#pendingRequestCount;
		const drained = await this.#waitForDrain(drainTimeoutMs);
		let abortedRequestCount = 0;
		if (!drained) {
			for (const connection of this.#connections) {
				for (const pendingDispatch of connection.pendingDispatches.values()) {
					if (!pendingDispatch.cancellation.signal.aborted) abortedRequestCount += 1;
					pendingDispatch.cancellation.abort(
						new Error('Gateway runtime retirement drain deadline expired.'),
					);
				}
				connection.pendingDispatches.clear();
			}
			this.#pendingRequestCount = 0;
		}
		const destroyedConnectionCount = this.#connections.size;
		for (const connection of this.#connections) connection.socket.destroy();
		await listenerClosed;
		const socketRemoved =
			this.#ownedSocketIdentity === undefined
				? false
				: await removeOwnedSocket(this.#paths.managedPluginSocketPath, this.#ownedSocketIdentity);
		return Object.freeze({
			abortedRequestCount,
			destroyedConnectionCount,
			drainOutcome: drained ? 'drained' : 'forced',
			kind: 'retired',
			pendingRequestCountAtRetirement,
			socketRemoved,
		});
	}

	retire(
		options: GatewayRuntimeUdsRetirementOptions = {},
	): Promise<GatewayRuntimeUdsRetirementReceipt> {
		if (this.#retirementPromise !== undefined) return this.#retirementPromise;
		const drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
		try {
			assertBoundedPositiveInteger({
				fieldName: 'drainTimeoutMs',
				maximum: MAXIMUM_RETIREMENT_DRAIN_MILLISECONDS,
				value: drainTimeoutMs,
			});
		} catch (error: unknown) {
			return Promise.reject(error);
		}
		this.#retirementPromise = this.#retire(drainTimeoutMs);
		return this.#retirementPromise;
	}
}

export async function startGatewayRuntimeUdsServer(
	options: StartGatewayRuntimeUdsServerOptions,
): Promise<GatewayRuntimeUdsServer> {
	await prepareGatewayRuntimeDirectory(options.paths);
	await removeOnlyStaleSocket(options.paths.managedPluginSocketPath);
	const runtime = new GatewayRuntimeUdsServerRuntime(options);
	try {
		await runtime.publish();
		return runtime;
	} catch (error: unknown) {
		await runtime.retire({ drainTimeoutMs: 1 }).catch(() => undefined);
		throw error;
	}
}
