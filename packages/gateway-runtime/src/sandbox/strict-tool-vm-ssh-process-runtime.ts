import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
	SandboxOperationControlResult,
	SandboxOperationIdentity,
	SandboxProcessCancelRequest,
	SandboxProcessHandle,
	SandboxProcessLogsRequest,
	SandboxProcessLogsResult,
	SandboxProcessStartResult,
	SandboxProcessStatusRequest,
	SandboxProcessStatusResult,
	SandboxProcessWaitRequest,
	SandboxStreamCloseRequest,
	SandboxStreamCloseResult,
	SandboxStreamHandle,
	SandboxStreamReadRequest,
	SandboxStreamReadResult,
	SandboxStreamWriteRequest,
	SandboxStreamWriteResult,
	SandboxTerminalOutcome,
} from '@agent-vm/agent-portal-sdk';

import type {
	StrictToolVmSshProcessChannel,
	StrictToolVmSshProcessChannelClient,
	StrictToolVmSshProcessTerminalEvent,
	StrictToolVmSshTerminalSize,
} from './strict-tool-vm-ssh-client.js';
import {
	createStrictToolVmSshRetainedOutput,
	type StrictToolVmSshRetainedOutput,
} from './strict-tool-vm-ssh-retained-output.js';

export interface StrictToolVmSshProcessRuntimeScheduler {
	readonly schedule: (
		callback: () => void,
		delayMilliseconds: number,
	) => { readonly cancel: () => void };
}

export interface ResolvedStrictToolVmSshProcessStartRequest {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly maxRuntimeMs: number;
	readonly retainOutputBytes: number;
}

export interface ResolvedStrictToolVmSshShellProcessStartRequest {
	readonly command: string;
	readonly cwd: string;
	readonly environmentVariables?: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly maxRuntimeMs: number;
	readonly retainOutputBytes: number;
	readonly terminalSize?: StrictToolVmSshTerminalSize;
}

export interface StrictToolVmSshProcessRuntimeLimits {
	readonly maximumCursorRecordsPerProcess: number;
	readonly maximumLogChunksPerCall: number;
	readonly maximumOpenMilliseconds: number;
	readonly maximumProcessCount: number;
	readonly maximumReadBytes: number;
	readonly maximumReadChunksPerCall: number;
	readonly maximumRetainedOutputBytesPerProcess: number;
	readonly maximumRuntimeMilliseconds: number;
	readonly maximumTerminalTombstones: number;
	readonly maximumWaitMilliseconds: number;
	readonly maximumWriteBytes: number;
	readonly maximumWriteRecordsPerProcess: number;
	readonly maximumWrittenBytesPerProcess: number;
}

export interface StrictToolVmSshProcessRuntime {
	readonly cancel: (request: SandboxProcessCancelRequest) => SandboxOperationControlResult;
	readonly closeStream: (request: SandboxStreamCloseRequest) => SandboxStreamCloseResult;
	readonly logs: (request: SandboxProcessLogsRequest) => SandboxProcessLogsResult;
	readonly read: (request: SandboxStreamReadRequest) => SandboxStreamReadResult;
	readonly retire: () => Promise<void>;
	readonly start: (
		request: ResolvedStrictToolVmSshProcessStartRequest,
	) => Promise<SandboxProcessStartResult>;
	readonly startShell: (
		request: ResolvedStrictToolVmSshShellProcessStartRequest,
	) => Promise<SandboxProcessStartResult>;
	readonly status: (request: SandboxProcessStatusRequest) => SandboxProcessStatusResult;
	readonly terminalExitCode: (request: SandboxProcessStatusRequest) => number | undefined;
	readonly wait: (request: SandboxProcessWaitRequest) => Promise<SandboxProcessStatusResult>;
	readonly write: (request: SandboxStreamWriteRequest) => Promise<SandboxStreamWriteResult>;
	readonly resizeTerminal: (request: {
		readonly process: SandboxProcessHandle;
		readonly size: StrictToolVmSshTerminalSize;
	}) => void;
}

export class StrictToolVmSshProcessStartError extends Error {
	readonly disposition: 'ambiguous' | 'not-dispatched';

	constructor(options: {
		readonly cause: unknown;
		readonly disposition: 'ambiguous' | 'not-dispatched';
		readonly message: string;
	}) {
		super(options.message, { cause: options.cause });
		this.name = 'StrictToolVmSshProcessStartError';
		this.disposition = options.disposition;
	}
}

interface RetainedWrite {
	readonly bytes: Uint8Array;
	readonly contentDigest: string;
	readonly outcome: 'ambiguous' | 'written';
}

interface TerminalWaiter {
	readonly deadline: { readonly cancel: () => void };
	readonly resolve: (status: SandboxProcessStatusResult) => void;
}

interface ProcessRecord {
	acceptTerminalEvents: boolean;
	readonly abortOpening: AbortController;
	cancelOpening?: () => void;
	channel?: StrictToolVmSshProcessChannel;
	cancellationReason?: 'cancelled' | 'replaced' | 'timed-out';
	inputClosed: boolean;
	nextWriteSequence: number;
	readonly operation: SandboxOperationIdentity;
	readonly output: StrictToolVmSshRetainedOutput;
	readonly process: SandboxProcessHandle;
	readonly retainedWrites: Map<number, RetainedWrite>;
	runtimeDeadline?: { readonly cancel: () => void };
	readonly streams: readonly [SandboxStreamHandle, SandboxStreamHandle, SandboxStreamHandle];
	terminalExitCode?: number;
	terminalOutcome?: SandboxTerminalOutcome;
	totalWrittenBytes: number;
	readonly waiters: Set<TerminalWaiter>;
	writeTail: Promise<void>;
}

interface PreparedProcessStart {
	readonly operation: SandboxOperationIdentity;
	readonly process: SandboxProcessHandle;
	readonly record: ProcessRecord;
	readonly streams: readonly [SandboxStreamHandle, SandboxStreamHandle, SandboxStreamHandle];
}

interface CreateStrictToolVmSshProcessRuntimeOptions {
	readonly createHandleId: (kind: 'cursor' | 'operation' | 'process' | 'stream') => string;
	readonly limits: StrictToolVmSshProcessRuntimeLimits;
	readonly owningGeneration: string;
	readonly scheduler: StrictToolVmSshProcessRuntimeScheduler;
	readonly strictSshClient: StrictToolVmSshProcessChannelClient;
}

const ambiguousOutcome = {
	certainty: 'side-effects-and-termination-unknown',
	kind: 'ambiguous',
	retryClass: 'forbidden',
} as const satisfies SandboxTerminalOutcome;

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer.`);
	}
}

function processStartError(options: {
	readonly cause: unknown;
	readonly disposition: StrictToolVmSshProcessStartError['disposition'];
	readonly message: string;
}): StrictToolVmSshProcessStartError {
	return options.cause instanceof StrictToolVmSshProcessStartError
		? options.cause
		: new StrictToolVmSshProcessStartError({
				...options,
				message: options.cause instanceof Error ? options.cause.message : options.message,
			});
}

function handlesMatch(
	expected: SandboxProcessHandle | SandboxStreamHandle,
	candidate: SandboxProcessHandle | SandboxStreamHandle,
): boolean {
	return (
		expected.handleId === candidate.handleId &&
		expected.kind === candidate.kind &&
		expected.owningGeneration === candidate.owningGeneration &&
		(expected.kind !== 'stream' ||
			(candidate.kind === 'stream' && expected.channel === candidate.channel))
	);
}

function completedOutcome(exitCode: number): SandboxTerminalOutcome {
	return exitCode === 0
		? {
				certainty: 'proven',
				completion: 'succeeded',
				kind: 'completed',
				retryClass: 'forbidden',
			}
		: {
				certainty: 'proven',
				completion: 'failed',
				kind: 'completed',
				retryClass: 'forbidden',
			};
}

function terminalOutcomeFor(
	record: ProcessRecord,
	event: StrictToolVmSshProcessTerminalEvent,
): SandboxTerminalOutcome {
	if (event.kind === 'ambiguous') return ambiguousOutcome;
	if (record.cancellationReason === 'cancelled') {
		return {
			certainty: 'proven-terminated',
			kind: 'cancelled-proven',
			retryClass: 'manual-only',
		};
	}
	if (record.cancellationReason === 'timed-out') {
		return {
			certainty: 'proven-terminated',
			kind: 'timed-out-proven',
			retryClass: 'manual-only',
		};
	}
	if (record.cancellationReason === 'replaced') {
		return {
			certainty: 'proven-terminated',
			kind: 'replaced-proven',
			priorSideEffects: 'possible',
			retryClass: 'manual-only',
		};
	}
	return completedOutcome(event.exitCode);
}

function sha256Digest(bytes: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return Buffer.from(left).equals(Buffer.from(right));
}

function safeRequestCancellation(channel: StrictToolVmSshProcessChannel): boolean {
	try {
		channel.requestCancellation();
		return true;
	} catch {
		return false;
	}
}

function safeEndInput(channel: StrictToolVmSshProcessChannel): boolean {
	try {
		channel.endInput();
		return true;
	} catch {
		return false;
	}
}

function safeCancelDeadline(deadline: { readonly cancel: () => void } | undefined): void {
	try {
		deadline?.cancel();
	} catch {
		// A cleanup callback must not prevent state invalidation or terminal settlement.
	}
}

function currentTerminalOutcome(record: ProcessRecord): SandboxTerminalOutcome | undefined {
	return record.terminalOutcome;
}

function statusFor(record: ProcessRecord): SandboxProcessStatusResult {
	return record.terminalOutcome === undefined
		? { kind: 'running', operation: record.operation, process: record.process }
		: {
				kind: 'terminal',
				operation: record.operation,
				outcome: record.terminalOutcome,
				process: record.process,
			};
}

export function createStrictToolVmSshProcessRuntime(
	options: CreateStrictToolVmSshProcessRuntimeOptions,
): StrictToolVmSshProcessRuntime {
	for (const [name, value] of Object.entries(options.limits)) {
		requirePositiveSafeInteger(value, name);
	}
	if (options.limits.maximumLogChunksPerCall > 1_000) {
		throw new Error('Maximum process log chunks per call must not exceed 1000.');
	}
	if (options.limits.maximumReadChunksPerCall !== 1) {
		throw new Error('Canonical process stream reads return exactly one bounded chunk.');
	}
	if (options.owningGeneration.length === 0) {
		throw new Error('Process runtime owning generation must not be empty.');
	}

	const recordsByProcessHandle = new Map<string, ProcessRecord>();
	const recordsByStreamHandle = new Map<string, ProcessRecord>();
	const operationIdentifiers = new Set<string>();
	const terminalProcessHandleOrder: string[] = [];
	let retired = false;
	let retirementPromise: Promise<void> | undefined;

	const requireActive = (): void => {
		if (retired) throw new Error('Strict SSH process runtime is retired.');
	};
	const isCurrentRecord = (record: ProcessRecord): boolean =>
		recordsByProcessHandle.get(record.process.handleId) === record;
	const removeRecord = (record: ProcessRecord): void => {
		if (recordsByProcessHandle.get(record.process.handleId) === record) {
			recordsByProcessHandle.delete(record.process.handleId);
		}
		for (const stream of record.streams) {
			if (recordsByStreamHandle.get(stream.handleId) === record) {
				recordsByStreamHandle.delete(stream.handleId);
			}
		}
		operationIdentifiers.delete(record.operation.operationId);
		record.acceptTerminalEvents = false;
		record.abortOpening.abort();
		safeCancelDeadline(record.runtimeDeadline);
	};
	const evictOldestTerminalRecord = (): boolean => {
		while (terminalProcessHandleOrder.length > 0) {
			const processHandleId = terminalProcessHandleOrder.shift();
			if (processHandleId === undefined) return false;
			const record = recordsByProcessHandle.get(processHandleId);
			if (record === undefined || record.terminalOutcome === undefined) continue;
			removeRecord(record);
			return true;
		}
		return false;
	};
	const enforceTerminalTombstoneLimit = (): void => {
		while (
			terminalProcessHandleOrder.length > options.limits.maximumTerminalTombstones &&
			evictOldestTerminalRecord()
		) {
			// Continue until the retained terminal history is within the configured cap.
		}
	};
	const requireProcess = (process: SandboxProcessHandle): ProcessRecord => {
		requireActive();
		const record = recordsByProcessHandle.get(process.handleId);
		if (record === undefined || !handlesMatch(record.process, process)) {
			throw new Error('Strict SSH process handle is forged, stale, or unavailable.');
		}
		return record;
	};
	const requireStream = (stream: SandboxStreamHandle): ProcessRecord => {
		requireActive();
		const record = recordsByStreamHandle.get(stream.handleId);
		if (
			record === undefined ||
			!record.streams.some((candidate) => handlesMatch(candidate, stream))
		) {
			throw new Error('Strict SSH stream handle is forged, stale, or unavailable.');
		}
		return record;
	};
	const settleWaiters = (record: ProcessRecord): void => {
		const status = statusFor(record);
		for (const waiter of record.waiters) {
			safeCancelDeadline(waiter.deadline);
			waiter.resolve(status);
		}
		record.waiters.clear();
	};
	const finishTerminal = (
		record: ProcessRecord,
		event: StrictToolVmSshProcessTerminalEvent,
	): void => {
		if (!record.acceptTerminalEvents || record.terminalOutcome !== undefined) return;
		record.terminalOutcome = terminalOutcomeFor(record, event);
		if (event.kind === 'exited' && record.terminalOutcome.kind === 'completed') {
			record.terminalExitCode = event.exitCode;
		}
		safeCancelDeadline(record.runtimeDeadline);
		terminalProcessHandleOrder.push(record.process.handleId);
		settleWaiters(record);
		enforceTerminalTombstoneLimit();
	};
	const finishAmbiguous = (record: ProcessRecord): void => {
		finishTerminal(record, { kind: 'ambiguous' });
	};
	const requestCancellation = (
		record: ProcessRecord,
		reason: 'cancelled' | 'replaced' | 'timed-out',
	): 'accepted' | 'ambiguous' | 'pending' => {
		if (record.terminalOutcome !== undefined || record.cancellationReason !== undefined) {
			return 'pending';
		}
		record.cancellationReason = reason;
		record.abortOpening.abort();
		if (record.channel !== undefined && !safeRequestCancellation(record.channel)) {
			finishAmbiguous(record);
			return currentTerminalOutcome(record)?.kind === 'ambiguous' ? 'ambiguous' : 'accepted';
		}
		return currentTerminalOutcome(record)?.kind === 'ambiguous' ? 'ambiguous' : 'accepted';
	};

	const startProcess = async (
		request: {
			readonly maxRuntimeMs: number;
			readonly retainOutputBytes: number;
		},
		openChannel: (callbacks: {
			readonly onStderr: (bytes: Uint8Array) => void;
			readonly onStdout: (bytes: Uint8Array) => void;
			readonly onTerminal: (event: StrictToolVmSshProcessTerminalEvent) => void;
			readonly signal: AbortSignal;
		}) => Promise<StrictToolVmSshProcessChannel>,
	): Promise<SandboxProcessStartResult> => {
		try {
			requireActive();
			requirePositiveSafeInteger(request.maxRuntimeMs, 'Process max runtime');
			requirePositiveSafeInteger(request.retainOutputBytes, 'Process retained output bytes');
			if (request.maxRuntimeMs > options.limits.maximumRuntimeMilliseconds) {
				throw new Error('Process max runtime limit exceeded.');
			}
			if (request.retainOutputBytes > options.limits.maximumRetainedOutputBytesPerProcess) {
				throw new Error('Process retained output byte limit exceeded.');
			}
			while (recordsByProcessHandle.size >= options.limits.maximumProcessCount) {
				if (!evictOldestTerminalRecord()) {
					throw new Error('Strict SSH process count limit exceeded.');
				}
			}
		} catch (error: unknown) {
			throw processStartError({
				cause: error,
				disposition: 'not-dispatched',
				message: 'Strict SSH process start failed before dispatch.',
			});
		}
		let prepared: PreparedProcessStart;
		try {
			const operation: SandboxOperationIdentity = {
				operationId: options.createHandleId('operation'),
				owningGeneration: options.owningGeneration,
			};
			const process: SandboxProcessHandle = {
				handleId: options.createHandleId('process'),
				kind: 'process',
				owningGeneration: options.owningGeneration,
			};
			const streams = [
				{
					channel: 'stdin',
					handleId: options.createHandleId('stream'),
					kind: 'stream',
					owningGeneration: options.owningGeneration,
				},
				{
					channel: 'stdout',
					handleId: options.createHandleId('stream'),
					kind: 'stream',
					owningGeneration: options.owningGeneration,
				},
				{
					channel: 'stderr',
					handleId: options.createHandleId('stream'),
					kind: 'stream',
					owningGeneration: options.owningGeneration,
				},
			] as const satisfies readonly SandboxStreamHandle[];
			const identifiers = [
				operation.operationId,
				process.handleId,
				...streams.map((stream) => stream.handleId),
			];
			if (
				identifiers.some((identifier) => identifier.length === 0) ||
				new Set(identifiers).size !== identifiers.length ||
				operationIdentifiers.has(operation.operationId) ||
				recordsByProcessHandle.has(process.handleId) ||
				streams.some((stream) => recordsByStreamHandle.has(stream.handleId))
			) {
				throw new Error('Strict SSH process handle identifier collided or was empty.');
			}
			const record: ProcessRecord = {
				acceptTerminalEvents: true,
				abortOpening: new AbortController(),
				inputClosed: false,
				nextWriteSequence: 0,
				operation,
				output: createStrictToolVmSshRetainedOutput({
					createCursorId: () => options.createHandleId('cursor'),
					maximumCursorRecords: options.limits.maximumCursorRecordsPerProcess,
					maximumLogChunksPerCall: options.limits.maximumLogChunksPerCall,
					maximumReadBytes: options.limits.maximumReadBytes,
					maximumRetainedBytes: request.retainOutputBytes,
				}),
				process,
				retainedWrites: new Map(),
				streams,
				totalWrittenBytes: 0,
				waiters: new Set(),
				writeTail: Promise.resolve(),
			};
			recordsByProcessHandle.set(process.handleId, record);
			operationIdentifiers.add(operation.operationId);
			for (const stream of streams) recordsByStreamHandle.set(stream.handleId, record);
			prepared = { operation, process, record, streams };
		} catch (error: unknown) {
			throw processStartError({
				cause: error,
				disposition: 'not-dispatched',
				message: 'Strict SSH process start failed before dispatch.',
			});
		}
		const { operation, process, record, streams } = prepared;

		let openSettled = false;
		let channelPromise: Promise<StrictToolVmSshProcessChannel>;
		try {
			channelPromise = openChannel({
				onStderr: (bytes) => {
					try {
						if (!retired && isCurrentRecord(record) && record.terminalOutcome === undefined) {
							record.output.append('stderr', bytes);
						}
					} catch {
						finishAmbiguous(record);
					}
				},
				onStdout: (bytes) => {
					try {
						if (!retired && isCurrentRecord(record) && record.terminalOutcome === undefined) {
							record.output.append('stdout', bytes);
						}
					} catch {
						finishAmbiguous(record);
					}
				},
				onTerminal: (event) => {
					try {
						finishTerminal(record, event);
					} catch {
						finishAmbiguous(record);
					}
				},
				signal: record.abortOpening.signal,
			});
		} catch (error: unknown) {
			removeRecord(record);
			throw processStartError({
				cause: error,
				disposition: 'ambiguous',
				message: 'Strict SSH process open may have dispatched.',
			});
		}
		let openDeadline: { readonly cancel: () => void } | undefined;
		const boundedOpen = new Promise<StrictToolVmSshProcessChannel>((resolve, reject) => {
			record.cancelOpening = (): void => {
				if (openSettled) return;
				openSettled = true;
				record.abortOpening.abort();
				reject(new Error('Strict SSH process open was cancelled.'));
			};
			try {
				openDeadline = options.scheduler.schedule(() => {
					if (openSettled) return;
					openSettled = true;
					record.abortOpening.abort();
					reject(new Error('Strict SSH process open deadline expired.'));
				}, options.limits.maximumOpenMilliseconds);
			} catch (error: unknown) {
				openSettled = true;
				record.abortOpening.abort();
				reject(error instanceof Error ? error : new Error('Process open scheduler failed.'));
			}
			void channelPromise.then(
				(channel) => {
					if (openSettled || retired || !isCurrentRecord(record)) {
						safeRequestCancellation(channel);
						return;
					}
					openSettled = true;
					safeCancelDeadline(openDeadline);
					resolve(channel);
				},
				(error: unknown) => {
					if (openSettled) return;
					openSettled = true;
					safeCancelDeadline(openDeadline);
					reject(error instanceof Error ? error : new Error('Strict SSH process open failed.'));
				},
			);
		});
		try {
			const channel = await boundedOpen;
			if (retired || !isCurrentRecord(record)) {
				safeRequestCancellation(channel);
				throw new Error('Strict SSH process runtime retired during process open.');
			}
			record.channel = channel;
			if (record.terminalOutcome === undefined) {
				record.runtimeDeadline = options.scheduler.schedule(() => {
					try {
						requestCancellation(record, 'timed-out');
					} catch {
						finishAmbiguous(record);
					}
				}, request.maxRuntimeMs);
			}
		} catch (error: unknown) {
			safeCancelDeadline(openDeadline);
			removeRecord(record);
			throw processStartError({
				cause: error,
				disposition: 'ambiguous',
				message: 'Strict SSH process open may have dispatched.',
			});
		}
		return { kind: 'started', operation, process, streams: [...streams] };
	};
	const start: StrictToolVmSshProcessRuntime['start'] = async (request) =>
		await startProcess(request, (callbacks) =>
			options.strictSshClient.openProcessChannel({
				argv: request.argv,
				cwd: request.cwd,
				...callbacks,
			}),
		);
	const startShell: StrictToolVmSshProcessRuntime['startShell'] = async (request) =>
		await startProcess(request, (callbacks) =>
			options.strictSshClient.openShellProcessChannel({
				command: request.command,
				cwd: request.cwd,
				...(request.environmentVariables === undefined
					? {}
					: { environmentVariables: request.environmentVariables }),
				...callbacks,
				...(request.terminalSize === undefined ? {} : { terminalSize: request.terminalSize }),
			}),
		);

	const status: StrictToolVmSshProcessRuntime['status'] = ({ process }) =>
		statusFor(requireProcess(process));
	const terminalExitCode: StrictToolVmSshProcessRuntime['terminalExitCode'] = ({ process }) => {
		const record = requireProcess(process);
		return record.terminalOutcome?.kind === 'completed' ? record.terminalExitCode : undefined;
	};
	const logs: StrictToolVmSshProcessRuntime['logs'] = (request) => {
		const record = requireProcess(request.process);
		requirePositiveSafeInteger(request.maxBytes, 'Process log byte limit');
		return record.output.logs(request, record.process, record.terminalOutcome !== undefined);
	};
	const read: StrictToolVmSshProcessRuntime['read'] = (request) => {
		const record = requireStream(request.stream);
		requirePositiveSafeInteger(request.maxBytes, 'Process stream read byte limit');
		return record.output.read(request, request.stream, record.terminalOutcome !== undefined);
	};
	const write: StrictToolVmSshProcessRuntime['write'] = (request) => {
		const record = requireStream(request.stream);
		const stdinStream = record.streams[0];
		if (!handlesMatch(stdinStream, request.stream)) {
			return Promise.reject(new Error('Only the process stdin stream accepts writes.'));
		}
		const bytes = Buffer.from(request.content.contentBase64, 'base64');
		const performWrite = async (): Promise<SandboxStreamWriteResult> => {
			if (retired || !isCurrentRecord(record)) {
				throw new Error('Strict SSH process runtime is retired or the stream is stale.');
			}
			if (record.inputClosed || record.terminalOutcome !== undefined) {
				throw new Error('Process stdin stream is closed.');
			}
			if (
				request.content.byteLength !== bytes.byteLength ||
				Buffer.from(bytes).toString('base64') !== request.content.contentBase64
			) {
				throw new Error('Process write content is not canonical base64 with the declared length.');
			}
			if (bytes.byteLength > options.limits.maximumWriteBytes) {
				throw new Error('Process write byte limit exceeded.');
			}
			if (sha256Digest(bytes) !== request.contentDigest) {
				throw new Error('Process write content digest does not match.');
			}
			const retainedWrite = record.retainedWrites.get(request.sequence);
			if (retainedWrite !== undefined) {
				if (
					retainedWrite.contentDigest !== request.contentDigest ||
					!bytesEqual(retainedWrite.bytes, bytes)
				) {
					throw new Error('Process write sequence was reused with different content.');
				}
				if (retainedWrite.outcome === 'ambiguous') {
					throw new Error('Process write outcome is ambiguous and retry is forbidden.');
				}
				return { kind: 'already-written', sequence: request.sequence, stream: stdinStream };
			}
			if (request.sequence !== record.nextWriteSequence) {
				throw new Error('Process write sequence is not the next expected sequence.');
			}
			if (record.retainedWrites.size >= options.limits.maximumWriteRecordsPerProcess) {
				throw new Error('Process write record limit exceeded.');
			}
			if (
				record.totalWrittenBytes + bytes.byteLength >
				options.limits.maximumWrittenBytesPerProcess
			) {
				throw new Error('Per-process written byte limit exceeded.');
			}
			if (record.channel === undefined) throw new Error('Process channel is not ready.');
			try {
				await record.channel.write(bytes);
			} catch {
				record.retainedWrites.set(request.sequence, {
					bytes: bytes.slice(),
					contentDigest: request.contentDigest,
					outcome: 'ambiguous',
				});
				throw new Error('Process write outcome is ambiguous and retry is forbidden.');
			}
			record.retainedWrites.set(request.sequence, {
				bytes: bytes.slice(),
				contentDigest: request.contentDigest,
				outcome: 'written',
			});
			record.nextWriteSequence += 1;
			record.totalWrittenBytes += bytes.byteLength;
			return {
				bytesWritten: bytes.byteLength,
				kind: 'written',
				sequence: request.sequence,
				stream: stdinStream,
			};
		};
		const result = record.writeTail.then(performWrite, performWrite);
		record.writeTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const closeStream: StrictToolVmSshProcessRuntime['closeStream'] = ({ stream }) => {
		const record = requireStream(stream);
		const stdinStream = record.streams[0];
		if (!handlesMatch(stdinStream, stream)) {
			throw new Error('Only the process stdin stream can be closed.');
		}
		if (record.inputClosed) return { kind: 'already-closed', stream: stdinStream };
		record.inputClosed = true;
		if (record.channel !== undefined && !safeEndInput(record.channel)) {
			finishAmbiguous(record);
			throw new Error('Process input close outcome is ambiguous.');
		}
		return { kind: 'closed', stream: stdinStream };
	};
	const resizeTerminal: StrictToolVmSshProcessRuntime['resizeTerminal'] = ({ process, size }) => {
		const record = requireProcess(process);
		if (record.channel === undefined) throw new Error('Process terminal channel is not ready.');
		record.channel.resizeTerminal(size);
	};
	const cancel: StrictToolVmSshProcessRuntime['cancel'] = ({ process }) => {
		const record = requireProcess(process);
		if (record.terminalOutcome !== undefined) {
			return {
				kind: 'already-terminal',
				operation: record.operation,
				outcome: record.terminalOutcome,
			};
		}
		if (record.cancellationReason !== undefined) {
			return { kind: 'cancellation-pending', operation: record.operation };
		}
		const result = requestCancellation(record, 'cancelled');
		const outcome = currentTerminalOutcome(record);
		if (outcome?.kind === 'ambiguous' || result === 'ambiguous') {
			return { kind: 'ambiguous', operation: record.operation, outcome: ambiguousOutcome };
		}
		if (outcome?.certainty === 'proven-terminated') {
			return {
				kind: 'termination-proven',
				operation: record.operation,
				outcome,
			};
		}
		if (outcome !== undefined) {
			return { kind: 'already-terminal', operation: record.operation, outcome };
		}
		return { kind: 'cancel-request-accepted', operation: record.operation };
	};
	const wait: StrictToolVmSshProcessRuntime['wait'] = ({ process, timeoutMs }) => {
		const record = requireProcess(process);
		requirePositiveSafeInteger(timeoutMs, 'Process wait deadline');
		if (timeoutMs > options.limits.maximumWaitMilliseconds) {
			throw new Error('Process wait deadline limit exceeded.');
		}
		if (record.terminalOutcome !== undefined) return Promise.resolve(statusFor(record));
		return new Promise<SandboxProcessStatusResult>((resolve) => {
			const waiterState: { waiter?: TerminalWaiter } = {};
			let expiredSynchronously = false;
			const deadline = options.scheduler.schedule(() => {
				if (waiterState.waiter === undefined) expiredSynchronously = true;
				else record.waiters.delete(waiterState.waiter);
				resolve(statusFor(record));
			}, timeoutMs);
			waiterState.waiter = { deadline, resolve };
			if (!expiredSynchronously) record.waiters.add(waiterState.waiter);
		});
	};
	const retire: StrictToolVmSshProcessRuntime['retire'] = () => {
		if (retirementPromise !== undefined) return retirementPromise;
		retired = true;
		const records = [...recordsByProcessHandle.values()];
		recordsByProcessHandle.clear();
		recordsByStreamHandle.clear();
		operationIdentifiers.clear();
		terminalProcessHandleOrder.length = 0;
		for (const record of records) {
			record.cancelOpening?.();
			safeCancelDeadline(record.runtimeDeadline);
			record.cancellationReason ??= 'replaced';
			if (record.terminalOutcome === undefined && record.channel !== undefined) {
				safeRequestCancellation(record.channel);
			}
			record.terminalOutcome ??= ambiguousOutcome;
			record.acceptTerminalEvents = false;
			settleWaiters(record);
		}
		retirementPromise = Promise.resolve();
		return retirementPromise;
	};

	return {
		cancel,
		closeStream,
		logs,
		read,
		resizeTerminal,
		retire,
		start,
		startShell,
		status,
		terminalExitCode,
		wait,
		write,
	};
}
