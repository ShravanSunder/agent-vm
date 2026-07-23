import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const agentVmCliPath = path.join(
	repoRoot,
	'packages',
	'agent-vm',
	'dist',
	'cli',
	'agent-vm-entrypoint.js',
);
const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories
			.splice(0)
			.map(async (directoryPath) => await rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('smoke: generated agent-vm config validation', () => {
	it('initializes and validates a config with root-derived controller storage', async () => {
		// Arrange
		const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-init-validate-cli-'));
		createdDirectories.push(targetDirectory);

		// Act
		await execa(
			'node',
			[
				agentVmCliPath,
				'init',
				'worker-zone',
				'--type',
				'worker',
				'--secrets',
				'environment',
				'--arch',
				process.arch === 'arm64' ? 'aarch64' : 'x86_64',
				'--paths',
				'local',
			],
			{ cwd: targetDirectory, reject: true, timeout: 30_000 },
		);
		const generatedConfigText = await readFile(
			path.join(targetDirectory, 'config', 'system.jsonc'),
			'utf8',
		);
		const validationResult = await execa(
			'node',
			[agentVmCliPath, 'validate', '--config', 'config/system.jsonc'],
			{ cwd: targetDirectory, reject: false, timeout: 30_000 },
		);

		// Assert
		expect(generatedConfigText).toMatch(
			/"storageRootDir": "\.\.\/\.agent-vm\/[a-z0-9][a-z0-9-]*-[a-f0-9]{8}"/u,
		);
		expect(validationResult.exitCode).toBe(0);
	});
});
