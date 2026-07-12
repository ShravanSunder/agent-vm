import { describe, expect, it, vi } from 'vitest';

import {
	createToolVmActiveUseHandle,
	createToolVmActiveUseId,
	isToolVmActiveUseId,
} from './tool-vm-active-use.js';

describe('tool VM active-use helpers', () => {
	it('creates UUIDv7 active-use ids and rejects UUIDv4 ids', () => {
		const useId = createToolVmActiveUseId();

		expect(isToolVmActiveUseId(useId)).toBe(true);
		expect(isToolVmActiveUseId('1b5c5d78-91b4-4c8e-a15e-f475dced59ef')).toBe(false);
		expect(isToolVmActiveUseId('not-a-uuid')).toBe(false);
	});

	it('starts heartbeats and ends once during disposal', async () => {
		vi.useFakeTimers();
		try {
			const startActiveUse = vi.fn(async () => ({
				expiresAt: 10_000,
				heartbeatAfterMs: 1_000,
				useId: '01890f00-0000-7000-8000-000000000000',
			}));
			const heartbeatActiveUse = vi.fn(async () => ({
				expiresAt: 11_000,
				heartbeatAfterMs: 1_000,
			}));
			const endActiveUse = vi.fn(async () => {});

			const handle = await createToolVmActiveUseHandle({
				correlation: { toolCallId: 'tool-call-123' },
				endActiveUse,
				heartbeatActiveUse,
				heartbeatJitterRatio: 0,
				startActiveUse,
			});

			await vi.advanceTimersByTimeAsync(1_000);
			await handle.dispose('completed');
			await handle.dispose('completed');
			await vi.advanceTimersByTimeAsync(2_000);

			expect(startActiveUse).toHaveBeenCalledWith(
				expect.objectContaining({
					correlation: { toolCallId: 'tool-call-123' },
					useId: expect.any(String),
				}),
			);
			expect(heartbeatActiveUse).toHaveBeenCalledTimes(1);
			expect(endActiveUse).toHaveBeenCalledTimes(1);
			expect(endActiveUse).toHaveBeenCalledWith('01890f00-0000-7000-8000-000000000000', {
				outcome: 'completed',
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('sends only the latest active-use operation report on heartbeat', async () => {
		const timers: (() => void)[] = [];
		const heartbeatActiveUse = vi.fn(async () => ({
			expiresAt: 10_000,
			heartbeatAfterMs: 1_000,
		}));
		const handle = await createToolVmActiveUseHandle({
			clearTimeoutImpl: vi.fn() as unknown as typeof clearTimeout,
			endActiveUse: vi.fn(async () => {}),
			heartbeatActiveUse,
			setTimeoutImpl: ((callback: () => void) => {
				timers.push(callback);
				return timers.length as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			startActiveUse: vi.fn(async () => ({
				expiresAt: 10_000,
				heartbeatAfterMs: 1_000,
				useId: '01890f00-0000-7000-8000-000000000000',
			})),
		});

		handle.report({
			observedAtMs: 1_000,
			phase: 'starting',
		});
		handle.report({
			observedAtMs: 1_001,
			phase: 'probe-succeeded',
			ssh: { probeSucceeded: true },
		});

		timers[0]?.();
		await Promise.resolve();

		expect(heartbeatActiveUse).toHaveBeenCalledWith('01890f00-0000-7000-8000-000000000000', {
			report: {
				observedAtMs: 1_001,
				phase: 'probe-succeeded',
				ssh: { probeSucceeded: true },
			},
		});
		await handle.dispose('completed');
	});

	it('ignores operation reports after disposal', async () => {
		const endActiveUse = vi.fn(async () => {});
		const handle = await createToolVmActiveUseHandle({
			clearTimeoutImpl: vi.fn() as unknown as typeof clearTimeout,
			endActiveUse,
			heartbeatActiveUse: vi.fn(async () => ({ expiresAt: 10_000, heartbeatAfterMs: 1_000 })),
			setTimeoutImpl: vi.fn() as unknown as typeof setTimeout,
			startActiveUse: vi.fn(async () => ({
				expiresAt: 10_000,
				heartbeatAfterMs: 1_000,
				useId: '01890f00-0000-7000-8000-000000000000',
			})),
		});

		await handle.dispose('completed');
		handle.report({
			observedAtMs: 1_000,
			phase: 'failed',
			ssh: {
				failure: {
					kind: 'ssh-command-failed',
					message: 'late report',
				},
			},
		});
		await handle.dispose('completed');

		expect(endActiveUse).toHaveBeenCalledWith('01890f00-0000-7000-8000-000000000000', {
			outcome: 'completed',
		});
	});

	it('applies deterministic heartbeat jitter and clears timers on dispose', async () => {
		const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;
		const setTimeoutImpl = vi.fn((callback: () => void, delayMs?: number) => {
			void callback;
			void delayMs;
			return 42 as unknown as ReturnType<typeof setTimeout>;
		}) as unknown as typeof setTimeout;
		const handle = await createToolVmActiveUseHandle({
			clearTimeoutImpl,
			endActiveUse: vi.fn(async () => {}),
			heartbeatActiveUse: vi.fn(async () => ({ expiresAt: 10_000, heartbeatAfterMs: 1_000 })),
			heartbeatJitterRatio: 0.2,
			randomImpl: () => 1,
			setTimeoutImpl,
			startActiveUse: vi.fn(async () => ({
				expiresAt: 10_000,
				heartbeatAfterMs: 1_000,
				useId: '01890f00-0000-7000-8000-000000000000',
			})),
		});

		expect(setTimeoutImpl).toHaveBeenCalledWith(expect.any(Function), 1_200);

		await handle.dispose('completed');

		expect(clearTimeoutImpl).toHaveBeenCalledWith(42);
	});

	it('stops heartbeat scheduling after a refreshable heartbeat failure', async () => {
		const timers: (() => void)[] = [];
		const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;
		const refreshableError = new Error('lease expired');
		const onRefreshableHeartbeatFailure = vi.fn(async () => {});
		const handle = await createToolVmActiveUseHandle({
			clearTimeoutImpl,
			endActiveUse: vi.fn(async () => {}),
			heartbeatActiveUse: vi.fn(async () => {
				throw refreshableError;
			}),
			isHeartbeatErrorRefreshable: () => true,
			onRefreshableHeartbeatFailure,
			setTimeoutImpl: ((callback: () => void) => {
				timers.push(callback);
				return timers.length as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			startActiveUse: vi.fn(async () => ({
				expiresAt: 10_000,
				heartbeatAfterMs: 1_000,
				useId: '01890f00-0000-7000-8000-000000000000',
			})),
		});

		timers[0]?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(onRefreshableHeartbeatFailure).toHaveBeenCalledWith(refreshableError);
		expect(timers).toHaveLength(1);

		await handle.dispose('failed');
	});

	it('aborts the operation signal after a refreshable heartbeat failure', async () => {
		const timers: (() => void)[] = [];
		const refreshableError = new Error('lease expired');
		const handle = await createToolVmActiveUseHandle({
			clearTimeoutImpl: vi.fn() as unknown as typeof clearTimeout,
			endActiveUse: vi.fn(async () => {}),
			heartbeatActiveUse: vi.fn(async () => {
				throw refreshableError;
			}),
			isHeartbeatErrorRefreshable: () => true,
			onRefreshableHeartbeatFailure: vi.fn(async () => {}),
			setTimeoutImpl: ((callback: () => void) => {
				timers.push(callback);
				return timers.length as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout,
			startActiveUse: vi.fn(async () => ({
				expiresAt: 10_000,
				heartbeatAfterMs: 1_000,
				useId: '01890f00-0000-7000-8000-000000000000',
			})),
		});

		timers[0]?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(handle.signal.aborted).toBe(true);
		expect(handle.signal.reason).toBe(refreshableError);
	});

	it('continues retrying heartbeat failures because active-use is an operation guard, not a VM health check', async () => {
		vi.useFakeTimers();
		try {
			const heartbeatFailure = new Error('temporary controller failure');
			const heartbeatActiveUse = vi
				.fn()
				.mockRejectedValueOnce(heartbeatFailure)
				.mockResolvedValueOnce({
					expiresAt: 12_000,
					heartbeatAfterMs: 1_000,
				});
			const logHeartbeatFailure = vi.fn();
			const handle = await createToolVmActiveUseHandle({
				endActiveUse: vi.fn(async () => {}),
				heartbeatActiveUse,
				heartbeatJitterRatio: 0,
				logHeartbeatFailure,
				startActiveUse: vi.fn(async () => ({
					expiresAt: 10_000,
					heartbeatAfterMs: 1_000,
					useId: '01890f00-0000-7000-8000-000000000000',
				})),
			});

			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(1_000);
			await handle.dispose('completed');

			expect(heartbeatActiveUse).toHaveBeenCalledTimes(2);
			expect(logHeartbeatFailure).toHaveBeenCalledWith(heartbeatFailure);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops heartbeat scheduling after the configured max duration', async () => {
		vi.useFakeTimers();
		try {
			const heartbeatActiveUse = vi.fn(async () => ({
				expiresAt: 12_000,
				heartbeatAfterMs: 1_000,
			}));
			const handle = await createToolVmActiveUseHandle({
				endActiveUse: vi.fn(async () => {}),
				heartbeatActiveUse,
				heartbeatJitterRatio: 0,
				maxHeartbeatDurationMs: 1_500,
				startActiveUse: vi.fn(async () => ({
					expiresAt: 10_000,
					heartbeatAfterMs: 1_000,
					useId: '01890f00-0000-7000-8000-000000000000',
				})),
			});

			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(5_000);
			await handle.dispose('completed');

			expect(heartbeatActiveUse).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
