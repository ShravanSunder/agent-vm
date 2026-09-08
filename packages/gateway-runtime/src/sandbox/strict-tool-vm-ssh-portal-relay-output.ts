import { Buffer } from 'node:buffer';

import type {
	SandboxStreamHandle,
	SandboxStreamReadRequest,
	SandboxStreamReadResult,
} from '@agent-vm/agent-portal-sdk';

import type { StrictToolVmSshProcessRuntimeScheduler } from './strict-tool-vm-ssh-process-runtime.js';

export const PORTAL_RELAY_STREAM_CHUNK_BYTES = 64 * 1_024;
export const PORTAL_RELAY_OUTPUT_RESUME_BYTES = 1 * 1_024 * 1_024;
export const PORTAL_RELAY_OUTPUT_PAUSE_BYTES = 3 * 1_024 * 1_024;
export const PORTAL_RELAY_OUTPUT_HARD_CAP_BYTES = 4 * 1_024 * 1_024;
export const PORTAL_RELAY_TOTAL_TRANSFER_BYTES = 64 * 1_024 * 1_024;

interface RelayOutputChunk {
	bytes: Uint8Array;
	readonly sequence: number;
}

interface OfferedRead {
	readonly consumedBytes: number;
	readonly inputCursor: string | undefined;
	readonly result: SandboxStreamReadResult;
}

interface PendingRead {
	readonly cancelDeadline: () => void;
	readonly reject: (error: Error) => void;
	readonly request: SandboxStreamReadRequest;
	readonly resolve: (result: SandboxStreamReadResult) => void;
}

interface RelayOutputChannelState {
	acknowledgedCursor: string | undefined;
	bufferedBytes: number;
	readonly chunks: RelayOutputChunk[];
	nextSequence: number;
	offered: OfferedRead | undefined;
	paused: boolean;
	pendingRead: PendingRead | undefined;
}

export interface StrictToolVmSshPortalRelayOutput {
	readonly append: (channel: 'stderr' | 'stdout', bytes: Uint8Array) => void;
	readonly failPendingReads: (error: Error) => void;
	readonly finish: () => void;
	readonly read: (request: SandboxStreamReadRequest) => Promise<SandboxStreamReadResult>;
}

function createRelayOutputChannelState(): RelayOutputChannelState {
	return {
		acknowledgedCursor: undefined,
		bufferedBytes: 0,
		chunks: [],
		nextSequence: 0,
		offered: undefined,
		paused: false,
		pendingRead: undefined,
	};
}

export function createStrictToolVmSshPortalRelayOutput(options: {
	readonly createCursorId: () => string;
	readonly pauseOutput: (channel: 'stderr' | 'stdout') => void;
	readonly resumeOutput: (channel: 'stderr' | 'stdout') => void;
	readonly scheduler: StrictToolVmSshProcessRuntimeScheduler;
}): StrictToolVmSshPortalRelayOutput {
	const states = {
		stderr: createRelayOutputChannelState(),
		stdout: createRelayOutputChannelState(),
	};
	let terminal = false;
	let bufferedOutputBytes = 0;
	let totalOutputBytes = 0;

	function stateFor(stream: SandboxStreamHandle): {
		readonly channel: 'stderr' | 'stdout';
		readonly state: RelayOutputChannelState;
	} {
		if (stream.channel !== 'stdout' && stream.channel !== 'stderr') {
			throw new Error('Only stdout or stderr process streams can be read.');
		}
		return { channel: stream.channel, state: states[stream.channel] };
	}

	function consumeOffered(
		channel: 'stderr' | 'stdout',
		state: RelayOutputChannelState,
		offered: OfferedRead,
	): void {
		let remaining = offered.consumedBytes;
		while (remaining > 0) {
			const chunk = state.chunks[0];
			if (chunk === undefined) throw new Error('Portal relay output accounting is inconsistent.');
			if (remaining >= chunk.bytes.byteLength) {
				remaining -= chunk.bytes.byteLength;
				state.bufferedBytes -= chunk.bytes.byteLength;
				bufferedOutputBytes -= chunk.bytes.byteLength;
				state.chunks.shift();
			} else {
				chunk.bytes = chunk.bytes.slice(remaining);
				state.bufferedBytes -= remaining;
				bufferedOutputBytes -= remaining;
				remaining = 0;
			}
		}
		if (state.paused && state.bufferedBytes < PORTAL_RELAY_OUTPUT_RESUME_BYTES) {
			state.paused = false;
			options.resumeOutput(channel);
		}
	}

	function immediateRead(
		request: SandboxStreamReadRequest,
		channel: 'stderr' | 'stdout',
		state: RelayOutputChannelState,
	): SandboxStreamReadResult | undefined {
		if (request.maxBytes > PORTAL_RELAY_STREAM_CHUNK_BYTES) {
			throw new Error('Portal relay stream read byte limit exceeded.');
		}
		if (state.offered !== undefined) {
			if (request.cursor === state.offered.inputCursor) return state.offered.result;
			if (request.cursor !== state.offered.result.nextCursor) {
				throw new Error('Portal relay read cursor is forged, stale, or concurrent.');
			}
			consumeOffered(channel, state, state.offered);
			state.acknowledgedCursor = request.cursor;
			state.offered = undefined;
		} else if (request.cursor !== state.acknowledgedCursor) {
			throw new Error('Portal relay read cursor is forged, stale, or concurrent.');
		}

		const firstChunk = state.chunks[0];
		if (firstChunk === undefined) {
			if (!terminal) return undefined;
			return {
				chunk: { byteLength: 0, contentBase64: '', encoding: 'base64' },
				eof: true,
				kind: 'read',
				sequence: state.nextSequence,
				stream: request.stream,
			};
		}
		const selected = Buffer.from(firstChunk.bytes.subarray(0, request.maxBytes));
		const nextCursor = options.createCursorId();
		const result = {
			chunk: {
				byteLength: selected.byteLength,
				contentBase64: selected.toString('base64'),
				encoding: 'base64' as const,
			},
			eof: false,
			kind: 'read' as const,
			nextCursor,
			sequence: firstChunk.sequence,
			stream: request.stream,
		};
		state.offered = { consumedBytes: selected.byteLength, inputCursor: request.cursor, result };
		return result;
	}

	function settlePendingRead(channel: 'stderr' | 'stdout'): void {
		const state = states[channel];
		const pendingRead = state.pendingRead;
		if (pendingRead === undefined) return;
		let result: SandboxStreamReadResult | undefined;
		try {
			result = immediateRead(pendingRead.request, channel, state);
		} catch (error: unknown) {
			state.pendingRead = undefined;
			pendingRead.cancelDeadline();
			pendingRead.reject(error instanceof Error ? error : new Error('Portal relay read failed.'));
			return;
		}
		if (result === undefined) return;
		state.pendingRead = undefined;
		pendingRead.cancelDeadline();
		pendingRead.resolve(result);
	}

	const append = (channel: 'stderr' | 'stdout', incomingBytes: Uint8Array): void => {
		if (incomingBytes.byteLength === 0) return;
		if (terminal) throw new Error('Portal relay output is already terminal.');
		const state = states[channel];
		const nextBufferedBytes = state.bufferedBytes + incomingBytes.byteLength;
		const nextBufferedOutputBytes = bufferedOutputBytes + incomingBytes.byteLength;
		const nextTotalBytes = totalOutputBytes + incomingBytes.byteLength;
		if (
			nextBufferedOutputBytes > PORTAL_RELAY_OUTPUT_HARD_CAP_BYTES ||
			nextTotalBytes > PORTAL_RELAY_TOTAL_TRANSFER_BYTES
		) {
			throw new Error('Portal relay output capacity was exhausted.');
		}
		state.chunks.push({ bytes: incomingBytes.slice(), sequence: state.nextSequence++ });
		state.bufferedBytes = nextBufferedBytes;
		bufferedOutputBytes = nextBufferedOutputBytes;
		totalOutputBytes = nextTotalBytes;
		if (!state.paused && state.bufferedBytes >= PORTAL_RELAY_OUTPUT_PAUSE_BYTES) {
			state.paused = true;
			options.pauseOutput(channel);
		}
		settlePendingRead(channel);
	};

	const finish = (): void => {
		terminal = true;
		settlePendingRead('stdout');
		settlePendingRead('stderr');
	};

	const failPendingReads = (error: Error): void => {
		for (const state of Object.values(states)) {
			const pendingRead = state.pendingRead;
			if (pendingRead === undefined) continue;
			state.pendingRead = undefined;
			pendingRead.cancelDeadline();
			pendingRead.reject(error);
		}
	};

	const read = async (request: SandboxStreamReadRequest): Promise<SandboxStreamReadResult> => {
		const { channel, state } = stateFor(request.stream);
		if (state.pendingRead !== undefined) {
			throw new Error('Portal relay stream permits exactly one reader.');
		}
		const immediate = immediateRead(request, channel, state);
		if (immediate !== undefined) return immediate;
		const waitMs = request.waitMs ?? 0;
		if (waitMs === 0) {
			return {
				chunk: { byteLength: 0, contentBase64: '', encoding: 'base64' },
				eof: false,
				kind: 'read',
				...(request.cursor === undefined ? {} : { nextCursor: request.cursor }),
				sequence: state.nextSequence,
				stream: request.stream,
			};
		}
		return await new Promise<SandboxStreamReadResult>((resolve, reject) => {
			const deadlineOwner: { current?: { readonly cancel: () => void } } = {};
			const pendingRead: PendingRead = {
				cancelDeadline: () => deadlineOwner.current?.cancel(),
				reject,
				request,
				resolve,
			};
			state.pendingRead = pendingRead;
			try {
				deadlineOwner.current = options.scheduler.schedule(() => {
					if (state.pendingRead !== pendingRead) return;
					state.pendingRead = undefined;
					resolve({
						chunk: { byteLength: 0, contentBase64: '', encoding: 'base64' },
						eof: false,
						kind: 'read',
						...(request.cursor === undefined ? {} : { nextCursor: request.cursor }),
						sequence: state.nextSequence,
						stream: request.stream,
					});
				}, waitMs);
				if (state.pendingRead !== pendingRead) deadlineOwner.current.cancel();
			} catch (error: unknown) {
				if (state.pendingRead === pendingRead) state.pendingRead = undefined;
				reject(error instanceof Error ? error : new Error('Portal relay read scheduler failed.'));
			}
		});
	};

	return { append, failPendingReads, finish, read };
}
