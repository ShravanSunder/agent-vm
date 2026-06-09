import { describe, expect, it, vi } from 'vitest';

import { createIdleReaper } from './idle-reaper.js';

describe('createIdleReaper', () => {
	it('releases leases whose lastUsedAt exceeds the ttl', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-expired',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 1_000,
				},
				{
					id: 'lease-active',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 9_500,
				},
			],
			now: () => 10_000,
			releaseLease,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).toHaveBeenCalledTimes(1);
		expect(releaseLease).toHaveBeenCalledWith('lease-expired', { ifLastUsedAtBeforeOrAt: 5_000 });
	});

	it('releases all expired leases in one reap cycle', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-expired-1',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 1_000,
				},
				{
					id: 'lease-expired-2',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 2_000,
				},
				{
					id: 'lease-active',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 9_900,
				},
			],
			now: () => 10_000,
			releaseLease,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).toHaveBeenCalledTimes(2);
		expect(releaseLease).toHaveBeenCalledWith('lease-expired-1', {
			ifLastUsedAtBeforeOrAt: 5_000,
		});
		expect(releaseLease).toHaveBeenCalledWith('lease-expired-2', {
			ifLastUsedAtBeforeOrAt: 5_000,
		});
	});

	it('releases expired leases sequentially', async () => {
		let activeReleases = 0;
		let maxConcurrentReleases = 0;
		const releaseLease = vi.fn(async () => {
			activeReleases += 1;
			maxConcurrentReleases = Math.max(maxConcurrentReleases, activeReleases);
			await new Promise<void>((resolve) => setImmediate(resolve));
			activeReleases -= 1;
		});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-expired-1',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 1_000,
				},
				{
					id: 'lease-expired-2',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 2_000,
				},
			],
			now: () => 10_000,
			releaseLease,
		});

		await idleReaper.reapExpiredLeases();

		expect(maxConcurrentReleases).toBe(1);
	});

	it('does nothing when all leases are still active', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-active-1',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 9_995,
				},
				{
					id: 'lease-active-2',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 9_999,
				},
			],
			now: () => 10_000,
			releaseLease,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).not.toHaveBeenCalled();
	});

	it('uses each lease effective TTL independently', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'short-agent-lease',
					activeUseCount: 0,
					effectiveIdleTtlMs: 500,
					lastUsedAt: 9_000,
				},
				{
					id: 'long-agent-lease',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 9_000,
				},
			],
			now: () => 10_000,
			releaseLease,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).toHaveBeenCalledTimes(1);
		expect(releaseLease).toHaveBeenCalledWith('short-agent-lease', {
			ifLastUsedAtBeforeOrAt: 9_500,
		});
	});

	it('continues releasing expired leases after one release fails', async () => {
		const releaseLease = vi.fn(async (leaseId: string) => {
			if (leaseId === 'lease-expired-1') {
				throw new Error('release failed');
			}
		});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-expired-1',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 1_000,
				},
				{
					id: 'lease-expired-2',
					activeUseCount: 0,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 2_000,
				},
			],
			now: () => 10_000,
			releaseLease,
		});

		let aggregateError: unknown;
		try {
			await idleReaper.reapExpiredLeases();
		} catch (error) {
			aggregateError = error;
		}

		expect(aggregateError).toBeInstanceOf(AggregateError);
		expect(aggregateError).toMatchObject({
			message: 'Failed to release 1 expired lease(s).',
			errors: [
				expect.objectContaining({
					message: "Failed to release expired lease 'lease-expired-1': release failed",
				}),
			],
		});
		expect(releaseLease).toHaveBeenCalledTimes(2);
		expect(releaseLease).toHaveBeenCalledWith('lease-expired-2', {
			ifLastUsedAtBeforeOrAt: 5_000,
		});
	});

	it('skips expired leases while active uses are present', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-expired-but-active',
					activeUseCount: 1,
					effectiveIdleTtlMs: 5_000,
					lastUsedAt: 1_000,
				},
			],
			now: () => 10_000,
			releaseLease,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).not.toHaveBeenCalled();
	});
});
