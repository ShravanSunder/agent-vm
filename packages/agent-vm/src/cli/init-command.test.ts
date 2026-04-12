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
	zones: z.tuple([
		z.object({
			id: z.string().min(1),
			gateway: z.object({
				type: z.enum(['openclaw', 'coding']),
			}),
		}),
	]),
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
		expect(config.zones[0]?.gateway.type).toBe('openclaw');
	});

	it('scaffolds a coding gateway when requested', () => {
		const targetDir = createTestDirectory();

		scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'coding' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = scaffoldedSystemConfigSchema.parse(
			JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8')),
		);
		const gatewayDockerfile = fs.readFileSync(
			path.join(targetDir, 'images', 'gateway', 'Dockerfile'),
			'utf8',
		);

		expect(config.zones[0]?.gateway.type).toBe('coding');
		expect(gatewayDockerfile).toContain('@openai/codex-cli');
		expect(gatewayDockerfile).not.toContain('openclaw@');
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

	it('scaffolds macOS Keychain auth by default', () => {
		const targetDir = createTestDirectory();
		scaffoldAgentVmProject({ targetDir, zoneId: 'test-zone' }, noGeneratedAgeIdentityDependencies);
		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));

		expect(config.host.secretsProvider.tokenSource).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account',
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

	it('scaffolds a type-specific gateway config file', () => {
		const openClawTargetDir = createTestDirectory();
		scaffoldAgentVmProject(
			{ targetDir: openClawTargetDir, zoneId: 'my-zone' },
			noGeneratedAgeIdentityDependencies,
		);

		const codingTargetDir = createTestDirectory();
		scaffoldAgentVmProject(
			{ targetDir: codingTargetDir, zoneId: 'my-zone', gatewayType: 'coding' },
			noGeneratedAgeIdentityDependencies,
		);

		expect(fs.existsSync(path.join(openClawTargetDir, 'config', 'my-zone', 'openclaw.json'))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(codingTargetDir, 'config', 'my-zone', 'coding.json'))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(codingTargetDir, 'config', 'my-zone', 'openclaw.json'))).toBe(
			false,
		);
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
