import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { applyEdits, modify } from 'jsonc-parser';
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
	it('rejects the generated zone namespace before writing a scaffold', async () => {
		const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-init-reserved-'));
		createdDirectories.push(targetDirectory);

		const result = await execa(
			'node',
			[
				agentVmCliPath,
				'init',
				'generated',
				'--type',
				'hermes',
				'--secrets',
				'environment',
				'--paths',
				'local',
			],
			{ cwd: targetDirectory, reject: false, timeout: 30_000 },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain('reserved for global storage');
		await expect(readdir(targetDirectory)).resolves.toEqual([]);
	});

	it('rejects a saved legacy Worker config through the built validate command', async () => {
		// Arrange
		const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-legacy-worker-'));
		createdDirectories.push(targetDirectory);
		await execa(
			'node',
			[
				agentVmCliPath,
				'init',
				'legacy-worker-zone',
				'--type',
				'hermes',
				'--secrets',
				'environment',
				'--arch',
				process.arch === 'arm64' ? 'aarch64' : 'x86_64',
				'--paths',
				'local',
			],
			{ cwd: targetDirectory, reject: true, timeout: 30_000 },
		);
		const systemConfigPath = path.join(targetDirectory, 'config', 'system.jsonc');
		const generatedConfigText = await readFile(systemConfigPath, 'utf8');
		const legacyWorkerConfigText = applyEdits(
			generatedConfigText,
			modify(generatedConfigText, ['zones', 0, 'gateway', 'type'], 'worker', {
				formattingOptions: { insertSpaces: false, tabSize: 1 },
			}),
		);
		await writeFile(systemConfigPath, legacyWorkerConfigText, 'utf8');

		// Act
		const validationResult = await execa(
			'node',
			[agentVmCliPath, 'validate', '--config', 'config/system.jsonc'],
			{ cwd: targetDirectory, reject: false, timeout: 30_000 },
		);

		// Assert
		expect(legacyWorkerConfigText).toContain('"type": "worker"');
		expect(validationResult.exitCode).toBe(1);
		expect(validationResult.stderr).toContain('Invalid config/system.jsonc configuration:');
		expect(validationResult.stderr).toContain('zones[0].gateway.type');
		expect(validationResult.stderr).toContain('expected "hermes"');
	});

	it.each([
		{ name: 'default Hermes', gatewayArguments: [] },
		{ name: 'explicit Hermes', gatewayArguments: ['--type', 'hermes'] },
	])(
		'initializes and validates $name with root-derived controller storage',
		async ({ gatewayArguments }) => {
			// Arrange
			const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-init-validate-cli-'));
			createdDirectories.push(targetDirectory);

			// Act
			await execa(
				'node',
				[
					agentVmCliPath,
					'init',
					'hermes-zone',
					...gatewayArguments,
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
			expect(generatedConfigText).toContain('"type": "hermes"');
			expect(validationResult.exitCode).toBe(0);
		},
	);
});
