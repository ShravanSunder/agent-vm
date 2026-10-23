import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { expect, it } from 'vitest';

import { ownedWorkerdPids } from '#worker-host/test-fixtures/workerd-socket-guard';

it('inspects owned workerd processes without buffering unrelated large command arguments', async () => {
	const children: ChildProcess[] = [];
	try {
		await Promise.all(
			Array.from({ length: 12 }, async () => {
				const child = fork(
					new URL('./test-fixtures/process-table-noise.ts', import.meta.url),
					['x'.repeat(100_000)],
					{
						execArgv: [],
						stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
					},
				);
				children.push(child);
				expect((await once(child, 'message'))[0]).toBe('ready');
			}),
		);
		await expect(ownedWorkerdPids()).resolves.toEqual([]);
	} finally {
		await Promise.all(
			children.map(async (child) => {
				const exited = once(child, 'exit');
				child.disconnect();
				await exited;
			}),
		);
	}
});
