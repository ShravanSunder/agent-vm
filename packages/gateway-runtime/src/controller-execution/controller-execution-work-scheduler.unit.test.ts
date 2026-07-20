import { describe, expect, it } from 'vitest';

import {
	ControllerExecutionWorkCapacityError,
	createControllerExecutionWorkScheduler,
} from '../index.js';

interface DeferredTask<TValue = void> {
	readonly promise: Promise<TValue>;
	readonly reject: (error: unknown) => void;
	readonly resolve: (value: TValue) => void;
}

interface ManualDeadlineRuntime {
	readonly advanceBy: (elapsedMs: number) => void;
	readonly advanceToNextDeadline: () => void;
	readonly clock: { readonly now: () => number };
	readonly scheduler: { readonly schedule: (callback: () => void, delayMs: number) => void };
}

function createDeferredTask<TValue = void>(): DeferredTask<TValue> {
	let rejectTask!: (error: unknown) => void;
	let resolveTask!: (value: TValue) => void;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectTask = reject;
		resolveTask = resolve;
	});
	return { promise, reject: rejectTask, resolve: resolveTask };
}

function createImmediateDeadlineRuntime(): {
	readonly clock: { readonly now: () => number };
	readonly scheduler: { readonly schedule: (callback: () => void, delayMs: number) => void };
} {
	return {
		clock: { now: (): number => 0 },
		scheduler: { schedule: (): void => undefined },
	};
}

function createManualDeadlineRuntime(): ManualDeadlineRuntime {
	let nowMs = 0;
	const deadlines: Array<{ readonly callback: () => void; readonly atMs: number }> = [];
	return {
		advanceBy: (elapsedMs): void => {
			nowMs += elapsedMs;
		},
		advanceToNextDeadline: (): void => {
			const deadline = deadlines.shift();
			if (deadline === undefined) throw new Error('Expected a scheduled critical deadline.');
			nowMs = Math.max(nowMs, deadline.atMs);
			deadline.callback();
		},
		clock: { now: (): number => nowMs },
		scheduler: {
			schedule: (callback, delayMs): void => {
				deadlines.push({ atMs: nowMs + delayMs, callback });
				deadlines.sort((left, right) => left.atMs - right.atMs);
			},
		},
	};
}

async function flushScheduledWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('controller execution work scheduler', () => {
	it('fails closed for invalid bulk limits and critical deadlines', () => {
		const createScheduler = (props: {
			readonly codecConcurrent?: number;
			readonly codecQueued?: number;
			readonly heartbeatDeadline?: number;
		}): (() => unknown) => {
			return () =>
				createControllerExecutionWorkScheduler({
					deadlinesMs: {
						heartbeat: props.heartbeatDeadline ?? 100,
						'recovery-admission': 100,
						'safety-cancel': 100,
					},
					limits: {
						codec: {
							maxConcurrentTasks: props.codecConcurrent ?? 1,
							maxQueuedTasks: props.codecQueued ?? 1,
						},
						execution: { maxConcurrentTasks: 1, maxQueuedTasks: 1 },
					},
					runtime: createImmediateDeadlineRuntime(),
				});
		};

		expect(createScheduler({ codecConcurrent: 0 })).toThrow(/positive safe integer/u);
		expect(createScheduler({ codecConcurrent: Number.POSITIVE_INFINITY })).toThrow(
			/positive safe integer/u,
		);
		expect(createScheduler({ codecQueued: -1 })).toThrow(/non-negative safe integer/u);
		expect(createScheduler({ codecQueued: 1.5 })).toThrow(/non-negative safe integer/u);
		expect(createScheduler({ heartbeatDeadline: 0 })).toThrow(/positive safe integer/u);
		expect(createScheduler({ heartbeatDeadline: Number.NaN })).toThrow(/positive safe integer/u);
	});

	it('enforces execution and codec capacity independently and reports exact state', async () => {
		const scheduler = createControllerExecutionWorkScheduler({
			deadlinesMs: { heartbeat: 100, 'recovery-admission': 100, 'safety-cancel': 100 },
			limits: {
				codec: { maxConcurrentTasks: 1, maxQueuedTasks: 1 },
				execution: { maxConcurrentTasks: 2, maxQueuedTasks: 1 },
			},
			runtime: createImmediateDeadlineRuntime(),
		});
		const executionTasks = [createDeferredTask(), createDeferredTask(), createDeferredTask()];
		const codecTasks = [createDeferredTask(), createDeferredTask()];
		const executionRuns = executionTasks.map((task) =>
			scheduler.runBulkTask('execution', async (): Promise<void> => await task.promise),
		);
		const codecRuns = codecTasks.map((task) =>
			scheduler.runBulkTask('codec', async (): Promise<void> => await task.promise),
		);

		expect(scheduler.state()).toEqual({
			codec: { activeTasks: 1, queuedTasks: 1 },
			execution: { activeTasks: 2, queuedTasks: 1 },
		});
		await expect(
			scheduler.runBulkTask('execution', async (): Promise<void> => undefined),
		).rejects.toMatchObject({ workKind: 'execution' });
		await expect(
			scheduler.runBulkTask('codec', async (): Promise<void> => undefined),
		).rejects.toBeInstanceOf(ControllerExecutionWorkCapacityError);

		for (const task of [...executionTasks, ...codecTasks]) task.resolve();
		await Promise.all([...executionRuns, ...codecRuns]);
		expect(scheduler.state()).toEqual({
			codec: { activeTasks: 0, queuedTasks: 0 },
			execution: { activeTasks: 0, queuedTasks: 0 },
		});
	});

	it('starts queued bulk work in FIFO order without exceeding the parallel bound', async () => {
		const scheduler = createControllerExecutionWorkScheduler({
			deadlinesMs: { heartbeat: 100, 'recovery-admission': 100, 'safety-cancel': 100 },
			limits: {
				codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
				execution: { maxConcurrentTasks: 2, maxQueuedTasks: 3 },
			},
			runtime: createImmediateDeadlineRuntime(),
		});
		const tasks = Array.from({ length: 5 }, () => createDeferredTask());
		const startedTaskIndexes: number[] = [];
		let activeTaskCount = 0;
		let peakActiveTaskCount = 0;
		const runs = tasks.map((task, taskIndex) =>
			scheduler.runBulkTask('execution', async (): Promise<number> => {
				startedTaskIndexes.push(taskIndex);
				activeTaskCount += 1;
				peakActiveTaskCount = Math.max(peakActiveTaskCount, activeTaskCount);
				await task.promise;
				activeTaskCount -= 1;
				return taskIndex;
			}),
		);

		await flushScheduledWork();
		expect(startedTaskIndexes).toEqual([0, 1]);
		tasks[1]?.resolve();
		await runs[1];
		await flushScheduledWork();
		expect(startedTaskIndexes).toEqual([0, 1, 2]);
		tasks[0]?.resolve();
		await runs[0];
		await flushScheduledWork();
		expect(startedTaskIndexes).toEqual([0, 1, 2, 3]);
		tasks[2]?.resolve();
		await runs[2];
		await flushScheduledWork();
		expect(startedTaskIndexes).toEqual([0, 1, 2, 3, 4]);
		for (const task of tasks.slice(3)) task.resolve();

		await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4]);
		expect(peakActiveTaskCount).toBe(2);
		expect(scheduler.state().execution).toEqual({ activeTasks: 0, queuedTasks: 0 });
	});

	it('releases capacity and preserves the original error after a bulk task rejects', async () => {
		const scheduler = createControllerExecutionWorkScheduler({
			deadlinesMs: { heartbeat: 100, 'recovery-admission': 100, 'safety-cancel': 100 },
			limits: {
				codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
				execution: { maxConcurrentTasks: 1, maxQueuedTasks: 1 },
			},
			runtime: createImmediateDeadlineRuntime(),
		});
		const firstTask = createDeferredTask();
		const expectedError = new Error('execution-failed');
		let secondTaskStarted = false;
		const firstRun = scheduler.runBulkTask(
			'execution',
			async (): Promise<void> => await firstTask.promise,
		);
		const secondRun = scheduler.runBulkTask('execution', async (): Promise<string> => {
			secondTaskStarted = true;
			return 'second-completed';
		});

		firstTask.reject(expectedError);
		await expect(firstRun).rejects.toBe(expectedError);
		await expect(secondRun).resolves.toBe('second-completed');
		expect(secondTaskStarted).toBe(true);
		expect(scheduler.state().execution).toEqual({ activeTasks: 0, queuedTasks: 0 });
	});

	it.each(['heartbeat', 'safety-cancel', 'recovery-admission'] as const)(
		'runs %s outside saturated bulk lanes and reports a met deadline',
		async (deadlineKind) => {
			const runtime = createManualDeadlineRuntime();
			const scheduler = createControllerExecutionWorkScheduler({
				deadlinesMs: { heartbeat: 50, 'recovery-admission': 75, 'safety-cancel': 60 },
				limits: {
					codec: { maxConcurrentTasks: 1, maxQueuedTasks: 1 },
					execution: { maxConcurrentTasks: 1, maxQueuedTasks: 1 },
				},
				runtime,
			});
			const heldTasks = [
				createDeferredTask(),
				createDeferredTask(),
				createDeferredTask(),
				createDeferredTask(),
			] as const;
			const saturatedRuns = [
				scheduler.runBulkTask('execution', async () => await heldTasks[0].promise),
				scheduler.runBulkTask('execution', async () => await heldTasks[1].promise),
				scheduler.runBulkTask('codec', async () => await heldTasks[2].promise),
				scheduler.runBulkTask('codec', async () => await heldTasks[3].promise),
			];

			const result = await scheduler.runCriticalTask(deadlineKind, async (): Promise<string> => {
				runtime.advanceBy(5);
				return 'delivered';
			});

			expect(result).toEqual({
				completedInMs: 5,
				kind: deadlineKind,
				met: true,
				value: 'delivered',
			});
			for (const task of heldTasks) task.resolve();
			await Promise.all(saturatedRuns);
		},
	);

	it('reports a missed critical deadline and safely ignores late task completion', async () => {
		const runtime = createManualDeadlineRuntime();
		const scheduler = createControllerExecutionWorkScheduler({
			deadlinesMs: { heartbeat: 10, 'recovery-admission': 10, 'safety-cancel': 10 },
			limits: {
				codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
				execution: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
			},
			runtime,
		});
		const lateTask = createDeferredTask<string>();
		const resultPromise = scheduler.runCriticalTask(
			'heartbeat',
			async (): Promise<string> => await lateTask.promise,
		);

		runtime.advanceToNextDeadline();
		await expect(resultPromise).resolves.toEqual({
			completedInMs: 10,
			kind: 'heartbeat',
			met: false,
		});
		lateTask.resolve('too-late');
		await flushScheduledWork();
	});

	it('handles a late critical task rejection after returning the deadline result', async () => {
		const runtime = createManualDeadlineRuntime();
		const scheduler = createControllerExecutionWorkScheduler({
			deadlinesMs: { heartbeat: 10, 'recovery-admission': 10, 'safety-cancel': 10 },
			limits: {
				codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
				execution: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
			},
			runtime,
		});
		const lateTask = createDeferredTask<string>();
		const resultPromise = scheduler.runCriticalTask(
			'safety-cancel',
			async (): Promise<string> => await lateTask.promise,
		);

		runtime.advanceToNextDeadline();
		await expect(resultPromise).resolves.toMatchObject({
			kind: 'safety-cancel',
			met: false,
		});
		lateTask.reject(new Error('late-task-failure'));
		await flushScheduledWork();
	});

	it('rejects with the original critical task error and ignores its later deadline callback', async () => {
		const runtime = createManualDeadlineRuntime();
		const scheduler = createControllerExecutionWorkScheduler({
			deadlinesMs: { heartbeat: 10, 'recovery-admission': 10, 'safety-cancel': 10 },
			limits: {
				codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
				execution: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
			},
			runtime,
		});
		const expectedError = new Error('heartbeat-failed');
		const resultPromise = scheduler.runCriticalTask('heartbeat', async (): Promise<never> => {
			throw expectedError;
		});

		await expect(resultPromise).rejects.toBe(expectedError);
		runtime.advanceToNextDeadline();
	});
});
