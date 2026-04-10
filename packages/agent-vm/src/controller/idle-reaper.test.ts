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
});
