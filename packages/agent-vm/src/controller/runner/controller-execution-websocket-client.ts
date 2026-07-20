/* oxlint-disable eslint/no-await-in-loop -- data frames, terminal priority, and VM output chunks must cross the bounded transport sequentially. */
import { Buffer } from 'node:buffer';

import {
	ControllerExecutionDataCreditSchema,
	ControllerExecutionDataFrameSchema,
	ControllerExecutionDataHandshakeSchema,
	ControllerExecutionWebSocketPath,
	type ControllerExecutionDataBinding,
} from '@agent-vm/controller-execution-contracts/controller-execution-data-boundary';
import type { ManagedVmExecProcess } from '@agent-vm/managed-vm';
import { type RawData, WebSocket } from 'ws';

const policyViolationCloseCode = 1008;

interface DeferredConnection {
	readonly promise: Promise<void>;
	readonly reject: (error: Error) => void;
	readonly resolve: () => void;
}

interface PendingDataFrame {
	readonly data: Uint8Array;
	readonly operation: DeferredConnection;
	settled: boolean;
}

interface PendingTerminalFrame {
	readonly kind: 'cancel' | 'eof';
	readonly operation: DeferredConnection;
	settled: boolean;
}

export interface ControllerExecutionWebSocketClient {
	readonly cancel: () => Promise<void>;
	readonly close: () => void;
	readonly connected: Promise<void>;
	readonly sendData: (data: Uint8Array) => Promise<void>;
	readonly sendEof: () => Promise<void>;
}

export interface CreateControllerExecutionWebSocketClientOptions {
	readonly authorization: {
		readonly headerValue: string;
	};
	readonly binding: ControllerExecutionDataBinding;
	readonly limits: {
		readonly maxBufferedBytes: number;
		readonly maxMessageBytes: number;
		readonly maxQueuedBytes: number;
		readonly maxQueuedMessages: number;
		readonly maxWindowBytes: number;
	};
	readonly url: string;
}

function createDeferredConnection(): DeferredConnection {
	let rejectConnection: ((error: Error) => void) | undefined;
	let resolveConnection: (() => void) | undefined;
	const promise = new Promise<void>((resolve, reject) => {
		rejectConnection = reject;
		resolveConnection = resolve;
	});
	if (rejectConnection === undefined || resolveConnection === undefined) {
		throw new Error('Controller execution connection promise was not initialized.');
	}
	return { promise, reject: rejectConnection, resolve: resolveConnection };
}

function settlePendingTerminalFrame(
	pendingFrame: PendingTerminalFrame,
	result: { readonly error: Error } | { readonly error?: undefined },
): void {
	if (pendingFrame.settled) return;
	pendingFrame.settled = true;
	if (result.error === undefined) pendingFrame.operation.resolve();
	else pendingFrame.operation.reject(result.error);
}

function rawDataToUtf8(data: RawData): string {
	if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	return data.toString('utf8');
}

function bindingsMatch(
	expected: ControllerExecutionDataBinding,
	candidate: ControllerExecutionDataBinding,
): boolean {
	return (
		expected.audience === candidate.audience &&
		expected.channelId === candidate.channelId &&
		expected.controllerEpoch === candidate.controllerEpoch &&
		expected.executionFingerprint === candidate.executionFingerprint &&
		expected.gatewayEpoch === candidate.gatewayEpoch &&
		expected.operationId === candidate.operationId &&
		expected.runtimeEpoch === candidate.runtimeEpoch &&
		expected.stablePrincipal === candidate.stablePrincipal
	);
}

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer.`);
	}
}

export function createControllerExecutionWebSocketClient(
	options: CreateControllerExecutionWebSocketClientOptions,
): ControllerExecutionWebSocketClient {
	requirePositiveSafeInteger(options.limits.maxBufferedBytes, 'maxBufferedBytes');
	requirePositiveSafeInteger(options.limits.maxMessageBytes, 'maxMessageBytes');
	requirePositiveSafeInteger(options.limits.maxQueuedBytes, 'maxQueuedBytes');
	requirePositiveSafeInteger(options.limits.maxQueuedMessages, 'maxQueuedMessages');
	requirePositiveSafeInteger(options.limits.maxWindowBytes, 'maxWindowBytes');
	if (options.authorization.headerValue.length === 0) {
		throw new Error('Controller execution authorization header must be non-empty.');
	}
	const parsedUrl = new URL(options.url);
	if (
		(parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') ||
		parsedUrl.username.length > 0 ||
		parsedUrl.password.length > 0 ||
		parsedUrl.pathname !== ControllerExecutionWebSocketPath ||
		parsedUrl.search.length > 0 ||
		parsedUrl.hash.length > 0
	) {
		throw new Error(
			`Controller execution WebSocket URL must use ws/wss without user information and the exact controller execution path '${ControllerExecutionWebSocketPath}' without a query or fragment.`,
		);
	}

	const connection = createDeferredConnection();
	void connection.promise.catch((): void => undefined);
	const socket = new WebSocket(parsedUrl, {
		headers: { authorization: options.authorization.headerValue },
		maxPayload: options.limits.maxMessageBytes,
		perMessageDeflate: false,
	});
	let availableCreditBytes = 0;
	let activeDataFrame: PendingDataFrame | undefined;
	let connectionSettled = false;
	let drainingQueue = false;
	let nextSequence = 0;
	const pendingDataFrames: PendingDataFrame[] = [];
	let pendingTerminalFrame: PendingTerminalFrame | undefined;
	let retainedBytes = 0;
	let retainedMessages = 0;
	let state: 'connecting' | 'awaiting-credit' | 'active' | 'terminal' | 'closed' = 'connecting';

	const settlePendingDataFrame = (
		pendingFrame: PendingDataFrame,
		result: { readonly error: Error } | { readonly error?: undefined },
	): void => {
		if (pendingFrame.settled) return;
		pendingFrame.settled = true;
		retainedBytes -= pendingFrame.data.byteLength;
		retainedMessages -= 1;
		if (result.error === undefined) pendingFrame.operation.resolve();
		else pendingFrame.operation.reject(result.error);
	};
	const rejectQueuedDataFrames = (error: Error): void => {
		for (const pendingFrame of pendingDataFrames.splice(0)) {
			settlePendingDataFrame(pendingFrame, { error });
		}
	};
	const rejectOutstandingOperations = (error: Error): void => {
		rejectQueuedDataFrames(error);
		if (activeDataFrame !== undefined) settlePendingDataFrame(activeDataFrame, { error });
		if (pendingTerminalFrame !== undefined) {
			settlePendingTerminalFrame(pendingTerminalFrame, { error });
		}
	};
	const rejectConnectionOnce = (error: Error): void => {
		if (connectionSettled) return;
		connectionSettled = true;
		connection.reject(error);
	};
	const failClosed = (reason: string): void => {
		const failure = new Error(`Controller execution WebSocket rejected ${reason}.`);
		state = 'closed';
		rejectConnectionOnce(failure);
		rejectOutstandingOperations(failure);
		if (socket.readyState === WebSocket.OPEN) socket.close(policyViolationCloseCode, reason);
	};
	const sendText = async (text: string): Promise<void> => {
		if (Buffer.byteLength(text, 'utf8') > options.limits.maxMessageBytes) {
			throw new Error('Controller execution message exceeds the configured message capacity.');
		}
		if (socket.bufferedAmount >= options.limits.maxBufferedBytes) {
			throw new Error('Controller execution WebSocket backpressure capacity was reached.');
		}
		await new Promise<void>((resolve, reject) => {
			socket.send(text, { binary: false, compress: false }, (error?: Error): void => {
				if (error !== undefined && error !== null) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	};
	const drainQueue = async (): Promise<void> => {
		if (drainingQueue) return;
		drainingQueue = true;
		try {
			await connection.promise;
			while (state === 'active' && activeDataFrame === undefined) {
				if (pendingTerminalFrame !== undefined) {
					const terminalFrame = pendingTerminalFrame;
					state = 'terminal';
					const frame = ControllerExecutionDataFrameSchema.parse({
						...options.binding,
						creditBytes: availableCreditBytes,
						kind: terminalFrame.kind,
						sequence: nextSequence,
					});
					await sendText(JSON.stringify(frame));
					settlePendingTerminalFrame(terminalFrame, {});
					return;
				}

				const nextDataFrame = pendingDataFrames[0];
				if (nextDataFrame === undefined || nextDataFrame.data.byteLength > availableCreditBytes) {
					return;
				}
				pendingDataFrames.shift();
				activeDataFrame = nextDataFrame;
				const frame = ControllerExecutionDataFrameSchema.parse({
					...options.binding,
					creditBytes: availableCreditBytes,
					kind: 'data',
					payloadBase64: Buffer.from(nextDataFrame.data).toString('base64'),
					sequence: nextSequence,
				});
				availableCreditBytes -= nextDataFrame.data.byteLength;
				nextSequence += 1;
				await sendText(JSON.stringify(frame));
				settlePendingDataFrame(nextDataFrame, {});
				activeDataFrame = undefined;
			}
		} catch (error: unknown) {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (activeDataFrame !== undefined) {
				settlePendingDataFrame(activeDataFrame, { error: failure });
				activeDataFrame = undefined;
			}
			failClosed('send-failed');
		} finally {
			drainingQueue = false;
		}
	};
	const scheduleQueueDrain = (): void => {
		void drainQueue();
	};

	socket.once('open', (): void => {
		if (state !== 'connecting') return;
		state = 'awaiting-credit';
		const handshake = ControllerExecutionDataHandshakeSchema.parse({
			...options.binding,
			kind: 'handshake',
		});
		void sendText(JSON.stringify(handshake)).catch((): void => {
			failClosed('handshake-send-failed');
		});
	});
	socket.on('message', (data, isBinary): void => {
		if (isBinary) {
			failClosed('binary-message');
			return;
		}
		let parsedMessage: unknown;
		try {
			parsedMessage = JSON.parse(rawDataToUtf8(data)) as unknown;
		} catch {
			failClosed('invalid-credit');
			return;
		}
		const parsedCredit = ControllerExecutionDataCreditSchema.safeParse(parsedMessage);
		if (
			!parsedCredit.success ||
			!bindingsMatch(options.binding, parsedCredit.data) ||
			parsedCredit.data.nextSequence !== nextSequence
		) {
			failClosed('invalid-credit');
			return;
		}
		if (state !== 'awaiting-credit' && state !== 'active') {
			failClosed('unexpected-credit');
			return;
		}
		availableCreditBytes = parsedCredit.data.availableCreditBytes;
		if (state === 'awaiting-credit') {
			state = 'active';
			connectionSettled = true;
			connection.resolve();
		}
		scheduleQueueDrain();
	});
	socket.once('error', (error): void => {
		state = 'closed';
		rejectConnectionOnce(error);
		rejectOutstandingOperations(error);
	});
	socket.once('close', (code, reason): void => {
		state = 'closed';
		const closeError = new Error(
			`Controller execution WebSocket closed (${String(code)}: ${reason.toString('utf8')}).`,
		);
		rejectConnectionOnce(closeError);
		rejectOutstandingOperations(closeError);
	});

	const sendTerminal = (terminalKind: 'cancel' | 'eof'): Promise<void> => {
		if (state === 'closed' || state === 'terminal' || pendingTerminalFrame !== undefined) {
			return Promise.reject(
				new Error('Controller execution WebSocket is closed, terminal, or already terminating.'),
			);
		}
		const terminalFrame = {
			kind: terminalKind,
			operation: createDeferredConnection(),
			settled: false,
		} satisfies PendingTerminalFrame;
		void terminalFrame.operation.promise.catch((): void => undefined);
		pendingTerminalFrame = terminalFrame;
		rejectQueuedDataFrames(
			new Error(`Controller execution bulk output was discarded after ${terminalKind}.`),
		);
		scheduleQueueDrain();
		return terminalFrame.operation.promise;
	};

	return {
		cancel: async (): Promise<void> => await sendTerminal('cancel'),
		close: (): void => {
			const closeError = new Error('Controller execution WebSocket was closed locally.');
			state = 'closed';
			rejectConnectionOnce(closeError);
			rejectOutstandingOperations(closeError);
			if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
				socket.close(1000, 'controller-close');
			}
		},
		connected: connection.promise,
		sendData: (data): Promise<void> => {
			if (state === 'closed' || state === 'terminal' || pendingTerminalFrame !== undefined) {
				return Promise.reject(
					new Error('Controller execution WebSocket is closed, terminal, or terminating.'),
				);
			}
			if (data.byteLength === 0 || data.byteLength > options.limits.maxWindowBytes) {
				return Promise.reject(
					new Error('Controller execution payload exceeds the configured window capacity.'),
				);
			}
			if (
				retainedBytes + data.byteLength > options.limits.maxQueuedBytes ||
				retainedMessages + 1 > options.limits.maxQueuedMessages
			) {
				return Promise.reject(
					new Error('Controller execution output queue reached its configured capacity.'),
				);
			}
			const pendingFrame = {
				data: Uint8Array.from(data),
				operation: createDeferredConnection(),
				settled: false,
			} satisfies PendingDataFrame;
			void pendingFrame.operation.promise.catch((): void => undefined);
			retainedBytes += pendingFrame.data.byteLength;
			retainedMessages += 1;
			pendingDataFrames.push(pendingFrame);
			scheduleQueueDrain();
			return pendingFrame.operation.promise;
		},
		sendEof: async (): Promise<void> => await sendTerminal('eof'),
	};
}

export interface StreamManagedVmExecProcessOutputOptions {
	readonly client: Pick<ControllerExecutionWebSocketClient, 'sendData' | 'sendEof'>;
	readonly maxChunkBytes: number;
	readonly process: Pick<ManagedVmExecProcess, 'output'>;
}

export async function streamManagedVmExecProcessOutput(
	options: StreamManagedVmExecProcessOutputOptions,
): Promise<void> {
	requirePositiveSafeInteger(options.maxChunkBytes, 'maxChunkBytes');
	for await (const outputChunk of options.process.output()) {
		for (let offset = 0; offset < outputChunk.data.byteLength; offset += options.maxChunkBytes) {
			await options.client.sendData(
				outputChunk.data.slice(
					offset,
					Math.min(offset + options.maxChunkBytes, outputChunk.data.byteLength),
				),
			);
		}
	}
	await options.client.sendEof();
}
