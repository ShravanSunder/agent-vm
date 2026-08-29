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

async function writeExecutable(filePath: string, content: string): Promise<void> {
	await fs.writeFile(filePath, content, 'utf8');
	await fs.chmod(filePath, 0o755);
}

describe('smoke: agent-vm 1Password auth CLI', () => {
	it('scaffolds a configured Keychain account through the built init command', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-1password-cli-'));

		await execa(
			'node',
			[
				agentVmCliPath,
				'init',
				'hermes-beta',
				'--type',
				'hermes',
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

	it('reads a token ref and stores it through the configured Keychain account', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-1password-cli-'));
		const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-1password-bin-'));
		const securityArgsPath = path.join(targetDir, 'security-args.json');

		await writeExecutable(
			path.join(fakeBinDir, 'op'),
			`#!/usr/bin/env sh
set -eu
if [ "$1" = "read" ] && [ "$2" = "op://agent-vm/1p-service-account-shravan-claw/credential" ]; then
  printf 'service-account-token\\n'
  exit 0
fi
echo "unexpected op args: $*" >&2
exit 1
`,
		);
		await writeExecutable(
			path.join(fakeBinDir, 'security'),
			`#!/usr/bin/env node
	const fs = require('node:fs');
	const stdin = fs.readFileSync(0, 'utf8');
	fs.writeFileSync(process.env.AGENT_VM_SECURITY_ARGS_PATH, JSON.stringify({
	  args: process.argv.slice(2),
	  stdin,
	}));
	`,
		);
		await execa(
			'node',
			[
				agentVmCliPath,
				'init',
				'hermes-beta',
				'--type',
				'hermes',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--onepassword-keychain-account-name',
				'shravan-claw',
			],
			{ cwd: targetDir, reject: true, timeout: 30_000 },
		);

		const result = await execa(
			'node',
			[
				agentVmCliPath,
				'auth',
				'1password',
				'op://agent-vm/1p-service-account-shravan-claw/credential',
				'--config',
				path.join(targetDir, 'config', 'system.jsonc'),
			],
			{
				env: {
					AGENT_VM_SECURITY_ARGS_PATH: securityArgsPath,
					AGENT_VM_TEST_SECURITY_COMMAND: path.join(fakeBinDir, 'security'),
					PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
				},
				reject: true,
				timeout: 30_000,
			},
		);
		const securityArgs = JSON.parse(await fs.readFile(securityArgsPath, 'utf8')) as unknown;

		expect(securityArgs).toEqual({
			args: [
				'add-generic-password',
				'-s',
				'agent-vm',
				'-a',
				'1p-service-account--shravan-claw',
				'-U',
				'-w',
			],
			stdin: 'service-account-token',
		});
		expect(JSON.stringify(securityArgs)).not.toContain('service-account-token","-U');
		expect(result.stdout).not.toContain('service-account-token');
		expect(result.stderr).not.toContain('service-account-token');
	});
});
