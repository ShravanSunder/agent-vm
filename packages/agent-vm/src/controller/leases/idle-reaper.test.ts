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
					scopeKey: 'agent:shravan',
				},
				{
					id: 'lease-active',
					lastUsedAt: 9_500,
					scopeKey: 'agent:shravan',
				},
			],
			now: () => 10_000,
			releaseLease,
			ttlForLease: () => 5_000,
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
					lastUsedAt: 1_000,
					scopeKey: 'agent:shravan',
				},
				{
					id: 'lease-expired-2',
					lastUsedAt: 2_000,
					scopeKey: 'agent:shravan',
				},
				{
					id: 'lease-active',
					lastUsedAt: 9_900,
					scopeKey: 'agent:shravan',
				},
			],
			now: () => 10_000,
			releaseLease,
			ttlForLease: () => 5_000,
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
			await new Promise((resolve) => setTimeout(resolve, 0));
			activeReleases -= 1;
		});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{ id: 'lease-expired-1', lastUsedAt: 1_000, scopeKey: 'agent:shravan' },
				{ id: 'lease-expired-2', lastUsedAt: 2_000, scopeKey: 'agent:shravan' },
			],
			now: () => 10_000,
			releaseLease,
			ttlForLease: () => 5_000,
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
					lastUsedAt: 9_995,
					scopeKey: 'agent:shravan',
				},
				{
					id: 'lease-active-2',
					lastUsedAt: 9_999,
					scopeKey: 'agent:shravan',
				},
			],
			now: () => 10_000,
			releaseLease,
			ttlForLease: () => 5_000,
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).not.toHaveBeenCalled();
	});

	it('uses a separate TTL for each lease scope', async () => {
		const releaseLease = vi.fn(async () => {});
		const idleReaper = createIdleReaper({
			getLeases: () => [
				{
					id: 'short-agent-lease',
					lastUsedAt: 9_000,
					scopeKey: 'agent:short',
				},
				{
					id: 'long-agent-lease',
					lastUsedAt: 9_000,
					scopeKey: 'agent:long',
				},
			],
			now: () => 10_000,
			releaseLease,
			ttlForLease: (lease) => (lease.scopeKey === 'agent:short' ? 500 : 5_000),
		});

		await idleReaper.reapExpiredLeases();

		expect(releaseLease).toHaveBeenCalledTimes(1);
		expect(releaseLease).toHaveBeenCalledWith('short-agent-lease', {
			ifLastUsedAtBeforeOrAt: 9_500,
		});
	});
});
