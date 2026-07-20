import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
	createControllerExecutionDataChannel,
	type ControllerExecutionChannelFrame,
	type ControllerExecutionDataChannelAdmission,
} from './controller-execution-data-channel.js';

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
}

const binding = {
	audience: 'controller-execution-data',
	channelId: 'channel-a',
	controllerEpoch: 'controller-epoch-a',
	executionFingerprint: 'fingerprint-a',
	gatewayEpoch: 'gateway-epoch-a',
	operationId: 'operation-a',
	runtimeEpoch: 'runtime-epoch-a',
	stablePrincipal: 'a'.repeat(64),
} as const;

const deadlineMilliseconds = {
	heartbeat: 1_000,
	'recovery-admission': 1_000,
	'safety-cancel': 1_000,
} as const;

const workLaneLimits = {
	codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
	execution: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
} as const;

function createDefaultDataChannel(): ReturnType<typeof createControllerExecutionDataChannel> {
	return createControllerExecutionDataChannel({
		binding,
		deadlineMilliseconds,
		limits: { initialCreditBytes: 1024, maxQueuedBytes: 1024 },
		workLaneLimits,
		runtime: {
			clock: { now: (): number => 0 },
			scheduler: {
				schedule: (): void => {
					throw new Error('Default data-channel test runtime must not schedule deadlines.');
				},
			},
		},
	});
}

type ControllerExecutionDataFrame = Extract<
	ControllerExecutionChannelFrame,
	{ readonly kind: 'data' }
>;
type ControllerExecutionTerminalFrame = Extract<
	ControllerExecutionChannelFrame,
	{ readonly kind: 'cancel' | 'eof' }
>;

function createDataFrame(
	overrides: Partial<ControllerExecutionDataFrame> = {},
): ControllerExecutionDataFrame {
	return {
		...binding,
		creditBytes: 1024,
		kind: 'data',
		payloadBase64: 'AQID',
		sequence: 0,
		...overrides,
	};
}

function createTerminalFrame(
	kind: ControllerExecutionTerminalFrame['kind'],
): ControllerExecutionTerminalFrame {
	return { ...binding, creditBytes: 1024, kind, sequence: 0 };
}

function createAdmission(
	frame: ControllerExecutionChannelFrame,
): ControllerExecutionDataChannelAdmission {
	return frame.kind === 'data'
		? {
				frame,
				kind: 'data',
				payload: Uint8Array.from(Buffer.from(frame.payloadBase64, 'base64')),
			}
		: { frame, kind: 'terminal' };
}

describe('authenticated bounded controller execution data channel', () => {
	it.each([
		['audience', 'gateway-control'],
		['controllerEpoch', 'controller-epoch-stale'],
		['gatewayEpoch', 'gateway-epoch-stale'],
		['runtimeEpoch', 'runtime-epoch-stale'],
		['stablePrincipal', 'b'.repeat(64)],
		['operationId', 'other-operation'],
		['executionFingerprint', 'other-fingerprint'],
		['channelId', 'other-channel'],
	] as const)('rejects a frame with the wrong %s binding', async (field, attackerValue) => {
		const channel = createDefaultDataChannel();

		await expect(
			channel.receive(createAdmission(createDataFrame({ [field]: attackerValue }))),
		).resolves.toMatchObject({
			kind: 'rejected',
			reason: 'binding-mismatch',
		});
		expect(channel.state()).toMatchObject({
			closureKind: 'rejected',
			kind: 'closed',
			reason: 'binding-mismatch',
			redispatchAllowed: false,
		});
	});

	it.each([
		['duplicate sequence', [createDataFrame(), createDataFrame()], 'invalid-sequence'],
		['out-of-order sequence', [createDataFrame({ sequence: 1 })], 'invalid-sequence'],
		['gapped sequence', [createDataFrame(), createDataFrame({ sequence: 2 })], 'invalid-sequence'],
		[
			'over-credit payload',
			[createDataFrame({ payloadBase64: Buffer.alloc(1025).toString('base64') })],
			'over-credit-payload',
		],
		['replayed frame', [createDataFrame(), createDataFrame()], 'invalid-sequence'],
	] as const)('fails closed for %s', async (_name, frames, expectedReason) => {
		const channel = createDefaultDataChannel();
		const results = await frames.reduce<
			Promise<readonly Awaited<ReturnType<typeof channel.receive>>[]>
		>(
			async (pendingResults, frame) => [
				...(await pendingResults),
				await channel.receive(createAdmission(frame)),
			],
			Promise.resolve([]),
		);

		expect(results.at(-1)).toMatchObject({ kind: 'rejected' });
		expect(channel.state()).toEqual({
			closureKind: 'rejected',
			kind: 'closed',
			queuedBytes: expectedReason === 'invalid-sequence' && frames.length > 1 ? 3 : 0,
			reason: expectedReason,
			redispatchAllowed: false,
		});
	});

	it('preserves the original rejection reason when later frames are ambiguous', async () => {
		const channel = createDefaultDataChannel();
		await channel.receive(createAdmission(createDataFrame({ sequence: 1 })));

		await expect(channel.receive(createAdmission(createDataFrame()))).resolves.toEqual({
			kind: 'rejected',
			reason: 'ambiguous-operation',
		});
		expect(channel.state()).toEqual({
			closureKind: 'rejected',
			kind: 'closed',
			queuedBytes: 0,
			reason: 'invalid-sequence',
			redispatchAllowed: false,
		});
	});

	it.each(['eof', 'cancel'] as const)(
		'rejects duplicate %s and permanently forbids redispatch',
		async (terminalKind) => {
			const channel = createDefaultDataChannel();
			const terminalFrame = createTerminalFrame(terminalKind);
			await channel.receive(createAdmission(terminalFrame));

			await expect(channel.receive(createAdmission(terminalFrame))).resolves.toMatchObject({
				kind: 'rejected',
				reason: 'duplicate-terminal-frame',
			});
			expect(channel.state()).toEqual({
				closureKind: 'terminal',
				kind: 'closed',
				queuedBytes: 0,
				redispatchAllowed: false,
				terminalKind,
			});
			expect(channel.reconnect({ ...binding, kind: 'handshake' })).toEqual({
				kind: 'rejected',
				reason: 'ambiguous-operation',
			});
		},
	);

	it('rejects a stale handshake before accepting frames', () => {
		const channel = createDefaultDataChannel();

		expect(
			channel.authenticateHandshake({
				...binding,
				kind: 'handshake',
				runtimeEpoch: 'runtime-epoch-stale',
			}),
		).toEqual({
			kind: 'rejected',
			reason: 'binding-mismatch',
		});
	});

	it('returns bounded credit only after queued bytes are consumed', async () => {
		const channel = createDefaultDataChannel();

		await expect(channel.receive(createAdmission(createDataFrame()))).resolves.toMatchObject({
			availableCreditBytes: 1021,
			kind: 'accepted',
		});
		expect(channel.consumeQueuedBytes({ consumedBytes: 3 })).toEqual({
			availableCreditBytes: 1024,
			kind: 'credit-granted',
			queuedBytes: 0,
		});
		await expect(
			channel.receive(createAdmission(createDataFrame({ creditBytes: 1024, sequence: 1 }))),
		).resolves.toMatchObject({ kind: 'accepted', nextSequence: 2 });
	});

	it('never exposes redispatch authority, including while the stream is open', () => {
		const channel = createDefaultDataChannel();

		expect(channel.state()).toMatchObject({ kind: 'open', redispatchAllowed: false });
		expect(channel.reconnect({ ...binding, kind: 'handshake' })).toEqual({
			kind: 'rejected',
			reason: 'ambiguous-operation',
		});
	});

	it.each(['before', 'after'] as const)(
		'marks an abnormal transport close %s accepted work as ambiguous and forbids reconnect',
		async (timing) => {
			const channel = createDefaultDataChannel();
			if (timing === 'after') await channel.receive(createAdmission(createDataFrame()));

			channel.notifyTransportClosed();

			expect(channel.state()).toEqual({
				closureKind: 'ambiguous',
				kind: 'closed',
				queuedBytes: timing === 'after' ? 3 : 0,
				redispatchAllowed: false,
			});
			expect(channel.reconnect({ ...binding, kind: 'handshake' })).toEqual({
				kind: 'rejected',
				reason: 'ambiguous-operation',
			});
			expect(
				channel.reconnect({ ...binding, channelId: 'wrong-channel', kind: 'handshake' }),
			).toEqual({ kind: 'rejected', reason: 'binding-mismatch' });
		},
	);

	it.each(['eof', 'cancel'] as const)(
		'preserves proven %s terminal state after transport close notification',
		async (terminalKind) => {
			const channel = createDefaultDataChannel();
			await channel.receive(createAdmission(createTerminalFrame(terminalKind)));

			channel.notifyTransportClosed();

			expect(channel.state()).toEqual({
				closureKind: 'terminal',
				kind: 'closed',
				queuedBytes: 0,
				redispatchAllowed: false,
				terminalKind,
			});
		},
	);

	it('owns and exposes the only bounded work scheduler used by the channel', () => {
		const channel = createDefaultDataChannel();

		expect(channel.workScheduler.state()).toEqual({
			codec: { activeTasks: 0, queuedTasks: 0 },
			execution: { activeTasks: 0, queuedTasks: 0 },
		});
	});

	it('fails closed with a typed reason when execution admission reaches capacity', async () => {
		const channel = createDefaultDataChannel();
		const heldTask = createDeferred<void>();
		const saturatedExecution = channel.workScheduler.runBulkTask(
			'execution',
			async (): Promise<void> => await heldTask.promise,
		);
		await Promise.resolve();

		await expect(channel.receive(createAdmission(createDataFrame()))).resolves.toEqual({
			kind: 'rejected',
			reason: 'execution-capacity-exceeded',
		});
		expect(channel.state()).toMatchObject({
			closureKind: 'rejected',
			kind: 'closed',
			reason: 'execution-capacity-exceeded',
			redispatchAllowed: false,
		});
		heldTask.resolve();
		await saturatedExecution;
	});

	it.each([
		['zero heartbeat', { ...deadlineMilliseconds, heartbeat: 0 }],
		['fractional cancellation', { ...deadlineMilliseconds, 'safety-cancel': 1.5 }],
		[
			'unsafe recovery',
			{
				...deadlineMilliseconds,
				'recovery-admission': Number.MAX_SAFE_INTEGER + 1,
			},
		],
	] as const)('rejects %s deadline policy at construction', (_label, invalidDeadlines) => {
		expect(() =>
			createControllerExecutionDataChannel({
				binding,
				deadlineMilliseconds: invalidDeadlines,
				limits: { initialCreditBytes: 1024, maxQueuedBytes: 1024 },
				workLaneLimits,
				runtime: {
					clock: { now: (): number => 0 },
					scheduler: { schedule: (): void => undefined },
				},
			}),
		).toThrow(/deadline/u);
	});
});

describe('controller execution data-channel deadline isolation', () => {
	it.each(['heartbeat', 'safety-cancel', 'recovery-admission'] as const)(
		'preserves the configured %s deadline while execution frames saturate their queue',
		async (deadlineKind) => {
			const eventScheduler = createInjectedEventScheduler();
			const channel = createControllerExecutionDataChannel({
				binding,
				deadlineMilliseconds,
				limits: { initialCreditBytes: 1024 * 1024, maxQueuedBytes: 1024 * 1024 },
				workLaneLimits,
				runtime: {
					clock: eventScheduler.clock,
					scheduler: eventScheduler.scheduler,
				},
			});
			const heldExecutionTask = createDeferred<void>();
			const saturatedExecution = channel.workScheduler.runBulkTask(
				'execution',
				async (): Promise<void> => await heldExecutionTask.promise,
			);

			const deadline = channel.waitForIndependentDeadline(deadlineKind);
			await expect(deadline).resolves.toEqual({ kind: deadlineKind, met: true });
			heldExecutionTask.resolve();
			await saturatedExecution;
		},
	);
});

function createInjectedEventScheduler(): {
	readonly advanceToNextEvent: () => void;
	readonly clock: { readonly now: () => number };
	readonly scheduler: { readonly schedule: (callback: () => void, delayMs: number) => void };
} {
	let nowMs = 0;
	const events: Array<{ readonly callback: () => void; readonly deadlineMs: number }> = [];
	return {
		advanceToNextEvent: (): void => {
			const event = events.shift();
			if (event === undefined) throw new Error('Expected a scheduled data-channel event.');
			nowMs = event.deadlineMs;
			event.callback();
		},
		clock: { now: (): number => nowMs },
		scheduler: {
			schedule: (callback, delayMs): void => {
				events.push({ callback, deadlineMs: nowMs + delayMs });
				events.sort((left, right) => left.deadlineMs - right.deadlineMs);
			},
		},
	};
}

function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	if (resolvePromise === undefined) throw new Error('Expected a deferred resolver.');
	return { promise, resolve: resolvePromise };
}
