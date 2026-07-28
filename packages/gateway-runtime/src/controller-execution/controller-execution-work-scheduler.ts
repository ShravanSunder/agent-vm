export type ControllerExecutionBulkWorkKind = 'codec' | 'execution';

export type ControllerExecutionCriticalWorkKind =
	| 'heartbeat'
	| 'recovery-admission'
	| 'safety-cancel';

export interface ControllerExecutionWorkLaneLimits {
	readonly maxConcurrentTasks: number;
	readonly maxQueuedTasks: number;
}

export interface ControllerExecutionWorkLaneState {
	readonly activeTasks: number;
	readonly queuedTasks: number;
}

interface PendingWorkTask {
	readonly complete: () => void;
	readonly run: () => Promise<void>;
}

interface MutableWorkLane {
	activeTasks: number;
	readonly limits: ControllerExecutionWorkLaneLimits;
	readonly queuedTasks: PendingWorkTask[];
}

export interface CreateControllerExecutionWorkSchedulerOptions {
	readonly deadlinesMs: Readonly<Record<ControllerExecutionCriticalWorkKind, number>>;
	readonly limits: Readonly<
		Record<ControllerExecutionBulkWorkKind, ControllerExecutionWorkLaneLimits>
	>;
	readonly runtime: {
		readonly clock: { readonly now: () => number };
		readonly scheduler: {
			readonly schedule: (callback: () => void, delayMs: number) => void;
		};
	};
}

export interface ControllerExecutionCriticalTaskResult<TValue> {
	readonly completedInMs: number;
	readonly kind: ControllerExecutionCriticalWorkKind;
	readonly met: boolean;
	readonly value?: TValue;
}

export interface ControllerExecutionWorkScheduler {
	readonly runBulkTask: <TValue>(
		kind: ControllerExecutionBulkWorkKind,
		run: () => Promise<TValue>,
	) => Promise<TValue>;
	readonly runCriticalTask: <TValue>(
		kind: ControllerExecutionCriticalWorkKind,
		run: () => Promise<TValue>,
	) => Promise<ControllerExecutionCriticalTaskResult<TValue>>;
	readonly state: () => Readonly<
		Record<ControllerExecutionBulkWorkKind, ControllerExecutionWorkLaneState>
	>;
}

export class ControllerExecutionWorkCapacityError extends Error {
	readonly workKind: ControllerExecutionBulkWorkKind;

	constructor(workKind: ControllerExecutionBulkWorkKind) {
		super(`Controller execution ${workKind} work reached its configured capacity.`);
		this.name = 'ControllerExecutionWorkCapacityError';
		this.workKind = workKind;
	}
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer.`);
	}
}

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer.`);
	}
}

function createWorkLane(limits: ControllerExecutionWorkLaneLimits): MutableWorkLane {
	return { activeTasks: 0, limits, queuedTasks: [] };
}

function startNextTask(lane: MutableWorkLane): void {
	while (lane.activeTasks < lane.limits.maxConcurrentTasks && lane.queuedTasks.length > 0) {
		const pendingTask = lane.queuedTasks.shift();
		if (pendingTask === undefined) return;
		lane.activeTasks += 1;
		void Promise.resolve()
			.then(pendingTask.run)
			.finally((): void => {
				lane.activeTasks -= 1;
				startNextTask(lane);
				pendingTask.complete();
			});
	}
}

export function createControllerExecutionWorkScheduler(
	options: CreateControllerExecutionWorkSchedulerOptions,
): ControllerExecutionWorkScheduler {
	for (const workKind of ['codec', 'execution'] as const) {
		requirePositiveSafeInteger(
			options.limits[workKind].maxConcurrentTasks,
			`${workKind}.maxConcurrentTasks`,
		);
		requireNonNegativeSafeInteger(
			options.limits[workKind].maxQueuedTasks,
			`${workKind}.maxQueuedTasks`,
		);
	}
	for (const deadlineKind of ['heartbeat', 'recovery-admission', 'safety-cancel'] as const) {
		requirePositiveSafeInteger(options.deadlinesMs[deadlineKind], `${deadlineKind} deadline`);
	}

	const lanes = {
		codec: createWorkLane(options.limits.codec),
		execution: createWorkLane(options.limits.execution),
	} satisfies Record<ControllerExecutionBulkWorkKind, MutableWorkLane>;

	return {
		runBulkTask: <TValue>(
			kind: ControllerExecutionBulkWorkKind,
			run: () => Promise<TValue>,
		): Promise<TValue> => {
			const lane = lanes[kind];
			if (
				lane.activeTasks >= lane.limits.maxConcurrentTasks &&
				lane.queuedTasks.length >= lane.limits.maxQueuedTasks
			) {
				return Promise.reject(new ControllerExecutionWorkCapacityError(kind));
			}
			return new Promise<TValue>((resolve, reject) => {
				let completeTask = (): void => {
					reject(new Error('Controller execution work completed without a recorded outcome.'));
				};
				lane.queuedTasks.push({
					complete: (): void => completeTask(),
					run: async (): Promise<void> => {
						try {
							const value = await run();
							completeTask = (): void => resolve(value);
						} catch (error: unknown) {
							completeTask = (): void => reject(error);
						}
					},
				});
				startNextTask(lane);
			});
		},
		runCriticalTask: async <TValue>(
			kind: ControllerExecutionCriticalWorkKind,
			run: () => Promise<TValue>,
		): Promise<ControllerExecutionCriticalTaskResult<TValue>> => {
			const startedAtMs = options.runtime.clock.now();
			let settled = false;
			return await new Promise<ControllerExecutionCriticalTaskResult<TValue>>((resolve, reject) => {
				options.runtime.scheduler.schedule((): void => {
					if (settled) return;
					settled = true;
					resolve({
						completedInMs: options.runtime.clock.now() - startedAtMs,
						kind,
						met: false,
					});
				}, options.deadlinesMs[kind]);
				void Promise.resolve()
					.then(run)
					.then(
						(value): void => {
							if (settled) return;
							settled = true;
							const completedInMs = options.runtime.clock.now() - startedAtMs;
							resolve({
								completedInMs,
								kind,
								met: completedInMs <= options.deadlinesMs[kind],
								value,
							});
						},
						(error: unknown): void => {
							if (settled) return;
							settled = true;
							reject(error);
						},
					);
			});
		},
		state: () => ({
			codec: {
				activeTasks: lanes.codec.activeTasks,
				queuedTasks: lanes.codec.queuedTasks.length,
			},
			execution: {
				activeTasks: lanes.execution.activeTasks,
				queuedTasks: lanes.execution.queuedTasks.length,
			},
		}),
	};
}
