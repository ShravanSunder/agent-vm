import { expect, it } from 'vitest';
import { z } from 'zod';

import { runAuthProofProcess } from '#auth/test-fixtures/auth-proof-process';

const blockedChild = `process.on('SIGTERM', () => {}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`;
const pidSchema = z.object({ grandchild: z.number().int().positive() });

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
		throw error;
	}
}

it.each(['blocked-parent', 'normal-parent'] as const)(
	'process: owns and reaps a grandchild after %s termination',
	async (mode) => {
		const code = `
import { spawn } from 'node:child_process';
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(blockedChild)}], { stdio: 'ignore' });
process.on('SIGTERM', () => {});
process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\n', () => {
 ${mode === 'blocked-parent' ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);' : 'process.exit(0);'}
});`;
		const result = await runAuthProofProcess({
			command: process.execPath,
			args: ['--input-type=module', '-e', code],
			cwd: process.cwd(),
			env: process.env,
			timeoutMs: 2000,
			graceMs: 200,
		});
		const child = pidSchema.parse(JSON.parse(result.stdout.trim()));
		try {
			expect(result.ending.kind).toBe(mode === 'blocked-parent' ? 'timed-out' : 'exited');
			if (mode === 'normal-parent' && result.ending.kind === 'exited')
				expect(result.ending.code).toBe(0);
			expect(result.cleanup.signals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));
			expect(result.cleanup.remainingMembers).toEqual([]);
			// An independent OS probe must agree; the runner's own enumeration cannot certify itself.
			expect(processExists(child.grandchild)).toBe(false);
		} finally {
			if (processExists(child.grandchild)) process.kill(child.grandchild, 'SIGKILL');
		}
	},
	15_000,
);
