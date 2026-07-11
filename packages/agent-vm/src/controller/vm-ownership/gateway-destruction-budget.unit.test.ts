import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayDestructionBudget,
	GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS,
	GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
	GatewayDestructionTimeoutError,
	type GatewayDestructionBudgetClock,
} from './gateway-destruction-budget.js';

interface DeferredPromise<TValue> {
	readonly promise: Promise<TValue>;
	reject(error: unknown): void;
	resolve(value: TValue): void;
}

function createDeferredPromise<TValue>(): DeferredPromise<TValue> {
	let rejectPromise: ((error: unknown) => void) | undefined;
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return {
		promise,
		reject(error): void {
			rejectPromise?.(error);
		},
		resolve(value): void {
			resolvePromise?.(value);
		},
	};
}

interface ScheduledTimer {
	readonly callback: () => void;
	cleared: boolean;
	readonly delayMs: number;
	readonly timer: NodeJS.Timeout;
}

function createManualClock(): GatewayDestructionBudgetClock & {
	readonly clearTimeoutMock: ReturnType<
		typeof vi.fn<GatewayDestructionBudgetClock['clearTimeout']>
	>;
	readonly scheduledTimers: ScheduledTimer[];
	readonly setTimeoutMock: ReturnType<typeof vi.fn<GatewayDestructionBudgetClock['setTimeout']>>;
	fireNext(delayMs: number): void;
} {
	const scheduledTimers: ScheduledTimer[] = [];
	const setTimeoutMock = vi.fn((callback: () => void, delayMs: number): NodeJS.Timeout => {
		const timer = { hasRef: () => false } as unknown as NodeJS.Timeout;
		scheduledTimers.push({ callback, cleared: false, delayMs, timer });
		return timer;
	});
	const clearTimeoutMock = vi.fn((timer: NodeJS.Timeout): void => {
		const scheduledTimer = scheduledTimers.find((candidate) => candidate.timer === timer);
		if (scheduledTimer !== undefined) {
			scheduledTimer.cleared = true;
		}
	});
	return {
		clearTimeout: clearTimeoutMock,
		clearTimeoutMock,
		fireNext(delayMs): void {
			const scheduledTimer = scheduledTimers.find(
				(candidate) => candidate.delayMs === delayMs && !candidate.cleared,
			);
			if (scheduledTimer === undefined) {
				throw new Error(`No active ${String(delayMs)}ms timer was scheduled.`);
			}
			scheduledTimer.callback();
		},
		scheduledTimers,
		setTimeout: setTimeoutMock,
		setTimeoutMock,
	};
}

describe('Gateway destruction budget', () => {
	it('returns a target result and clears its 60-second timer', async () => {
		// Arrange
		const clock = createManualClock();
		const budget = createGatewayDestructionBudget({ clock });
		const operation = vi.fn(async () => 'destroyed');

		// Act
		const result = await budget.runTarget("tool VM 'tool-vm-a'", operation);

		// Assert
		expect(result).toBe('destroyed');
		expect(operation).toHaveBeenCalledOnce();
		expect(clock.setTimeoutMock).toHaveBeenCalledWith(
			expect.any(Function),
			GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS,
		);
		expect(clock.clearTimeoutMock).toHaveBeenCalledOnce();
		expect(clock.scheduledTimers).toEqual([
			expect.objectContaining({
				cleared: true,
				delayMs: GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS,
			}),
		]);
	});

	it.each(['resolve', 'reject'] as const)(
		'times out one target at 60 seconds and safely observes its late %s',
		async (lateOutcome) => {
			// Arrange
			const clock = createManualClock();
			const budget = createGatewayDestructionBudget({ clock });
			const deferred = createDeferredPromise<string>();
			const destruction = budget.runTarget(
				"tool VM 'tool-vm-timeout'",
				async () => await deferred.promise,
			);

			// Act
			clock.fireNext(GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS);

			// Assert
			await expect(destruction).rejects.toEqual(
				expect.objectContaining({
					code: 'GATEWAY_DESTRUCTION_TARGET_TIMEOUT',
					target: "tool VM 'tool-vm-timeout'",
					timeoutMs: GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS,
				}),
			);
			if (lateOutcome === 'resolve') {
				deferred.resolve('late destroy result');
			} else {
				deferred.reject(new Error('late destroy rejection'));
			}
			await Promise.resolve();
			await Promise.resolve();
			expect(clock.clearTimeoutMock).toHaveBeenCalledOnce();
		},
	);

	it('aborts the subtree at 300 seconds and keeps every later expiry check failed', async () => {
		// Arrange
		const clock = createManualClock();
		const budget = createGatewayDestructionBudget({ clock });
		const deferred = createDeferredPromise<string>();
		const attempt = budget.createSubtreeAttempt();
		let operationSignal: AbortSignal | undefined;
		const destruction = attempt.runSubtree(async (signal) => {
			operationSignal = signal;
			return await deferred.promise;
		});
		await Promise.resolve();

		// Act
		clock.fireNext(GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS);

		// Assert
		await expect(destruction).rejects.toEqual(
			expect.objectContaining({
				code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
				target: 'Gateway subtree',
				timeoutMs: GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
			}),
		);
		expect(operationSignal).toBe(attempt.signal);
		expect(attempt.signal.aborted).toBe(true);
		expect(attempt.signal.reason).toBeInstanceOf(GatewayDestructionTimeoutError);
		expect(() => attempt.throwIfExpired('before Gateway close')).toThrowError(
			expect.objectContaining({ code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT' }),
		);

		deferred.resolve('late subtree result');
		await Promise.resolve();
		await Promise.resolve();
		expect(clock.clearTimeoutMock).toHaveBeenCalledOnce();
	});
});
