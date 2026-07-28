import { describe, expect, it } from 'vitest';

import { WorkspaceGitOperationLocks } from './workspace-git-operation-locks.js';

describe('WorkspaceGitOperationLocks', () => {
	it('serializes one agent workspace without blocking another agent', async () => {
		const locks = new WorkspaceGitOperationLocks();
		const events: string[] = [];
		let releaseAlice: (() => void) | undefined;
		const aliceWorkspace = {
			agentId: 'alice',
			resourceKind: 'workspace' as const,
			zoneId: 'gateway',
		};

		const firstAliceOperation = locks.runExclusive(aliceWorkspace, async () => {
			events.push('alice:first:start');
			await new Promise<void>((resolve) => {
				releaseAlice = resolve;
			});
			events.push('alice:first:end');
			return 'first';
		});
		const secondAliceOperation = locks.runExclusive(aliceWorkspace, async () => {
			events.push('alice:second:start');
			return 'second';
		});
		const bobOperation = locks.runExclusive(
			{ agentId: 'bob', resourceKind: 'workspace', zoneId: 'gateway' },
			async () => {
				events.push('bob:start');
				return 'bob';
			},
		);

		await expect(bobOperation).resolves.toBe('bob');
		expect(events).toEqual(['alice:first:start', 'bob:start']);
		if (releaseAlice === undefined) {
			throw new Error('Expected the first Alice operation to start.');
		}
		releaseAlice();
		await expect(firstAliceOperation).resolves.toBe('first');
		await expect(secondAliceOperation).resolves.toBe('second');
		expect(events).toEqual([
			'alice:first:start',
			'bob:start',
			'alice:first:end',
			'alice:second:start',
		]);
	});
});
