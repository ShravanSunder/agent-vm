import { describe, expect, it, vi } from 'vitest';

import { createIdleReaper } from './idle-reaper.js';

describe('createIdleReaper', () => {
	it('releases leases whose lastUsedAt exceeds the ttl', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-expired',
					lastUsedAt: 1_000,
				},
				{
					id: 'lease-active',
					lastUsedAt: 9_500,
				},
			],
			now: () => 10_000,
			releaseLease,
			ttlMs: 5_000,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).toHaveBeenCalledTimes(1);
		expect(releaseLease).toHaveBeenCalledWith('lease-expired');
	});

	it('releases all expired leases in one reap cycle', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-expired-1',
					lastUsedAt: 1_000,
				},
				{
					id: 'lease-expired-2',
					lastUsedAt: 2_000,
				},
				{
					id: 'lease-active',
					lastUsedAt: 9_900,
				},
			],
			now: () => 10_000,
			releaseLease,
			ttlMs: 5_000,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).toHaveBeenCalledTimes(2);
		expect(releaseLease).toHaveBeenCalledWith('lease-expired-1');
		expect(releaseLease).toHaveBeenCalledWith('lease-expired-2');
	});

	it('does nothing when all leases are still active', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'lease-active-1',
					lastUsedAt: 9_995,
				},
				{
					id: 'lease-active-2',
					lastUsedAt: 9_999,
				},
			],
			now: () => 10_000,
			releaseLease,
			ttlMs: 5_000,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).not.toHaveBeenCalled();
	});
});
