import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { scaffoldAgentVmProject } from './init-command.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createTestDirectory(): string {
	const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-init-test-'));
	createdDirectories.push(testDirectory);
	return testDirectory;
}

const noGeneratedAgeIdentityDependencies = {
	generateAgeIdentityKey: () => undefined,
};

const scaffoldedSystemConfigSchema = z.object({
	cacheDir: z.string().min(1),
	zones: z.tuple([z.object({ id: z.string().min(1) })]),
});

describe('scaffoldAgentVmProject', () => {
	it('creates system.json with the requested zone', () => {
		const targetDir = createTestDirectory();

		const result = scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = scaffoldedSystemConfigSchema.parse(
			JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8')),
		);

		expect(result.created).toContain('system.json');
		expect(config.cacheDir).toBe('./cache');
		expect(config.zones[0]?.id).toBe('test-zone');
	});

	it('creates .env.local from the default template', () => {
		const targetDir = createTestDirectory();

		const result = scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone' },
			noGeneratedAgeIdentityDependencies,
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(result.created).toContain('.env.local');
		expect(envContent).toContain('# OP_SERVICE_ACCOUNT_TOKEN=');
		expect(envContent).toContain('DISCORD_BOT_TOKEN_REF=');
	});

	it('scaffolds 1Password Touch ID auth by default', () => {
		const targetDir = createTestDirectory();
		scaffoldAgentVmProject({ targetDir, zoneId: 'test-zone' }, noGeneratedAgeIdentityDependencies);
		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));

		expect(config.host.secretsProvider.tokenSource).toEqual({
			ref: 'op://agent-vm/service-account/credential',
			type: 'op-cli',
		});
	});

	it('appends an age identity to .env.local when one is generated', () => {
		const targetDir = createTestDirectory();

		scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone' },
			{
				generateAgeIdentityKey: () => 'AGE-SECRET-KEY-1TESTVALUE',
			},
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).toContain('AGE_IDENTITY_KEY=AGE-SECRET-KEY-1TESTVALUE');
	});

	it('leaves .env.local without an age identity when generation fails', () => {
		const targetDir = createTestDirectory();

		scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone' },
			{
				generateAgeIdentityKey: () => undefined,
			},
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).not.toMatch(/^AGE_IDENTITY_KEY=/mu);
	});

	it('creates config and state directories', () => {
		const targetDir = createTestDirectory();

		scaffoldAgentVmProject({ targetDir, zoneId: 'my-zone' }, noGeneratedAgeIdentityDependencies);

		expect(fs.existsSync(path.join(targetDir, 'config', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'state', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'workspaces', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'workspaces', 'tools'))).toBe(true);
	});

	it('does not overwrite an existing system.json', () => {
		const targetDir = createTestDirectory();
		fs.writeFileSync(path.join(targetDir, 'system.json'), '{"existing":true}\n', 'utf8');

		const result = scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8')) as {
			readonly existing: boolean;
		};

		expect(result.skipped).toContain('system.json');
		expect(config.existing).toBe(true);
	});
});
