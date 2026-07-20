import { createHash } from 'node:crypto';

import {
	SandboxProcessCancelResultSchema,
	SandboxProcessLogsResultSchema,
	SandboxProcessStartResultSchema,
	SandboxProcessStatusResultSchema,
	SandboxProcessWaitResultSchema,
	SandboxStreamCloseResultSchema,
	SandboxStreamReadResultSchema,
	SandboxStreamWriteResultSchema,
	type SandboxStreamHandle,
} from '@agent-vm/agent-portal-sdk';
import { describe, expect, it } from 'vitest';

import type {
	StrictToolVmSshOpenProcessChannelRequest,
	StrictToolVmSshOpenShellProcessChannelRequest,
	StrictToolVmSshProcessChannel,
} from './strict-tool-vm-ssh-client.js';
import {
	createStrictToolVmSshProcessRuntime,
	type ResolvedStrictToolVmSshProcessStartRequest,
	type StrictToolVmSshProcessStartError,
	type StrictToolVmSshProcessRuntime,
	type StrictToolVmSshProcessRuntimeLimits,
	type StrictToolVmSshProcessRuntimeScheduler,
} from './strict-tool-vm-ssh-process-runtime.js';

function digest(bytes: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function binaryChunk(bytes: Uint8Array): {
	readonly byteLength: number;
	readonly contentBase64: string;
	readonly encoding: 'base64';
} {
	return {
		byteLength: bytes.byteLength,
		contentBase64: Buffer.from(bytes).toString('base64'),
		encoding: 'base64',
	};
}

class FakeProcessChannel implements StrictToolVmSshProcessChannel {
	readonly writes: Uint8Array[] = [];
	cancelRequestCount = 0;
	endInputCount = 0;
	throwOnCancellation = false;
	throwOnEndInput = false;
	throwOnWrite = false;
	onCancellation: (() => void) | undefined;
	readonly terminalSizes: { readonly columns: number; readonly rows: number }[] = [];

	requestCancellation(): void {
		this.cancelRequestCount += 1;
		this.onCancellation?.();
		if (this.throwOnCancellation) throw new Error('channel cancellation failed');
	}

	endInput(): void {
		this.endInputCount += 1;
		if (this.throwOnEndInput) throw new Error('channel EOF failed');
	}

	resizeTerminal(size: { readonly columns: number; readonly rows: number }): void {
		this.terminalSizes.push(size);
	}

	async write(bytes: Uint8Array): Promise<void> {
		this.writes.push(bytes.slice());
		if (this.throwOnWrite) throw new Error('channel write failed');
	}
}

interface ScheduledCallback {
	readonly callback: () => void;
	readonly delayMilliseconds: number;
	active: boolean;
}

interface OpenProcessRecord {
	readonly channel: FakeProcessChannel;
	readonly request: StrictToolVmSshOpenProcessChannelRequest;
}

interface RuntimeFixture {
	readonly expireFirst: (delayMilliseconds: number) => void;
	readonly getOpenRecord: (index?: number) => OpenProcessRecord;
	readonly getOpenShellRecord: (index?: number) => {
		readonly channel: FakeProcessChannel;
		readonly request: StrictToolVmSshOpenShellProcessChannelRequest;
	};
	readonly pendingDelayCount: (delayMilliseconds: number) => number;
	readonly resolveNextOpen: () => void;
	readonly runtime: StrictToolVmSshProcessRuntime;
	readonly setOpenPending: (pending: boolean) => void;
}

interface RuntimeFixtureOptions {
	readonly createHandleId?: (kind: 'cursor' | 'operation' | 'process' | 'stream') => string;
	readonly expireSynchronouslyAt?: number;
	readonly throwCancellingAt?: number;
	readonly throwSchedulingAt?: number;
}

const defaultLimits: StrictToolVmSshProcessRuntimeLimits = {
	maximumCursorRecordsPerProcess: 2,
	maximumLogChunksPerCall: 1_000,
	maximumOpenMilliseconds: 50,
	maximumProcessCount: 3,
	maximumReadBytes: 16,
	maximumReadChunksPerCall: 1,
	maximumRetainedOutputBytesPerProcess: 2_048,
	maximumRuntimeMilliseconds: 2_000,
	maximumTerminalTombstones: 2,
	maximumWaitMilliseconds: 100,
	maximumWriteBytes: 4,
	maximumWriteRecordsPerProcess: 2,
	maximumWrittenBytesPerProcess: 8,
};

const defaultStartRequest: ResolvedStrictToolVmSshProcessStartRequest = {
	argv: ['/usr/bin/cat'],
	cwd: '',
	maxRuntimeMs: 1_000,
	retainOutputBytes: 2_048,
};

function createRuntimeFixture(
	limits: Partial<StrictToolVmSshProcessRuntimeLimits> = {},
	fixtureOptions: RuntimeFixtureOptions = {},
): RuntimeFixture {
	const scheduledCallbacks: ScheduledCallback[] = [];
	const scheduler: StrictToolVmSshProcessRuntimeScheduler = {
		schedule: (callback, delayMilliseconds) => {
			if (delayMilliseconds === fixtureOptions.throwSchedulingAt) {
				throw new Error('scheduler rejected deadline');
			}
			const scheduled: ScheduledCallback = { active: true, callback, delayMilliseconds };
			scheduledCallbacks.push(scheduled);
			if (delayMilliseconds === fixtureOptions.expireSynchronouslyAt) {
				scheduled.active = false;
				callback();
			}
			return {
				cancel: () => {
					scheduled.active = false;
					if (delayMilliseconds === fixtureOptions.throwCancellingAt) {
						throw new Error('scheduler cancellation failed');
					}
				},
			};
		},
	};
	let nextHandleId = 0;
	let openPending = false;
	const openRecords: OpenProcessRecord[] = [];
	const openShellRecords: Array<{
		readonly channel: FakeProcessChannel;
		readonly request: StrictToolVmSshOpenShellProcessChannelRequest;
	}> = [];
	const pendingOpenRequests: Array<{
		readonly channel: FakeProcessChannel;
		readonly resolve: (channel: FakeProcessChannel) => void;
	}> = [];
	const runtime = createStrictToolVmSshProcessRuntime({
		createHandleId: fixtureOptions.createHandleId ?? ((kind) => `${kind}-${++nextHandleId}`),
		limits: { ...defaultLimits, ...limits },
		owningGeneration: 'tool-vm-generation-7',
		scheduler,
		strictSshClient: {
			openShellProcessChannel: async (request) => {
				const channel = new FakeProcessChannel();
				openShellRecords.push({ channel, request });
				return channel;
			},
			openProcessChannel: async (request) => {
				const channel = new FakeProcessChannel();
				openRecords.push({ channel, request });
				if (!openPending) return channel;
				return await new Promise<FakeProcessChannel>((resolve) => {
					pendingOpenRequests.push({ channel, resolve });
				});
			},
		},
	});
	return {
		expireFirst: (delayMilliseconds) => {
			const scheduled = scheduledCallbacks.find(
				(candidate) => candidate.active && candidate.delayMilliseconds === delayMilliseconds,
			);
			if (scheduled === undefined) {
				throw new Error(`No active ${delayMilliseconds}ms callback.`);
			}
			scheduled.active = false;
			scheduled.callback();
		},
		getOpenRecord: (index = 0) => {
			const record = openRecords[index];
			if (record === undefined) throw new Error(`Missing open record ${index}.`);
			return record;
		},
		getOpenShellRecord: (index = 0) => {
			const record = openShellRecords[index];
			if (record === undefined) throw new Error(`Missing open shell record ${index}.`);
			return record;
		},
		pendingDelayCount: (delayMilliseconds) =>
			scheduledCallbacks.filter(
				(candidate) => candidate.active && candidate.delayMilliseconds === delayMilliseconds,
			).length,
		resolveNextOpen: () => {
			const pending = pendingOpenRequests.shift();
			if (pending === undefined) throw new Error('No pending open request.');
			pending.resolve(pending.channel);
		},
		runtime,
		setOpenPending: (pending) => void (openPending = pending),
	};
}

function streamFor(
	streams: readonly SandboxStreamHandle[],
	channel: SandboxStreamHandle['channel'],
): SandboxStreamHandle {
	const stream = streams.find((candidate) => candidate.channel === channel);
	if (stream === undefined) throw new Error(`Missing ${channel} stream.`);
	return stream;
}

describe('strict Tool VM SSH process runtime', () => {
	it('starts an arbitrary shell process and resizes its allocated terminal', async () => {
		// Arrange
		const fixture = createRuntimeFixture();

		// Act
		const started = await fixture.runtime.startShell({
			command: 'printf "$MODE"',
			cwd: '/workspace',
			environmentVariables: [{ name: 'MODE', value: 'beta' }],
			maxRuntimeMs: 1_000,
			retainOutputBytes: 2_048,
			terminalSize: { columns: 120, rows: 40 },
		});
		const shellRecord = fixture.getOpenShellRecord();
		fixture.runtime.resizeTerminal({
			process: started.process,
			size: { columns: 160, rows: 55 },
		});

		// Assert
		expect(shellRecord.request).toMatchObject({
			command: 'printf "$MODE"',
			cwd: '/workspace',
			environmentVariables: [{ name: 'MODE', value: 'beta' }],
			terminalSize: { columns: 120, rows: 40 },
		});
		expect(shellRecord.channel.terminalSizes).toEqual([{ columns: 160, rows: 55 }]);
	});

	it('classifies process-count rejection before dispatch and open timeout after possible dispatch', async () => {
		const limitedFixture = createRuntimeFixture({ maximumProcessCount: 1 });
		await limitedFixture.runtime.start(defaultStartRequest);

		const limitedStart = limitedFixture.runtime.start(defaultStartRequest);
		await expect(limitedStart).rejects.toMatchObject({
			disposition: 'not-dispatched',
			name: 'StrictToolVmSshProcessStartError',
		} satisfies Partial<StrictToolVmSshProcessStartError>);
		expect(limitedFixture.getOpenRecord).toBeDefined();

		const ambiguousFixture = createRuntimeFixture();
		ambiguousFixture.setOpenPending(true);
		const ambiguousStart = ambiguousFixture.runtime.start(defaultStartRequest);
		ambiguousFixture.expireFirst(defaultLimits.maximumOpenMilliseconds);

		await expect(ambiguousStart).rejects.toMatchObject({
			disposition: 'ambiguous',
			name: 'StrictToolVmSshProcessStartError',
		} satisfies Partial<StrictToolVmSshProcessStartError>);
	});

	it('reports successful and failed process completion without weakening certainty', async () => {
		const fixture = createRuntimeFixture();
		const succeeded = await fixture.runtime.start(defaultStartRequest);
		const failed = await fixture.runtime.start(defaultStartRequest);
		expect(() => SandboxProcessStartResultSchema.parse(succeeded)).not.toThrow();
		expect(() => SandboxProcessStartResultSchema.parse(failed)).not.toThrow();

		expect(() =>
			fixture.getOpenRecord(0).request.onTerminal({ exitCode: 0, kind: 'exited' }),
		).not.toThrow();
		expect(() =>
			fixture.getOpenRecord(1).request.onTerminal({ exitCode: 17, kind: 'exited' }),
		).not.toThrow();

		const succeededStatus = fixture.runtime.status({ process: succeeded.process });
		const failedStatus = fixture.runtime.status({ process: failed.process });
		expect(() => SandboxProcessStatusResultSchema.parse(succeededStatus)).not.toThrow();
		expect(() => SandboxProcessStatusResultSchema.parse(failedStatus)).not.toThrow();
		expect(succeededStatus).toMatchObject({
			kind: 'terminal',
			outcome: { certainty: 'proven', completion: 'succeeded', kind: 'completed' },
		});
		expect(failedStatus).toMatchObject({
			kind: 'terminal',
			outcome: { certainty: 'proven', completion: 'failed', kind: 'completed' },
		});
	});
	it.each([0, 1, 127])('retains the exact proven process exit code %i', async (exitCode) => {
		// Arrange
		const fixture = createRuntimeFixture();
		const started = await fixture.runtime.start(defaultStartRequest);

		// Act
		fixture.getOpenRecord().request.onTerminal({ exitCode, kind: 'exited' });

		// Assert
		expect(fixture.runtime.terminalExitCode({ process: started.process })).toBe(exitCode);
	});
	it('keeps cancellation pending until exit proves termination and preserves ambiguity', async () => {
		const fixture = createRuntimeFixture();
		const cancelled = await fixture.runtime.start(defaultStartRequest);

		const accepted = fixture.runtime.cancel({ process: cancelled.process });
		const pending = fixture.runtime.cancel({ process: cancelled.process });
		expect(() => SandboxProcessCancelResultSchema.parse(accepted)).not.toThrow();
		expect(() => SandboxProcessCancelResultSchema.parse(pending)).not.toThrow();
		expect(accepted.kind).toBe('cancel-request-accepted');
		expect(pending.kind).toBe('cancellation-pending');
		expect(fixture.runtime.status({ process: cancelled.process }).kind).toBe('running');
		fixture.getOpenRecord().request.onTerminal({ exitCode: 143, kind: 'exited' });
		expect(fixture.runtime.terminalExitCode({ process: cancelled.process })).toBeUndefined();
		const alreadyTerminal = fixture.runtime.cancel({ process: cancelled.process });
		expect(() => SandboxProcessCancelResultSchema.parse(alreadyTerminal)).not.toThrow();
		expect(alreadyTerminal).toMatchObject({
			kind: 'already-terminal',
			outcome: { certainty: 'proven-terminated', kind: 'cancelled-proven' },
		});

		const ambiguousFixture = createRuntimeFixture();
		const ambiguous = await ambiguousFixture.runtime.start(defaultStartRequest);
		ambiguousFixture.runtime.cancel({ process: ambiguous.process });
		ambiguousFixture.getOpenRecord().request.onTerminal({ kind: 'ambiguous' });
		expect(
			ambiguousFixture.runtime.terminalExitCode({ process: ambiguous.process }),
		).toBeUndefined();
		expect(ambiguousFixture.runtime.status({ process: ambiguous.process })).toMatchObject({
			kind: 'terminal',
			outcome: {
				certainty: 'side-effects-and-termination-unknown',
				kind: 'ambiguous',
			},
		});

		const synchronousProof = createRuntimeFixture();
		const proven = await synchronousProof.runtime.start(defaultStartRequest);
		synchronousProof.getOpenRecord().channel.throwOnCancellation = true;
		synchronousProof.getOpenRecord().channel.onCancellation = () =>
			synchronousProof.getOpenRecord().request.onTerminal({ exitCode: 143, kind: 'exited' });
		expect(synchronousProof.runtime.cancel({ process: proven.process })).toMatchObject({
			kind: 'termination-proven',
			outcome: { certainty: 'proven-terminated', kind: 'cancelled-proven' },
		});
	});
	it('bounds open, runtime, and wait deadlines and distinguishes timeout proof', async () => {
		const fixture = createRuntimeFixture();
		fixture.setOpenPending(true);
		const opening = fixture.runtime.start(defaultStartRequest);
		expect(fixture.pendingDelayCount(defaultLimits.maximumOpenMilliseconds)).toBe(1);
		fixture.expireFirst(defaultLimits.maximumOpenMilliseconds);
		await expect(opening).rejects.toThrow(/open deadline/i);
		fixture.resolveNextOpen();
		await Promise.resolve();
		await Promise.resolve();
		expect(fixture.getOpenRecord().channel.cancelRequestCount).toBe(1);

		fixture.setOpenPending(false);
		const started = await fixture.runtime.start(defaultStartRequest);
		const waiting = fixture.runtime.wait({ process: started.process, timeoutMs: 50 });
		fixture.expireFirst(50);
		const waitResult = await waiting;
		expect(() => SandboxProcessWaitResultSchema.parse(waitResult)).not.toThrow();
		expect(waitResult).toMatchObject({ kind: 'running' });
		expect(() =>
			fixture.runtime.wait({
				process: started.process,
				timeoutMs: defaultLimits.maximumWaitMilliseconds + 1,
			}),
		).toThrow(/wait deadline/i);

		fixture.expireFirst(defaultStartRequest.maxRuntimeMs);
		expect(fixture.runtime.status({ process: started.process }).kind).toBe('running');
		fixture.getOpenRecord(1).request.onTerminal({ exitCode: 143, kind: 'exited' });
		expect(fixture.runtime.status({ process: started.process })).toMatchObject({
			kind: 'terminal',
			outcome: { certainty: 'proven-terminated', kind: 'timed-out-proven' },
		});
	});
	it('settles a start whose open scheduler expires synchronously and rejects handle collisions', async () => {
		const synchronousExpiry = createRuntimeFixture(
			{},
			{
				expireSynchronouslyAt: defaultLimits.maximumOpenMilliseconds,
			},
		);
		await expect(synchronousExpiry.runtime.start(defaultStartRequest)).rejects.toThrow(
			/open deadline/i,
		);

		const collidingHandles = createRuntimeFixture({}, { createHandleId: (kind) => kind });
		await expect(collidingHandles.runtime.start(defaultStartRequest)).rejects.toMatchObject({
			disposition: 'not-dispatched',
			message: expect.stringMatching(/identifier collided/i),
		});

		const synchronousWait = createRuntimeFixture({}, { expireSynchronouslyAt: 7 });
		const started = await synchronousWait.runtime.start(defaultStartRequest);
		await expect(
			synchronousWait.runtime.wait({ process: started.process, timeoutMs: 7 }),
		).resolves.toMatchObject({ kind: 'running' });

		const rejectedSchedule = createRuntimeFixture(
			{},
			{
				throwSchedulingAt: defaultLimits.maximumOpenMilliseconds,
			},
		);
		await expect(rejectedSchedule.runtime.start(defaultStartRequest)).rejects.toThrow(
			/scheduler rejected/i,
		);
		await Promise.resolve();
		expect(rejectedSchedule.getOpenRecord().channel.cancelRequestCount).toBe(1);

		const rejectedCancellation = createRuntimeFixture(
			{},
			{
				throwCancellingAt: defaultLimits.maximumOpenMilliseconds,
			},
		);
		await expect(rejectedCancellation.runtime.start(defaultStartRequest)).resolves.toMatchObject({
			kind: 'started',
		});
	});
	it('reads channel-specific output with bounded cursors and truthful EOF', async () => {
		const fixture = createRuntimeFixture({ maximumCursorRecordsPerProcess: 2 });
		const started = await fixture.runtime.start(defaultStartRequest);
		const stdout = streamFor(started.streams, 'stdout');
		const stderr = streamFor(started.streams, 'stderr');
		fixture.getOpenRecord().request.onStdout(Buffer.from('abcd'));
		fixture.getOpenRecord().request.onStderr(Buffer.from('err'));

		const first = fixture.runtime.read({ maxBytes: 2, stream: stdout });
		expect(() => SandboxStreamReadResultSchema.parse(first)).not.toThrow();
		expect(first).toMatchObject({
			chunk: { byteLength: 2, contentBase64: 'YWI=' },
			eof: false,
			kind: 'read',
		});
		expect(() =>
			fixture.runtime.read({ cursor: first.nextCursor, maxBytes: 2, stream: stderr }),
		).toThrow(/channel-mismatched/i);
		const second = fixture.runtime.read({
			cursor: first.nextCursor,
			maxBytes: 2,
			stream: stdout,
		});
		const third = fixture.runtime.read({ maxBytes: 1, stream: stdout });
		expect(() =>
			fixture.runtime.read({ cursor: first.nextCursor, maxBytes: 2, stream: stdout }),
		).toThrow(/cursor/i);
		expect(second.chunk.contentBase64).toBe('Y2Q=');
		expect(third.kind).toBe('read');

		fixture.getOpenRecord().request.onTerminal({ exitCode: 0, kind: 'exited' });
		const end = fixture.runtime.read({
			cursor: second.nextCursor,
			maxBytes: 2,
			stream: stdout,
		});
		expect(() => SandboxStreamReadResultSchema.parse(end)).not.toThrow();
		expect(end).toMatchObject({ chunk: { byteLength: 0 }, eof: true, nextCursor: undefined });
		const exhaustedLogs = fixture.runtime.logs({
			channels: ['stdout'],
			cursor: undefined,
			maxBytes: 16,
			process: started.process,
		});
		expect(() => SandboxProcessLogsResultSchema.parse(exhaustedLogs)).not.toThrow();
		expect(exhaustedLogs.nextCursor).toBeUndefined();
	});
	it('caps logs at 1000 chunks and rejects stale or channel-mismatched cursors', async () => {
		const fixture = createRuntimeFixture({
			maximumCursorRecordsPerProcess: 2,
			maximumLogChunksPerCall: 1_000,
			maximumRetainedOutputBytesPerProcess: 2_048,
		});
		const started = await fixture.runtime.start(defaultStartRequest);
		for (let index = 0; index < 1_001; index += 1) {
			fixture.getOpenRecord().request.onStdout(Buffer.from('x'));
		}

		const first = fixture.runtime.logs({
			channels: ['stdout'],
			maxBytes: 2_048,
			process: started.process,
		});
		expect(() => SandboxProcessLogsResultSchema.parse(first)).not.toThrow();
		expect(first.chunks).toHaveLength(1_000);
		expect(first.truncated).toBe(true);
		expect(() =>
			fixture.runtime.logs({
				channels: ['stderr'],
				cursor: first.nextCursor,
				maxBytes: 1,
				process: started.process,
			}),
		).toThrow(/channel-mismatched/i);
		const second = fixture.runtime.logs({
			channels: ['stdout'],
			cursor: first.nextCursor,
			maxBytes: 1,
			process: started.process,
		});
		fixture.runtime.logs({ channels: ['stdout'], maxBytes: 1, process: started.process });
		expect(second.chunks).toHaveLength(1);
		expect(() =>
			fixture.runtime.logs({
				channels: ['stdout'],
				cursor: first.nextCursor,
				maxBytes: 1,
				process: started.process,
			}),
		).toThrow(/cursor/i);
	});
	it('bounds retained output and invalidates cursors whose bytes were discarded', async () => {
		const fixture = createRuntimeFixture({ maximumRetainedOutputBytesPerProcess: 4 });
		const started = await fixture.runtime.start({ ...defaultStartRequest, retainOutputBytes: 4 });
		fixture.getOpenRecord().request.onStdout(Buffer.from('ab'));
		const beforeEviction = fixture.runtime.logs({
			channels: ['stdout'],
			maxBytes: 1,
			process: started.process,
		});
		fixture.getOpenRecord().request.onStdout(Buffer.from('cdef'));

		expect(() =>
			fixture.runtime.logs({
				channels: ['stdout'],
				cursor: beforeEviction.nextCursor,
				maxBytes: 4,
				process: started.process,
			}),
		).toThrow(/stale/i);
		const retained = fixture.runtime.logs({
			channels: ['stdout'],
			maxBytes: 4,
			process: started.process,
		});
		expect(
			Buffer.concat(
				retained.chunks.map((chunk) => Buffer.from(chunk.chunk.contentBase64, 'base64')),
			).toString('utf8'),
		).toBe('cdef');
		expect(retained.truncated).toBe(true);
	});

	it('makes sequenced writes idempotent and fails closed at digest and record bounds', async () => {
		const fixture = createRuntimeFixture({ maximumWriteRecordsPerProcess: 2 });
		const started = await fixture.runtime.start(defaultStartRequest);
		const stdin = streamFor(started.streams, 'stdin');
		const firstBytes = Buffer.from('ab');
		const firstRequest = {
			content: binaryChunk(firstBytes),
			contentDigest: digest(firstBytes),
			sequence: 0,
			stream: stdin,
		};

		const written = await fixture.runtime.write(firstRequest);
		const alreadyWritten = await fixture.runtime.write(firstRequest);
		expect(() => SandboxStreamWriteResultSchema.parse(written)).not.toThrow();
		expect(() => SandboxStreamWriteResultSchema.parse(alreadyWritten)).not.toThrow();
		expect(written).toMatchObject({ kind: 'written' });
		expect(alreadyWritten).toMatchObject({ kind: 'already-written' });
		await expect(
			fixture.runtime.write({
				...firstRequest,
				content: binaryChunk(Buffer.from('cd')),
				contentDigest: digest(Buffer.from('cd')),
			}),
		).rejects.toThrow(/different content/i);
		await expect(
			fixture.runtime.write({ ...firstRequest, contentDigest: digest(Buffer.from('wrong')) }),
		).rejects.toThrow(/digest/i);
		const secondBytes = Buffer.from('cd');
		await fixture.runtime.write({
			content: binaryChunk(secondBytes),
			contentDigest: digest(secondBytes),
			sequence: 1,
			stream: stdin,
		});
		await expect(
			fixture.runtime.write({
				content: binaryChunk(Buffer.from('e')),
				contentDigest: digest(Buffer.from('e')),
				sequence: 2,
				stream: stdin,
			}),
		).rejects.toThrow(/write record/i);
		expect(fixture.getOpenRecord().channel.writes).toEqual([firstBytes, secondBytes]);

		const closed = fixture.runtime.closeStream({ stream: stdin });
		const alreadyClosed = fixture.runtime.closeStream({ stream: stdin });
		expect(() => SandboxStreamCloseResultSchema.parse(closed)).not.toThrow();
		expect(() => SandboxStreamCloseResultSchema.parse(alreadyClosed)).not.toThrow();
		expect(closed.kind).toBe('closed');
		expect(alreadyClosed.kind).toBe('already-closed');
		expect(fixture.getOpenRecord().channel.endInputCount).toBe(1);
	});

	it('retains an ambiguous failed-write record so the same sequence cannot be replayed', async () => {
		const fixture = createRuntimeFixture();
		const started = await fixture.runtime.start(defaultStartRequest);
		const stdin = streamFor(started.streams, 'stdin');
		const bytes = Buffer.from('ab');
		fixture.getOpenRecord().channel.throwOnWrite = true;
		const request = {
			content: binaryChunk(bytes),
			contentDigest: digest(bytes),
			sequence: 0,
			stream: stdin,
		};

		await expect(fixture.runtime.write(request)).rejects.toThrow(/ambiguous/i);
		fixture.getOpenRecord().channel.throwOnWrite = false;
		await expect(fixture.runtime.write(request)).rejects.toThrow(/retry is forbidden/i);
		expect(fixture.getOpenRecord().channel.writes).toHaveLength(1);
	});

	it('retains bounded terminal tombstones and evicts the oldest to free process capacity', async () => {
		const fixture = createRuntimeFixture({
			maximumProcessCount: 2,
			maximumTerminalTombstones: 1,
		});
		const first = await fixture.runtime.start(defaultStartRequest);
		const second = await fixture.runtime.start(defaultStartRequest);
		await expect(fixture.runtime.start(defaultStartRequest)).rejects.toThrow(/process count/i);

		fixture.getOpenRecord(0).request.onTerminal({ exitCode: 0, kind: 'exited' });
		const third = await fixture.runtime.start(defaultStartRequest);
		expect(() => fixture.runtime.status({ process: first.process })).toThrow(/handle/i);
		fixture.getOpenRecord(1).request.onTerminal({ exitCode: 0, kind: 'exited' });
		fixture.getOpenRecord(2).request.onTerminal({ exitCode: 0, kind: 'exited' });
		expect(() => fixture.runtime.status({ process: second.process })).toThrow(/handle/i);
		expect(fixture.runtime.status({ process: third.process }).kind).toBe('terminal');
	});

	it('retires idempotently, invalidates first, cancels every channel, and never proves replacement', async () => {
		const fixture = createRuntimeFixture();
		const first = await fixture.runtime.start(defaultStartRequest);
		const second = await fixture.runtime.start(defaultStartRequest);
		fixture.getOpenRecord(0).channel.throwOnCancellation = true;
		fixture.getOpenRecord(1).channel.onCancellation = () =>
			fixture.getOpenRecord(1).request.onTerminal({ exitCode: 143, kind: 'exited' });
		const ambiguousWait = fixture.runtime.wait({ process: first.process, timeoutMs: 100 });
		const provenWait = fixture.runtime.wait({ process: second.process, timeoutMs: 100 });

		await expect(
			Promise.all([fixture.runtime.retire(), fixture.runtime.retire()]),
		).resolves.toEqual([undefined, undefined]);
		await expect(ambiguousWait).resolves.toMatchObject({
			kind: 'terminal',
			outcome: {
				certainty: 'side-effects-and-termination-unknown',
				kind: 'ambiguous',
			},
		});
		await expect(provenWait).resolves.toMatchObject({
			kind: 'terminal',
			outcome: { certainty: 'proven-terminated', kind: 'replaced-proven' },
		});
		expect(fixture.getOpenRecord(0).channel.cancelRequestCount).toBe(1);
		expect(fixture.getOpenRecord(1).channel.cancelRequestCount).toBe(1);
		expect(() => fixture.runtime.status({ process: first.process })).toThrow(/retired/i);
		expect(() => fixture.runtime.status({ process: second.process })).toThrow(/retired/i);
		await expect(fixture.runtime.start(defaultStartRequest)).rejects.toThrow(/retired/i);
	});
});
