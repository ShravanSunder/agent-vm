import { beforeEach, expect, it, vi } from 'vitest';

const executeCommand = vi.hoisted(() => vi.fn());
vi.mock('node:util', () => ({ promisify: () => executeCommand }));

import { ownedWorkerdPids } from '#worker-host/test-fixtures/workerd-socket-guard';

beforeEach(() => {
	executeCommand.mockReset();
});

it('selects only direct children named workerd and returns their sorted PIDs', async () => {
	executeCommand.mockResolvedValue({ stdout: '702\n701\n', stderr: '' });
	await expect(ownedWorkerdPids()).resolves.toEqual([701, 702]);
	expect(executeCommand).toHaveBeenCalledWith(
		'pgrep',
		['-P', String(process.pid), '-x', 'workerd'],
		{ timeout: 2000 },
	);
});

it('accepts only the empty no-match result as no owned workerd', async () => {
	executeCommand.mockRejectedValue({ code: 1, stdout: '', stderr: '' });
	await expect(ownedWorkerdPids()).resolves.toEqual([]);
	executeCommand.mockRejectedValue({ code: 1, stdout: '', stderr: 'query failed' });
	await expect(ownedWorkerdPids()).rejects.toThrow('query failed');
});

it('preserves timeout metadata without including process command arguments', async () => {
	executeCommand.mockRejectedValue({
		code: null,
		signal: 'SIGTERM',
		killed: true,
		stdout: 'unrelated-argument-canary',
		stderr: '',
	});
	await expect(ownedWorkerdPids()).rejects.toThrow('"signal":"SIGTERM","killed":true');
	await expect(ownedWorkerdPids()).rejects.not.toThrow('unrelated-argument-canary');
});

it('fails closed on malformed PID output', async () => {
	executeCommand.mockResolvedValue({ stdout: '0\nnot-a-pid\n', stderr: '' });
	await expect(ownedWorkerdPids()).rejects.toThrow('Owned workerd PID query failed');
});
