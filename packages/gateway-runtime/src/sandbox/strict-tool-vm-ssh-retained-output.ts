import { Buffer } from 'node:buffer';

import type {
	SandboxProcessHandle,
	SandboxProcessLogsRequest,
	SandboxProcessLogsResult,
	SandboxStreamHandle,
	SandboxStreamReadRequest,
	SandboxStreamReadResult,
} from '@agent-vm/agent-portal-sdk';

interface RetainedLogChunk {
	bytes: Uint8Array;
	readonly channel: 'stderr' | 'stdout';
	readonly logIndex: number;
	readonly sequence: number;
	sourceByteOffset: number;
}

type RetainedCursor =
	| {
			readonly byteOffset: number;
			readonly channelKey: string;
			readonly kind: 'logs';
			readonly logIndex: number;
	  }
	| {
			readonly byteOffset: number;
			readonly kind: 'read';
			readonly logIndex: number;
			readonly streamHandleId: string;
	  };

export interface StrictToolVmSshRetainedOutput {
	readonly append: (channel: 'stderr' | 'stdout', incomingBytes: Uint8Array) => void;
	readonly logs: (
		request: SandboxProcessLogsRequest,
		process: SandboxProcessHandle,
		terminal: boolean,
	) => SandboxProcessLogsResult;
	readonly read: (
		request: SandboxStreamReadRequest,
		stream: SandboxStreamHandle,
		terminal: boolean,
	) => SandboxStreamReadResult;
}

export function createStrictToolVmSshRetainedOutput(options: {
	readonly createCursorId: () => string;
	readonly maximumCursorRecords: number;
	readonly maximumLogChunksPerCall: number;
	readonly maximumReadBytes: number;
	readonly maximumRetainedBytes: number;
}): StrictToolVmSshRetainedOutput {
	const cursors = new Map<string, RetainedCursor>();
	let discardedOutput = false;
	let nextLogIndex = 0;
	let nextStderrSequence = 0;
	let nextStdoutSequence = 0;
	let retainedLogBytes = 0;
	const retainedLogs: RetainedLogChunk[] = [];

	const createCursor = (cursor: RetainedCursor): string => {
		while (cursors.size >= options.maximumCursorRecords) {
			const oldestCursorId = cursors.keys().next().value;
			if (oldestCursorId === undefined) break;
			cursors.delete(oldestCursorId);
		}
		const cursorId = options.createCursorId();
		if (cursors.has(cursorId)) throw new Error('Process cursor identifier collided.');
		cursors.set(cursorId, cursor);
		return cursorId;
	};
	const initialCursorPosition = (): {
		readonly byteOffset: number;
		readonly logIndex: number;
	} => ({
		byteOffset: retainedLogs[0]?.sourceByteOffset ?? 0,
		logIndex: retainedLogs[0]?.logIndex ?? nextLogIndex,
	});
	const requireCursorPosition = (cursor: RetainedCursor): void => {
		const earliest = retainedLogs[0];
		if (
			earliest !== undefined &&
			(cursor.logIndex < earliest.logIndex ||
				(cursor.logIndex === earliest.logIndex && cursor.byteOffset < earliest.sourceByteOffset))
		) {
			throw new Error('Process output cursor is stale after retained output eviction.');
		}
	};
	const hasOutputAfter = (
		channels: readonly ('stderr' | 'stdout')[],
		logIndex: number,
		byteOffset: number,
	): boolean =>
		retainedLogs.some(
			(candidate) =>
				channels.includes(candidate.channel) &&
				(candidate.logIndex > logIndex ||
					(candidate.logIndex === logIndex &&
						byteOffset < candidate.sourceByteOffset + candidate.bytes.byteLength)),
		);
	const append = (channel: 'stderr' | 'stdout', incomingBytes: Uint8Array): void => {
		if (incomingBytes.byteLength === 0) return;
		const bytes = incomingBytes.slice();
		const sequence = channel === 'stdout' ? nextStdoutSequence++ : nextStderrSequence++;
		retainedLogs.push({
			bytes,
			channel,
			logIndex: nextLogIndex++,
			sequence,
			sourceByteOffset: 0,
		});
		retainedLogBytes += bytes.byteLength;
		while (retainedLogBytes > options.maximumRetainedBytes) {
			const earliest = retainedLogs[0];
			if (earliest === undefined) break;
			const excessBytes = retainedLogBytes - options.maximumRetainedBytes;
			if (earliest.bytes.byteLength <= excessBytes) {
				retainedLogs.shift();
				retainedLogBytes -= earliest.bytes.byteLength;
			} else {
				earliest.bytes = earliest.bytes.slice(excessBytes);
				earliest.sourceByteOffset += excessBytes;
				retainedLogBytes -= excessBytes;
			}
			discardedOutput = true;
		}
	};
	const logs: StrictToolVmSshRetainedOutput['logs'] = (request, process, terminal) => {
		if (request.maxBytes > options.maximumRetainedBytes) {
			throw new Error('Process log byte limit exceeded.');
		}
		const channels = [...new Set(request.channels)].toSorted();
		if (
			channels.length === 0 ||
			channels.some((channel) => channel === 'stdin' || channel === 'pty')
		) {
			throw new Error('Process logs require stdout or stderr channels.');
		}
		const outputChannels = channels.filter(
			(channel): channel is 'stderr' | 'stdout' => channel === 'stderr' || channel === 'stdout',
		);
		const channelKey = outputChannels.join(',');
		let cursor: Extract<RetainedCursor, { readonly kind: 'logs' }> = {
			...initialCursorPosition(),
			channelKey,
			kind: 'logs',
		};
		if (request.cursor !== undefined) {
			const retainedCursor = cursors.get(request.cursor);
			if (
				retainedCursor === undefined ||
				retainedCursor.kind !== 'logs' ||
				retainedCursor.channelKey !== channelKey
			) {
				throw new Error('Process log cursor is forged, stale, or channel-mismatched.');
			}
			cursor = retainedCursor;
		}
		requireCursorPosition(cursor);
		const chunks: SandboxProcessLogsResult['chunks'][number][] = [];
		let remainingBytes = request.maxBytes;
		let nextCursorLogIndex = cursor.logIndex;
		let nextCursorByteOffset = cursor.byteOffset;
		for (const retainedLog of retainedLogs) {
			if (retainedLog.logIndex < nextCursorLogIndex) continue;
			if (!outputChannels.includes(retainedLog.channel)) {
				nextCursorLogIndex = retainedLog.logIndex + 1;
				nextCursorByteOffset = 0;
				continue;
			}
			const offset =
				retainedLog.logIndex === nextCursorLogIndex
					? Math.max(nextCursorByteOffset, retainedLog.sourceByteOffset)
					: retainedLog.sourceByteOffset;
			const available = retainedLog.bytes.subarray(offset - retainedLog.sourceByteOffset);
			const selected = available.subarray(0, remainingBytes);
			if (selected.byteLength > 0) {
				chunks.push({
					channel: retainedLog.channel,
					chunk: {
						byteLength: selected.byteLength,
						contentBase64: Buffer.from(selected).toString('base64'),
						encoding: 'base64',
					},
					sequence: retainedLog.sequence,
				});
				remainingBytes -= selected.byteLength;
			}
			if (
				selected.byteLength < available.byteLength ||
				chunks.length >= options.maximumLogChunksPerCall
			) {
				nextCursorLogIndex = retainedLog.logIndex;
				nextCursorByteOffset = offset + selected.byteLength;
				break;
			}
			nextCursorLogIndex = retainedLog.logIndex + 1;
			nextCursorByteOffset = 0;
			if (remainingBytes === 0) break;
		}
		const hasRemainingOutput = hasOutputAfter(
			outputChannels,
			nextCursorLogIndex,
			nextCursorByteOffset,
		);
		const exhausted = terminal && !hasRemainingOutput;
		return {
			chunks,
			kind: 'logs',
			nextCursor: exhausted
				? undefined
				: createCursor({
						byteOffset: nextCursorByteOffset,
						channelKey,
						kind: 'logs',
						logIndex: nextCursorLogIndex,
					}),
			process,
			truncated: discardedOutput || hasRemainingOutput,
		};
	};
	const read: StrictToolVmSshRetainedOutput['read'] = (request, stream, terminal) => {
		if (request.maxBytes > options.maximumReadBytes) {
			throw new Error('Process stream read byte limit exceeded.');
		}
		if (stream.channel !== 'stdout' && stream.channel !== 'stderr') {
			throw new Error('Only stdout or stderr process streams can be read.');
		}
		let cursor: Extract<RetainedCursor, { readonly kind: 'read' }> = {
			...initialCursorPosition(),
			kind: 'read',
			streamHandleId: stream.handleId,
		};
		if (request.cursor !== undefined) {
			const retainedCursor = cursors.get(request.cursor);
			if (
				retainedCursor === undefined ||
				retainedCursor.kind !== 'read' ||
				retainedCursor.streamHandleId !== stream.handleId
			) {
				throw new Error('Process read cursor is forged, stale, or channel-mismatched.');
			}
			cursor = retainedCursor;
		}
		requireCursorPosition(cursor);
		const retainedLog = retainedLogs.find(
			(candidate) => candidate.channel === stream.channel && candidate.logIndex >= cursor.logIndex,
		);
		let selected = Buffer.alloc(0);
		let sequence = stream.channel === 'stdout' ? nextStdoutSequence : nextStderrSequence;
		let nextCursorLogIndex = cursor.logIndex;
		let nextCursorByteOffset = cursor.byteOffset;
		if (retainedLog !== undefined) {
			const offset =
				retainedLog.logIndex === cursor.logIndex
					? Math.max(cursor.byteOffset, retainedLog.sourceByteOffset)
					: retainedLog.sourceByteOffset;
			const available = retainedLog.bytes.subarray(offset - retainedLog.sourceByteOffset);
			selected = Buffer.from(available.subarray(0, request.maxBytes));
			sequence = retainedLog.sequence;
			if (selected.byteLength < available.byteLength) {
				nextCursorLogIndex = retainedLog.logIndex;
				nextCursorByteOffset = offset + selected.byteLength;
			} else {
				nextCursorLogIndex = retainedLog.logIndex + 1;
				nextCursorByteOffset = 0;
			}
		}
		const hasRemainingOutput = hasOutputAfter(
			[stream.channel],
			nextCursorLogIndex,
			nextCursorByteOffset,
		);
		const eof = terminal && !hasRemainingOutput;
		return {
			chunk: {
				byteLength: selected.byteLength,
				contentBase64: selected.toString('base64'),
				encoding: 'base64',
			},
			eof,
			kind: 'read',
			nextCursor: eof
				? undefined
				: createCursor({
						byteOffset: nextCursorByteOffset,
						kind: 'read',
						logIndex: nextCursorLogIndex,
						streamHandleId: stream.handleId,
					}),
			sequence,
			stream,
		};
	};

	return { append, logs, read };
}
