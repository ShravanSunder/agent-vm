import net from 'node:net';

import {
	GatewayRuntimeFrameDecoder,
	encodeGatewayRuntimeFrame,
	type GatewayRuntimeFrameLimitOverrides,
	type GatewayRuntimeJsonRpcMessage,
} from './gateway-runtime-protocol.js';
import { GatewayRuntimeStartupUnavailableError } from './gateway-runtime-startup-retry.js';
import type {
	GatewayRuntimeAttachmentMetadata,
	GatewayRuntimeConnection,
	GatewayRuntimeRequestOptions,
	GatewayRuntimeTransportFactory,
} from './index.js';

export type NodeGatewayRuntimeTransportErrorCode =
	| 'connection-closed'
	| 'connection-failed'
	| 'pending-request-limit-exceeded'
	| 'protocol-failed'
	| 'request-aborted'
	| 'request-id-exhausted'
	| 'request-write-failed'
	| 'unexpected-message';

export const GATEWAY_RUNTIME_REQUEST_CANCEL_NOTIFICATION_METHOD = 'notifications/cancelled';

export class NodeGatewayRuntimeTransportError extends Error {
	readonly code: NodeGatewayRuntimeTransportErrorCode;

	constructor(
		code: NodeGatewayRuntimeTransportErrorCode,
		message: string,
		options: ErrorOptions = {},
	) {
		super(message, options);
		this.name = 'NodeGatewayRuntimeTransportError';
		this.code = code;
	}
}

export class GatewayRuntimeRemoteError extends Error {
	readonly code: string;
	readonly data: unknown;

	constructor(code: string, message: string, data?: unknown) {
		super(message);
		this.name = 'GatewayRuntimeRemoteError';
		this.code = code;
		this.data = data;
	}
}

export interface NodeGatewayRuntimeTransportOptions {
	readonly frameLimits?: GatewayRuntimeFrameLimitOverrides;
	readonly maxPendingRequests?: number;
}

interface PendingRequest {
	readonly reject: (error: Error) => void;
	readonly resolve: (result: unknown) => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}

function assertPositiveSafeInteger(value: number, fieldName: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${fieldName} must be a positive safe integer.`);
	}
}

function createRemoteError(errorObject: unknown): GatewayRuntimeRemoteError {
	if (
		!isRecord(errorObject) ||
		!Number.isSafeInteger(errorObject['code']) ||
		typeof errorObject['message'] !== 'string'
	) {
		return new GatewayRuntimeRemoteError(
			'invalid-remote-error',
			'Gateway runtime returned an invalid JSON-RPC error.',
		);
	}
	return new GatewayRuntimeRemoteError(
		String(errorObject['code']),
		errorObject['message'],
		errorObject['data'],
	);
}

class NodeGatewayRuntimeConnection implements GatewayRuntimeConnection {
	readonly #decoder: GatewayRuntimeFrameDecoder;
	readonly #frameLimits: GatewayRuntimeFrameLimitOverrides;
	readonly #maxPendingRequests: number;
	readonly #discardedRequestIds = new Set<number>();
	readonly #pendingRequests = new Map<number, PendingRequest>();
	readonly #socket: net.Socket;
	#closed = false;
	#nextRequestId = 1;
	#pendingWrite: Promise<void> = Promise.resolve();

	constructor(options: {
		readonly frameLimits: GatewayRuntimeFrameLimitOverrides;
		readonly maxPendingRequests: number;
		readonly socket: net.Socket;
	}) {
		this.#decoder = new GatewayRuntimeFrameDecoder(options.frameLimits);
		this.#frameLimits = options.frameLimits;
		this.#maxPendingRequests = options.maxPendingRequests;
		this.#socket = options.socket;
		this.#socket.on('data', (chunk: Buffer) => this.#receiveChunk(chunk));
		this.#socket.once('close', () => {
			this.#failConnection(
				new NodeGatewayRuntimeTransportError(
					'connection-closed',
					'Gateway runtime connection closed.',
				),
			);
		});
		this.#socket.once('error', (error) => {
			this.#failConnection(
				new NodeGatewayRuntimeTransportError(
					'connection-failed',
					'Gateway runtime connection failed.',
					{ cause: error },
				),
			);
		});
	}

	#failConnection(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const pendingRequest of this.#pendingRequests.values()) {
			pendingRequest.reject(error);
		}
		this.#pendingRequests.clear();
		this.#discardedRequestIds.clear();
		if (!this.#socket.destroyed) this.#socket.destroy();
	}

	#receiveChunk(chunk: Uint8Array): void {
		if (this.#closed) return;
		let messages: readonly GatewayRuntimeJsonRpcMessage[];
		try {
			messages = this.#decoder.push(chunk);
		} catch (error: unknown) {
			this.#failConnection(
				new NodeGatewayRuntimeTransportError(
					'protocol-failed',
					'Gateway runtime response framing failed.',
					{ cause: error },
				),
			);
			return;
		}
		for (const message of messages) this.#receiveMessage(message);
	}

	#receiveMessage(message: GatewayRuntimeJsonRpcMessage): void {
		if (!Object.hasOwn(message, 'id') || Object.hasOwn(message, 'method')) {
			this.#failConnection(
				new NodeGatewayRuntimeTransportError(
					'unexpected-message',
					'Gateway runtime client received an unexpected request or notification.',
				),
			);
			return;
		}
		const requestId = message['id'];
		if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId)) {
			this.#failConnection(
				new NodeGatewayRuntimeTransportError(
					'unexpected-message',
					'Gateway runtime response id is not a pending integer request id.',
				),
			);
			return;
		}
		const pendingRequest = this.#pendingRequests.get(requestId);
		if (pendingRequest === undefined) {
			if (this.#discardedRequestIds.delete(requestId)) return;
			this.#failConnection(
				new NodeGatewayRuntimeTransportError(
					'unexpected-message',
					'Gateway runtime response does not match a pending request.',
				),
			);
			return;
		}
		this.#pendingRequests.delete(requestId);
		if (Object.hasOwn(message, 'error')) {
			pendingRequest.reject(createRemoteError(message['error']));
			return;
		}
		pendingRequest.resolve(message['result']);
	}

	#allocateRequestId(): number {
		if (!Number.isSafeInteger(this.#nextRequestId)) {
			throw new NodeGatewayRuntimeTransportError(
				'request-id-exhausted',
				'Gateway runtime request id space is exhausted.',
			);
		}
		const requestId = this.#nextRequestId;
		this.#nextRequestId += 1;
		return requestId;
	}

	async #writeFrameImmediately(frame: Uint8Array): Promise<void> {
		if (this.#closed) {
			throw new NodeGatewayRuntimeTransportError(
				'connection-closed',
				'Gateway runtime connection is closed.',
			);
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				cleanup();
				reject(
					new NodeGatewayRuntimeTransportError(
						'request-write-failed',
						'Gateway runtime request write failed.',
						{ cause: error },
					),
				);
			};
			const cleanup = (): void => {
				this.#socket.off('error', onError);
			};
			this.#socket.once('error', onError);
			this.#socket.write(frame, (error?: Error | null) => {
				if (error !== undefined && error !== null) {
					onError(error);
					return;
				}
				cleanup();
				resolve();
			});
		});
		if (!this.#socket.writableNeedDrain) return;
		await new Promise<void>((resolve, reject) => {
			const onDrain = (): void => {
				cleanup();
				resolve();
			};
			const onError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			const cleanup = (): void => {
				this.#socket.off('drain', onDrain);
				this.#socket.off('error', onError);
			};
			this.#socket.once('drain', onDrain);
			this.#socket.once('error', onError);
		});
	}

	async #writeFrame(frame: Uint8Array): Promise<void> {
		const write = this.#pendingWrite.then(async () => await this.#writeFrameImmediately(frame));
		this.#pendingWrite = write.catch(() => undefined);
		await write;
	}

	async handshake(
		attachment: GatewayRuntimeAttachmentMetadata,
		options: GatewayRuntimeRequestOptions = {},
	): Promise<void> {
		const decision = await this.request('managed-plugin.handshake', attachment, options);
		if (isRecord(decision) && decision['kind'] === 'accepted') return;
		const rejectionCode = isRecord(decision) ? decision['code'] : undefined;
		throw new GatewayRuntimeRemoteError(
			typeof rejectionCode === 'string' ? rejectionCode : 'invalid-handshake',
			'Gateway runtime rejected the managed-plugin attachment.',
			decision,
		);
	}

	async request(
		method: string,
		params: unknown,
		options: GatewayRuntimeRequestOptions = {},
	): Promise<unknown> {
		if (options.signal?.aborted === true) {
			throw new NodeGatewayRuntimeTransportError(
				'request-aborted',
				'Gateway runtime request was aborted before dispatch.',
				{ cause: options.signal.reason },
			);
		}
		if (this.#pendingRequests.size >= this.#maxPendingRequests) {
			throw new NodeGatewayRuntimeTransportError(
				'pending-request-limit-exceeded',
				'Gateway runtime pending request limit was reached.',
			);
		}
		const requestId = this.#allocateRequestId();
		const frame = encodeGatewayRuntimeFrame(
			{ id: requestId, jsonrpc: '2.0', method, params },
			this.#frameLimits,
		);
		return await new Promise<unknown>((resolve, reject) => {
			let settled = false;
			const settleRejected = (error: Error): void => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener('abort', onAbort);
				this.#pendingRequests.delete(requestId);
				reject(error);
			};
			const settleResolved = (result: unknown): void => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener('abort', onAbort);
				resolve(result);
			};
			const onAbort = (): void => {
				if (settled) return;
				if (this.#discardedRequestIds.size >= this.#maxPendingRequests) {
					const capacityError = new NodeGatewayRuntimeTransportError(
						'pending-request-limit-exceeded',
						'Gateway runtime discarded-request limit was reached.',
					);
					settleRejected(capacityError);
					this.#failConnection(capacityError);
					return;
				}
				this.#discardedRequestIds.add(requestId);
				settleRejected(
					new NodeGatewayRuntimeTransportError(
						'request-aborted',
						'Gateway runtime request was aborted locally.',
						{ cause: options.signal?.reason },
					),
				);
				const cancellationFrame = encodeGatewayRuntimeFrame(
					{
						jsonrpc: '2.0',
						method: GATEWAY_RUNTIME_REQUEST_CANCEL_NOTIFICATION_METHOD,
						params: { requestId },
					},
					this.#frameLimits,
				);
				void this.#writeFrame(cancellationFrame).catch((error: unknown) => {
					this.#failConnection(
						error instanceof Error
							? error
							: new NodeGatewayRuntimeTransportError(
									'request-write-failed',
									'Gateway runtime cancellation write failed.',
								),
					);
				});
			};
			this.#pendingRequests.set(requestId, {
				reject: settleRejected,
				resolve: settleResolved,
			});
			options.signal?.addEventListener('abort', onAbort, { once: true });
			void this.#writeFrame(frame).catch(settleRejected);
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#failConnection(
			new NodeGatewayRuntimeTransportError(
				'connection-closed',
				'Gateway runtime connection closed locally.',
			),
		);
	}
}

export function createNodeGatewayRuntimeTransportFactory(
	options: NodeGatewayRuntimeTransportOptions = {},
): GatewayRuntimeTransportFactory {
	const frameLimits = options.frameLimits ?? {};
	const maxPendingRequests = options.maxPendingRequests ?? 64;
	assertPositiveSafeInteger(maxPendingRequests, 'maxPendingRequests');
	return {
		connect: async ({ signal, socketPath }): Promise<GatewayRuntimeConnection> => {
			const socket = net.createConnection({ path: socketPath, signal });
			await new Promise<void>((resolve, reject) => {
				const onConnect = (): void => {
					cleanup();
					resolve();
				};
				const onError = (error: Error): void => {
					cleanup();
					const errorCode = nodeErrorCode(error);
					if (errorCode === 'ENOENT' || errorCode === 'ECONNREFUSED') {
						reject(
							new GatewayRuntimeStartupUnavailableError(
								errorCode === 'ENOENT' ? 'socket-absent' : 'socket-refused',
								{ cause: error },
							),
						);
						return;
					}
					reject(
						new NodeGatewayRuntimeTransportError(
							'connection-failed',
							'Gateway runtime UDS connection failed.',
							{ cause: error },
						),
					);
				};
				const cleanup = (): void => {
					socket.off('connect', onConnect);
					socket.off('error', onError);
				};
				socket.once('connect', onConnect);
				socket.once('error', onError);
			});
			return new NodeGatewayRuntimeConnection({ frameLimits, maxPendingRequests, socket });
		},
	};
}
