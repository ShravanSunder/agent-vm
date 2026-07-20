import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
	GatewayRuntimeFrameDecoder,
	GatewayRuntimeSocketReadFlow,
	encodeGatewayRuntimeFrame,
	type GatewayRuntimeClientFrame,
	type GatewayRuntimeJsonRpcMessage,
	type GatewayRuntimePauseDeadlineScheduler,
	type GatewayRuntimeRetainedByteLimits,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { describe, expect, it, vi } from 'vitest';

import { sendGatewayRuntimeApplicationChunks } from './gateway-runtime-bounded-chunk-sender.js';

const PROTOCOL_WAIT_MILLISECONDS = 5_000;
const PAUSE_DEADLINE_MILLISECONDS = 25;
const TARGET_STREAM_ID = 'stream-target';
const SIBLING_STREAM_ID = 'stream-sibling';

const RETAINED_BYTE_LIMITS = {
	maxKernelSendBufferedBytes: 1_048_576,
	maxNodeWritableBufferedBytes: 1_048_576,
	maxParserBufferedBytes: 1_048_576,
	maxSourceOwnedApplicationChunkBytes: 8,
} as const satisfies GatewayRuntimeRetainedByteLimits;

interface UnixSocketPair {
	readonly clientSocket: Socket;
	readonly serverSocket: Socket;
}

interface StreamCompletion {
	readonly outcome: string;
	readonly streamId: string;
}

interface ScheduledDeadline {
	readonly afterMilliseconds: number;
	readonly onDeadline: () => void;
	readonly handle: number;
}

class ManualPauseDeadlineScheduler implements GatewayRuntimePauseDeadlineScheduler {
	readonly #scheduledDeadlines = new Map<number, ScheduledDeadline>();
	#nextHandle = 1;
	readonly cancelledHandles: number[] = [];

	get pendingCount(): number {
		return this.#scheduledDeadlines.size;
	}

	get pendingAfterMilliseconds(): readonly number[] {
		return Array.from(this.#scheduledDeadlines.values(), (deadline) => deadline.afterMilliseconds);
	}

	readonly schedule = (options: {
		readonly afterMilliseconds: number;
		readonly onDeadline: () => void;
	}): { readonly cancel: () => void } => {
		const handle = this.#nextHandle;
		this.#nextHandle += 1;
		this.#scheduledDeadlines.set(handle, { ...options, handle });
		return {
			cancel: (): void => {
				if (this.#scheduledDeadlines.delete(handle)) this.cancelledHandles.push(handle);
			},
		};
	};

	expireOnlyPendingDeadline(): void {
		const deadlines = Array.from(this.#scheduledDeadlines.values());
		if (deadlines.length !== 1) {
			throw new Error(`Expected exactly one pending deadline, received ${deadlines.length}.`);
		}
		const deadline = deadlines[0];
		if (deadline === undefined) throw new Error('Pending deadline disappeared.');
		this.#scheduledDeadlines.delete(deadline.handle);
		deadline.onDeadline();
	}
}

class ControlledAsyncChunkSource implements AsyncIterableIterator<Uint8Array> {
	readonly #nextCallSignals = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
	readonly #nextResultResolvers = new Map<
		number,
		ReturnType<typeof Promise.withResolvers<IteratorResult<Uint8Array>>>
	>();
	#activeNextCallCount = 0;
	nextCallCount = 0;
	maximumConcurrentNextCallCount = 0;
	returnCallCount = 0;

	[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
		return this;
	}

	next(): Promise<IteratorResult<Uint8Array>> {
		this.nextCallCount += 1;
		const callNumber = this.nextCallCount;
		this.#activeNextCallCount += 1;
		this.maximumConcurrentNextCallCount = Math.max(
			this.maximumConcurrentNextCallCount,
			this.#activeNextCallCount,
		);
		this.#nextCallSignals.get(callNumber)?.resolve();
		const resultResolver =
			this.#nextResultResolvers.get(callNumber) ??
			Promise.withResolvers<IteratorResult<Uint8Array>>();
		this.#nextResultResolvers.set(callNumber, resultResolver);
		return resultResolver.promise.finally(() => {
			this.#activeNextCallCount -= 1;
		});
	}

	return(): Promise<IteratorResult<Uint8Array>> {
		this.returnCallCount += 1;
		return Promise.resolve({ done: true, value: undefined });
	}

	waitForNextCall(callNumber: number): Promise<void> {
		if (this.nextCallCount >= callNumber) return Promise.resolve();
		const signal = this.#nextCallSignals.get(callNumber) ?? Promise.withResolvers<void>();
		this.#nextCallSignals.set(callNumber, signal);
		return signal.promise;
	}

	resolveNextCall(callNumber: number, result: IteratorResult<Uint8Array>): void {
		const resolver =
			this.#nextResultResolvers.get(callNumber) ??
			Promise.withResolvers<IteratorResult<Uint8Array>>();
		this.#nextResultResolvers.set(callNumber, resolver);
		resolver.resolve(result);
	}
}

async function withUnixSocketPair<TResult>(
	run: (pair: UnixSocketPair) => Promise<TResult>,
): Promise<TResult> {
	const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-runtime-pressure-'));
	const socketPath = path.join(temporaryRoot, 'managed-plugin.sock');
	const acceptedSocket = Promise.withResolvers<Socket>();
	const server: Server = net.createServer((socket) => acceptedSocket.resolve(socket));
	server.listen(socketPath);
	await once(server, 'listening', { signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS) });
	const clientSocket = net.createConnection(socketPath);
	await once(clientSocket, 'connect', {
		signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
	});
	const serverSocket = await acceptedSocket.promise;
	clientSocket.on('error', () => undefined);
	serverSocket.on('error', () => undefined);

	try {
		return await run({ clientSocket, serverSocket });
	} finally {
		clientSocket.destroy();
		serverSocket.destroy();
		server.close();
		await once(server, 'close', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});
		await rm(temporaryRoot, { force: true, recursive: true });
	}
}

function encodeTestApplicationChunk(
	chunk: Uint8Array,
	messageId: number,
	paddingByteCount = 0,
): Uint8Array {
	return encodeGatewayRuntimeFrame({
		id: messageId,
		jsonrpc: '2.0',
		result: {
			testApplicationChunkBytes: Array.from(chunk),
			testTransportPadding: 'x'.repeat(paddingByteCount),
		},
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeTestFlowFrame(frame: GatewayRuntimeClientFrame, messageId: number): Uint8Array {
	const testFlowFrame =
		frame.kind === 'stream-data'
			? {
					chunkBytes: Array.from(frame.chunk),
					kind: frame.kind,
					streamId: frame.streamId,
				}
			: { ...frame };
	return encodeGatewayRuntimeFrame({ id: messageId, jsonrpc: '2.0', result: testFlowFrame });
}

function decodeTestFlowFrame(message: GatewayRuntimeJsonRpcMessage): GatewayRuntimeClientFrame {
	const frame = message['result'];
	if (!isRecord(frame) || typeof frame['kind'] !== 'string') {
		throw new Error('Test JSON-RPC response did not contain a flow frame.');
	}
	if (frame['kind'] === 'control') {
		if (typeof frame['method'] !== 'string') throw new Error('Control frame method is invalid.');
		return { kind: 'control', method: frame['method'] };
	}
	if (frame['kind'] === 'authoritative-stream-terminal') {
		if (typeof frame['outcome'] !== 'string' || typeof frame['streamId'] !== 'string') {
			throw new Error('Terminal flow frame is invalid.');
		}
		return {
			kind: 'authoritative-stream-terminal',
			outcome: frame['outcome'],
			streamId: frame['streamId'],
		};
	}
	if (frame['kind'] === 'stream-data') {
		if (!Array.isArray(frame['chunkBytes']) || typeof frame['streamId'] !== 'string') {
			throw new Error('Data flow frame is invalid.');
		}
		const chunkBytes: number[] = [];
		for (const byte of frame['chunkBytes']) {
			if (typeof byte !== 'number' || !Number.isSafeInteger(byte) || byte < 0 || byte > 255) {
				throw new Error('Data flow frame byte is invalid.');
			}
			chunkBytes.push(byte);
		}
		return {
			chunk: Uint8Array.from(chunkBytes),
			kind: 'stream-data',
			streamId: frame['streamId'],
		};
	}
	throw new Error(`Unknown test flow frame kind '${frame['kind']}'.`);
}

async function writeTestFlowFrame(
	socket: Socket,
	frame: GatewayRuntimeClientFrame,
	messageId: number,
): Promise<void> {
	if (socket.write(encodeTestFlowFrame(frame, messageId))) return;
	await once(socket, 'drain', { signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS) });
}

function attachFlowFrameDecoder(
	socket: Socket,
	receiveFrame: (frame: GatewayRuntimeClientFrame) => void,
): void {
	const decoder = new GatewayRuntimeFrameDecoder();
	socket.on('data', (chunk: Buffer) => {
		for (const message of decoder.push(chunk)) receiveFrame(decodeTestFlowFrame(message));
	});
}

describe('Gateway runtime bounded application chunk sender', () => {
	it('owns one source chunk and waits for real socket drain before reading again', async () => {
		await withUnixSocketPair(async ({ clientSocket, serverSocket }) => {
			// Arrange
			clientSocket.cork();
			serverSocket.pause();
			const source = new ControlledAsyncChunkSource();
			const pressureObserved = Promise.withResolvers<void>();
			const serverDecoder = new GatewayRuntimeFrameDecoder();
			const receivedMessage = Promise.withResolvers<void>();
			serverSocket.on('data', (chunk: Buffer) => {
				if (serverDecoder.push(chunk).length > 0) receivedMessage.resolve();
			});
			let encodedMessageId = 1;
			const sendPromise = sendGatewayRuntimeApplicationChunks({
				encodeChunk: (chunk: Uint8Array): Uint8Array => {
					const encoded = encodeTestApplicationChunk(chunk, encodedMessageId, 524_288);
					encodedMessageId += 1;
					return encoded;
				},
				maxTotalApplicationBytes: 16,
				observeExternalRetainedBytes: async (): Promise<{
					readonly kernelSendBufferedBytes: number;
					readonly parserBufferedBytes: number;
				}> => ({ kernelSendBufferedBytes: 11, parserBufferedBytes: 7 }),
				onWritablePressure: (_evidence: unknown): void => pressureObserved.resolve(),
				retainedByteLimits: RETAINED_BYTE_LIMITS,
				source,
				writable: clientSocket,
			});
			await source.waitForNextCall(1);

			// Act
			source.resolveNextCall(1, { done: false, value: new Uint8Array([1, 2, 3, 4]) });
			await pressureObserved.promise;

			// Assert
			expect(source.nextCallCount).toBe(1);
			expect(source.maximumConcurrentNextCallCount).toBe(1);
			clientSocket.uncork();
			serverSocket.resume();
			await source.waitForNextCall(2);
			source.resolveNextCall(2, { done: true, value: undefined });
			const result = await sendPromise;
			await receivedMessage.promise;
			expect(result).toMatchObject({
				chunkReadCount: 1,
				chunkWriteCount: 1,
				highWaterRetainedBytes: {
					kernelSendBufferedBytes: 11,
					parserBufferedBytes: 7,
					sourceOwnedApplicationChunkBytes: 4,
				},
				kind: 'completed',
				totalApplicationBytes: 4,
			});
			expect(result.highWaterRetainedBytes.nodeWritableBufferedBytes).toBeLessThanOrEqual(
				RETAINED_BYTE_LIMITS.maxNodeWritableBufferedBytes,
			);
		});
	});

	it('stops source reads when the real socket disconnects under pressure', async () => {
		await withUnixSocketPair(async ({ clientSocket, serverSocket }) => {
			// Arrange
			clientSocket.cork();
			serverSocket.pause();
			const source = new ControlledAsyncChunkSource();
			const pressureObserved = Promise.withResolvers<void>();
			const sendPromise = sendGatewayRuntimeApplicationChunks({
				encodeChunk: (chunk: Uint8Array): Uint8Array =>
					encodeTestApplicationChunk(chunk, 1, 524_288),
				maxTotalApplicationBytes: 16,
				onWritablePressure: (_evidence: unknown): void => {
					clientSocket.destroy();
					pressureObserved.resolve();
				},
				retainedByteLimits: RETAINED_BYTE_LIMITS,
				source,
				writable: clientSocket,
			});
			await source.waitForNextCall(1);

			// Act
			source.resolveNextCall(1, { done: false, value: new Uint8Array([1, 2, 3, 4]) });
			await pressureObserved.promise;
			const settlement = await sendPromise.then(
				(result: unknown) => ({ kind: 'resolved' as const, result }),
				(error: unknown) => ({ error, kind: 'rejected' as const }),
			);

			// Assert
			expect(source.nextCallCount).toBe(1);
			expect(source.maximumConcurrentNextCallCount).toBe(1);
			if (settlement.kind === 'resolved') {
				expect(settlement.result).not.toMatchObject({ kind: 'completed' });
			} else {
				expect(settlement.error).toBeInstanceOf(Error);
			}
		});
	});

	it('returns typed total-byte exhaustion before encoding, writing, or reading past the over-cap chunk', async () => {
		await withUnixSocketPair(async ({ clientSocket, serverSocket }) => {
			// Arrange
			let sourceChunkReadCount = 0;
			let encodeCallCount = 0;
			const serverDecoder = new GatewayRuntimeFrameDecoder();
			const receivedFirstMessage = Promise.withResolvers<void>();
			const receivedMessages: GatewayRuntimeJsonRpcMessage[] = [];
			serverSocket.on('data', (chunk: Buffer) => {
				receivedMessages.push(...serverDecoder.push(chunk));
				if (receivedMessages.length === 1) receivedFirstMessage.resolve();
			});
			async function* source(): AsyncGenerator<Uint8Array> {
				sourceChunkReadCount += 1;
				yield new Uint8Array([1, 2, 3]);
				sourceChunkReadCount += 1;
				yield new Uint8Array([4, 5, 6]);
				sourceChunkReadCount += 1;
				yield new Uint8Array([7]);
			}

			// Act
			const result = await sendGatewayRuntimeApplicationChunks({
				encodeChunk: (chunk: Uint8Array): Uint8Array => {
					encodeCallCount += 1;
					return encodeTestApplicationChunk(chunk, encodeCallCount);
				},
				maxTotalApplicationBytes: 4,
				retainedByteLimits: RETAINED_BYTE_LIMITS,
				source: source(),
				writable: clientSocket,
			});
			await receivedFirstMessage.promise;

			// Assert
			expect(result).toMatchObject({
				chunkReadCount: 2,
				chunkWriteCount: 1,
				kind: 'total-byte-limit-exceeded',
				totalApplicationBytes: 3,
			});
			expect(sourceChunkReadCount).toBe(2);
			expect(encodeCallCount).toBe(1);
			expect(receivedMessages).toHaveLength(1);
		});
	});

	it.each([
		{ failureStage: 'encode-chunk', label: 'encodeChunk throws' },
		{ failureStage: 'writable-write', label: 'writable.write throws' },
		{
			failureStage: 'retained-byte-observation',
			label: 'retained-byte observation rejects',
		},
		{
			failureStage: 'writable-pressure-hook',
			label: 'onWritablePressure rejects',
		},
	] as const)('closes its async source iterator when $label', async ({ failureStage }) => {
		await withUnixSocketPair(async ({ clientSocket, serverSocket }) => {
			// Arrange
			const expectedError = new Error(`test-only ${failureStage} failure`);
			const source = new ControlledAsyncChunkSource();
			if (failureStage === 'writable-pressure-hook') {
				clientSocket.cork();
				serverSocket.pause();
			}
			if (failureStage === 'writable-write') {
				vi.spyOn(clientSocket, 'write').mockImplementationOnce((): boolean => {
					throw expectedError;
				});
			}
			const sendPromise = sendGatewayRuntimeApplicationChunks({
				encodeChunk: (chunk: Uint8Array): Uint8Array => {
					if (failureStage === 'encode-chunk') throw expectedError;
					return encodeTestApplicationChunk(
						chunk,
						1,
						failureStage === 'writable-pressure-hook' ? 524_288 : 0,
					);
				},
				maxTotalApplicationBytes: 16,
				observeExternalRetainedBytes: async (): Promise<{
					readonly kernelSendBufferedBytes: number;
					readonly parserBufferedBytes: number;
				}> => {
					if (failureStage === 'retained-byte-observation') throw expectedError;
					return { kernelSendBufferedBytes: 0, parserBufferedBytes: 0 };
				},
				onWritablePressure: async (): Promise<void> => {
					if (failureStage === 'writable-pressure-hook') throw expectedError;
				},
				retainedByteLimits: RETAINED_BYTE_LIMITS,
				source,
				writable: clientSocket,
			});
			await source.waitForNextCall(1);

			// Act
			source.resolveNextCall(1, { done: false, value: new Uint8Array([1, 2, 3, 4]) });

			// Assert
			await expect(sendPromise).rejects.toBe(expectedError);
			clientSocket.uncork();
			serverSocket.resume();
			expect(source.returnCallCount).toBe(1);
			expect(source.nextCallCount).toBe(1);
		});
	});
});

describe('Gateway runtime socket read flow', () => {
	it('pauses and resumes the actual socket while cancelling the bounded deadline', async () => {
		await withUnixSocketPair(async ({ clientSocket }) => {
			// Arrange
			const pause = vi.spyOn(clientSocket, 'pause');
			const resume = vi.spyOn(clientSocket, 'resume');
			const deadlineScheduler = new ManualPauseDeadlineScheduler();
			const readFlow = new GatewayRuntimeSocketReadFlow({
				deadlineScheduler,
				forwardFrame: (_frame: GatewayRuntimeClientFrame): void => undefined,
				onStreamCompleted: (_completion: StreamCompletion): void => undefined,
				pauseDeadlineMilliseconds: PAUSE_DEADLINE_MILLISECONDS,
				socket: clientSocket,
			});

			// Act
			readFlow.applyDownstreamPressure(TARGET_STREAM_ID);
			const scheduledAfterMilliseconds = deadlineScheduler.pendingAfterMilliseconds;
			readFlow.resumeDownstream(TARGET_STREAM_ID);

			// Assert
			expect(pause).toHaveBeenCalledTimes(1);
			expect(resume).toHaveBeenCalledTimes(1);
			expect(scheduledAfterMilliseconds).toEqual([PAUSE_DEADLINE_MILLISECONDS]);
			expect(deadlineScheduler.pendingCount).toBe(0);
			expect(deadlineScheduler.cancelledHandles).toHaveLength(1);
		});
	});

	it('deadline escape resumes reads, discards only target data, and awaits its authoritative terminal', async () => {
		await withUnixSocketPair(async ({ clientSocket, serverSocket }) => {
			// Arrange
			const deadlineScheduler = new ManualPauseDeadlineScheduler();
			const forwardedFrames: GatewayRuntimeClientFrame[] = [];
			const completions: StreamCompletion[] = [];
			const siblingFramesForwarded = Promise.withResolvers<void>();
			const targetCompleted = Promise.withResolvers<void>();
			const readFlow = new GatewayRuntimeSocketReadFlow({
				deadlineScheduler,
				forwardFrame: (frame: GatewayRuntimeClientFrame): void => {
					forwardedFrames.push(frame);
					if (forwardedFrames.length === 3) siblingFramesForwarded.resolve();
				},
				onStreamCompleted: (completion: StreamCompletion): void => {
					completions.push(completion);
					targetCompleted.resolve();
				},
				pauseDeadlineMilliseconds: PAUSE_DEADLINE_MILLISECONDS,
				socket: clientSocket,
			});
			attachFlowFrameDecoder(clientSocket, (frame) => readFlow.receiveFrame(frame));
			const pause = vi.spyOn(clientSocket, 'pause');
			const resume = vi.spyOn(clientSocket, 'resume');
			readFlow.applyDownstreamPressure(TARGET_STREAM_ID);
			const targetData = {
				chunk: new Uint8Array([1]),
				kind: 'stream-data',
				streamId: TARGET_STREAM_ID,
			} as const satisfies GatewayRuntimeClientFrame;
			const siblingData = {
				chunk: new Uint8Array([2]),
				kind: 'stream-data',
				streamId: SIBLING_STREAM_ID,
			} as const satisfies GatewayRuntimeClientFrame;
			const control = {
				kind: 'control',
				method: 'test-only.control-observation',
			} as const satisfies GatewayRuntimeClientFrame;
			const siblingTerminal = {
				kind: 'authoritative-stream-terminal',
				outcome: 'completed',
				streamId: SIBLING_STREAM_ID,
			} as const satisfies GatewayRuntimeClientFrame;

			// Act
			await writeTestFlowFrame(serverSocket, targetData, 1);
			await writeTestFlowFrame(serverSocket, siblingData, 2);
			await writeTestFlowFrame(serverSocket, control, 3);
			await writeTestFlowFrame(serverSocket, siblingTerminal, 4);
			expect(forwardedFrames).toEqual([]);
			deadlineScheduler.expireOnlyPendingDeadline();
			await siblingFramesForwarded.promise;

			// Assert
			expect(pause).toHaveBeenCalledTimes(1);
			expect(resume).toHaveBeenCalledTimes(1);
			expect(forwardedFrames).toEqual([siblingData, control, siblingTerminal]);
			expect(completions).toEqual([]);

			const targetTerminal = {
				kind: 'authoritative-stream-terminal',
				outcome: 'cancelled',
				streamId: TARGET_STREAM_ID,
			} as const satisfies GatewayRuntimeClientFrame;
			await writeTestFlowFrame(serverSocket, targetTerminal, 5);
			await targetCompleted.promise;
			expect(forwardedFrames).toEqual([siblingData, control, siblingTerminal, targetTerminal]);
			expect(completions).toEqual([{ outcome: 'cancelled', streamId: TARGET_STREAM_ID }]);
		});
	});

	it.each(['cancelStream', 'closeStream', 'retireAttachment'] as const)(
		'%s locally escapes a pause without awaiting a remote acknowledgement',
		async (escapeMethod) => {
			await withUnixSocketPair(async ({ clientSocket, serverSocket }) => {
				// Arrange
				const deadlineScheduler = new ManualPauseDeadlineScheduler();
				const forwardedFrames: GatewayRuntimeClientFrame[] = [];
				const completions: StreamCompletion[] = [];
				const targetCompleted = Promise.withResolvers<void>();
				const readFlow = new GatewayRuntimeSocketReadFlow({
					deadlineScheduler,
					forwardFrame: (frame: GatewayRuntimeClientFrame): void => {
						forwardedFrames.push(frame);
					},
					onStreamCompleted: (completion: StreamCompletion): void => {
						completions.push(completion);
						targetCompleted.resolve();
					},
					pauseDeadlineMilliseconds: PAUSE_DEADLINE_MILLISECONDS,
					socket: clientSocket,
				});
				attachFlowFrameDecoder(clientSocket, (frame) => readFlow.receiveFrame(frame));
				const pause = vi.spyOn(clientSocket, 'pause');
				const resume = vi.spyOn(clientSocket, 'resume');
				readFlow.applyDownstreamPressure(TARGET_STREAM_ID);

				// Act
				readFlow[escapeMethod](TARGET_STREAM_ID);
				await writeTestFlowFrame(
					serverSocket,
					{
						chunk: new Uint8Array([1]),
						kind: 'stream-data',
						streamId: TARGET_STREAM_ID,
					},
					1,
				);
				const targetTerminal = {
					kind: 'authoritative-stream-terminal',
					outcome: 'cancelled',
					streamId: TARGET_STREAM_ID,
				} as const satisfies GatewayRuntimeClientFrame;
				await writeTestFlowFrame(serverSocket, targetTerminal, 2);
				await targetCompleted.promise;

				// Assert
				expect(pause).toHaveBeenCalledTimes(1);
				expect(resume).toHaveBeenCalledTimes(1);
				expect(deadlineScheduler.pendingCount).toBe(0);
				expect(deadlineScheduler.cancelledHandles).toHaveLength(1);
				expect(forwardedFrames).toEqual([targetTerminal]);
				expect(completions).toEqual([{ outcome: 'cancelled', streamId: TARGET_STREAM_ID }]);
			});
		},
	);
});
