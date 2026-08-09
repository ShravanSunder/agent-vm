import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const agentVmCliEntrypointPath = path.join(
	repositoryRoot,
	'packages',
	'agent-vm',
	'src',
	'cli',
	'agent-vm-entrypoint.ts',
);

describe('retired whole-zone Git CLI', () => {
	it('rejects the removed zone-git command at the CLI process boundary', async () => {
		// Arrange
		const retiredCommandArguments = ['zone-git', 'status', '--zone', 'sunfam'] as const;

		// Act
		const commandResult = await execa(
			'pnpm',
			['exec', 'tsx', agentVmCliEntrypointPath, ...retiredCommandArguments],
			{
				reject: false,
				timeout: 30_000,
			},
		);

		// Assert
		expect(commandResult.exitCode).not.toBe(0);
		expect(commandResult.stderr).toContain('Unexpected option or subcommand');
		expect(commandResult.stderr).toContain('zone-git');
	});
});
