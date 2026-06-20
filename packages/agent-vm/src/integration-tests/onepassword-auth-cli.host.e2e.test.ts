import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

import { loadJsonConfigFile } from '../config/json-config-file.js';

const repoRoot = process.cwd();
const agentVmCliPath = path.join(
	repoRoot,
	'packages',
	'agent-vm',
	'dist',
	'cli',
	'agent-vm-entrypoint.js',
);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObjectField(
	record: Record<string, unknown>,
	fieldName: string,
): Record<string, unknown> {
	const value = record[fieldName];
	if (!isObjectRecord(value)) {
		throw new Error(`Expected ${fieldName} to be an object.`);
	}
	return value;
}

async function readSystemConfig(targetDir: string): Promise<Record<string, unknown>> {
	const parsed = await loadJsonConfigFile(path.join(targetDir, 'config', 'system.jsonc'));
	if (!isObjectRecord(parsed)) {
		throw new Error('Generated system config must be an object.');
	}
	return parsed;
}

describe('smoke: agent-vm 1Password auth CLI', () => {
	it('scaffolds a configured Keychain account through the built init command', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-1password-cli-'));

		await execa(
			'node',
			[
				agentVmCliPath,
				'init',
				'claw-beta',
				'--type',
				'openclaw',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--onepassword-keychain-account-name',
				'shravan-claw',
			],
			{ cwd: targetDir, reject: true, timeout: 30_000 },
		);

		const config = await readSystemConfig(targetDir);
		const host = readObjectField(config, 'host');
		const secretsProvider = readObjectField(host, 'secretsProvider');
		const tokenSource = readObjectField(secretsProvider, 'tokenSource');

		expect(tokenSource).toMatchObject({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account--shravan-claw',
		});
	});
});
