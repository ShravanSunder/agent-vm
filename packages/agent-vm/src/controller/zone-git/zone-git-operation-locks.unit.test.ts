import { describe, expect, it } from 'vitest';

import { ZoneGitOperationLocks } from './zone-git-operation-locks.js';

describe('ZoneGitOperationLocks', () => {
	it('serializes operations for the same zone without blocking other zones', async () => {
		const locks = new ZoneGitOperationLocks();
		const events: string[] = [];
		let releaseSunfam: (() => void) | undefined;

		const firstSunfamOperation = locks.runExclusive('sunfam', async () => {
			events.push('sunfam:first:start');
			await new Promise<void>((resolve) => {
				releaseSunfam = resolve;
			});
			events.push('sunfam:first:end');
			return 'first';
		});
		const secondSunfamOperation = locks.runExclusive('sunfam', async () => {
			events.push('sunfam:second:start');
			return 'second';
		});
		const workOperation = locks.runExclusive('work', async () => {
			events.push('work:start');
			return 'work';
		});

		await expect(workOperation).resolves.toBe('work');
		expect(events).toEqual(['sunfam:first:start', 'work:start']);
		if (!releaseSunfam) {
			throw new Error('Expected first sunfam operation to start.');
		}
		releaseSunfam();
		await expect(firstSunfamOperation).resolves.toBe('first');
		await expect(secondSunfamOperation).resolves.toBe('second');
		expect(events).toEqual([
			'sunfam:first:start',
			'work:start',
			'sunfam:first:end',
			'sunfam:second:start',
		]);
	});
});
