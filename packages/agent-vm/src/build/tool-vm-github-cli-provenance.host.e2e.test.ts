import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function runCommand(
	command: string,
	arguments_: readonly string[],
): Promise<{ readonly stderr: string; readonly stdout: string }> {
	return await execFileAsync(command, [...arguments_], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024 * 10,
	});
}

describe('Tool VM GitHub CLI package provenance', () => {
	it('installs gh from GitHub stable apt', async () => {
		const imageTag = `agent-vm-tool-gh-provenance:${process.pid}`;

		try {
			await runCommand('docker', [
				'build',
				'--pull=false',
				'--tag',
				imageTag,
				'--file',
				'docker/base-images/tool-vm/Dockerfile',
				'.',
			]);

			const result = await runCommand('docker', [
				'run',
				'--rm',
				imageTag,
				'sh',
				'-lc',
				'gh --version && apt-get update >/dev/null && apt-cache policy gh',
				]);

				expect(result.stdout).toContain('gh version');
				expect(result.stdout).toMatch(
					/\*\*\* [^\n]+\n(?:\s+\d+ [^\n]+\n)*\s+\d+ https:\/\/cli\.github\.com\/packages/u,
				);
			} finally {
			await runCommand('docker', ['image', 'rm', '--force', imageTag]).catch(() => undefined);
		}
	});
});
