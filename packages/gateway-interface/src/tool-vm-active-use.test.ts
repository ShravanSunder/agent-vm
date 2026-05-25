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
				correlation: { toolName: 'shell' },
				endActiveUse,
				heartbeatActiveUse,
				startActiveUse,
			});

			await vi.advanceTimersByTimeAsync(1_000);
			await handle.dispose('completed');
			await handle.dispose('completed');
			await vi.advanceTimersByTimeAsync(2_000);

			expect(startActiveUse).toHaveBeenCalledWith(
				expect.objectContaining({
					correlation: { toolName: 'shell' },
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
