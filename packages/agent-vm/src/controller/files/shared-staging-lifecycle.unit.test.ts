import { describe, expect, it, vi } from 'vitest';

import { createSharedStagingLifecycle } from './shared-staging-lifecycle.js';

const receiver = { leaseId: 'lease-a', leafGeneration: 'leaf-a', vmId: 'vm-a' };

describe('shared staging directory lifetime', () => {
	it('expires exactly one hour after publication without extending on lookup', async () => {
		// Arrange
		let nowMs = 1000;
		const remove = vi.fn(async () => {});
		const lifecycle = createSharedStagingLifecycle({ now: () => nowMs });
		const published = lifecycle.track({ publicationId: 'publication', receiver, remove });
		// Act / Assert
		expect(published.expiresAtMs).toBe(3_601_000);
		nowMs = 3_600_999;
		expect(lifecycle.lookup('publication', receiver)).toEqual(published);
		await lifecycle.reapExpired();
		expect(remove).not.toHaveBeenCalled();
		nowMs++;
		expect(lifecycle.lookup('publication', receiver)).toBeUndefined();
		expect(await lifecycle.reapExpired()).toEqual({ removed: 1, pending: 0 });
		expect(remove).toHaveBeenCalledOnce();
	});

	it('receiver retirement removes only its exact generation', async () => {
		// Arrange
		const lifecycle = createSharedStagingLifecycle({ now: () => 0 });
		const removeFirst = vi.fn(async () => {});
		const removeOther = vi.fn(async () => {});
		const otherReceiver = { ...receiver, leafGeneration: 'leaf-b', vmId: 'vm-b' };
		lifecycle.track({ publicationId: 'first', receiver, remove: removeFirst });
		lifecycle.track({ publicationId: 'other', receiver: otherReceiver, remove: removeOther });
		// Act
		expect(await lifecycle.retireReceiver(receiver)).toEqual({ removed: 1, pending: 0 });
		// Assert
		expect(removeFirst).toHaveBeenCalledOnce();
		expect(removeOther).not.toHaveBeenCalled();
		expect(lifecycle.lookup('other', otherReceiver)).toBeDefined();
		expect(lifecycle.lookup('other', receiver)).toBeUndefined();
	});

	it('keeps failed deletion unavailable and retries it on the reaper', async () => {
		// Arrange
		const lifecycle = createSharedStagingLifecycle({ now: () => 0 });
		const remove = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('busy'))
			.mockResolvedValue(undefined);
		lifecycle.track({ publicationId: 'publication', receiver, remove });
		// Act / Assert
		expect(await lifecycle.retireReceiver(receiver)).toEqual({ removed: 0, pending: 1 });
		expect(lifecycle.lookup('publication', receiver)).toBeUndefined();
		expect(await lifecycle.reapExpired()).toEqual({ removed: 1, pending: 0 });
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it('coalesces overlapping cleanup attempts and does not release before deletion', async () => {
		// Arrange
		const deletion = Promise.withResolvers<void>();
		const remove = vi.fn(() => deletion.promise);
		const lifecycle = createSharedStagingLifecycle({ now: () => 0 });
		lifecycle.track({ publicationId: 'publication', receiver, remove });
		// Act
		const first = lifecycle.retireReceiver(receiver);
		const second = lifecycle.reapExpired();
		await Promise.resolve();
		// Assert
		expect(lifecycle.lookup('publication', receiver)).toBeUndefined();
		expect(remove).toHaveBeenCalledOnce();
		deletion.resolve();
		await expect(first).resolves.toEqual({ removed: 1, pending: 0 });
		await expect(second).resolves.toEqual({ removed: 1, pending: 0 });
		expect(await lifecycle.reapExpired()).toEqual({ removed: 0, pending: 0 });
	});

	it('copies receiver identity and rejects duplicate publication registration', () => {
		// Arrange
		const lifecycle = createSharedStagingLifecycle({ now: () => 0 });
		const mutableReceiver = { ...receiver };
		const remove = vi.fn(async () => {});
		lifecycle.track({ publicationId: 'publication', receiver: mutableReceiver, remove });
		// Act / Assert
		mutableReceiver.vmId = 'other';
		expect(lifecycle.lookup('publication', receiver)).toBeDefined();
		expect(() => lifecycle.track({ publicationId: 'publication', receiver, remove })).toThrow();
	});
});
