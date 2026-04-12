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
	it('creates system.json with the requested zone', async () => {
		const targetDir = createTestDirectory();

		const result = await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
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

	it('scaffolds a coding gateway when requested', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
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

	it('creates .env.local from the default template', async () => {
		const targetDir = createTestDirectory();

		const result = await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(result.created).toContain('.env.local');
		expect(envContent).toContain('# OP_SERVICE_ACCOUNT_TOKEN=');
		expect(envContent).toContain('DISCORD_BOT_TOKEN_REF=');
	});

	it('scaffolds macOS Keychain auth by default', async () => {
		const targetDir = createTestDirectory();
		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));

		expect(config.host.secretsProvider.tokenSource).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account',
		});
	});

	it('appends an age identity to .env.local when one is generated', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			{
				generateAgeIdentityKey: () => 'AGE-SECRET-KEY-1TESTVALUE',
			},
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).toContain('AGE_IDENTITY_KEY=AGE-SECRET-KEY-1TESTVALUE');
	});

	it('leaves .env.local without an age identity when generation fails', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			{
				generateAgeIdentityKey: () => undefined,
			},
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).not.toMatch(/^AGE_IDENTITY_KEY=/mu);
	});

	it('creates config and state directories', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'my-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);

		expect(fs.existsSync(path.join(targetDir, 'config', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'state', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'workspaces', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'workspaces', 'tools'))).toBe(true);
	});

	it('scaffolds a type-specific gateway config file', async () => {
		const openClawTargetDir = createTestDirectory();
		await scaffoldAgentVmProject(
			{ targetDir: openClawTargetDir, zoneId: 'my-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);

		const codingTargetDir = createTestDirectory();
		await scaffoldAgentVmProject(
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

	it('does not overwrite an existing system.json', async () => {
		const targetDir = createTestDirectory();
		fs.writeFileSync(path.join(targetDir, 'system.json'), '{"existing":true}\n', 'utf8');

		const result = await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8')) as {
			readonly existing: boolean;
		};

		expect(result.skipped).toContain('system.json');
		expect(config.existing).toBe(true);
	});

	it('scaffolds coding-appropriate secrets for coding type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'coding', targetDir, zoneId: 'test-coding' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
		const secrets = config.zones[0].secrets;

		expect(secrets).not.toHaveProperty('DISCORD_BOT_TOKEN');
		expect(secrets).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
		expect(secrets).toHaveProperty('ANTHROPIC_API_KEY');
		expect(secrets).toHaveProperty('OPENAI_API_KEY');
	});

	it('scaffolds openclaw-appropriate secrets for openclaw type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'openclaw', targetDir, zoneId: 'test-openclaw' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
		const secrets = config.zones[0].secrets;

		expect(secrets).toHaveProperty('DISCORD_BOT_TOKEN');
		expect(secrets).toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
		expect(secrets).not.toHaveProperty('ANTHROPIC_API_KEY');
	});

	it('scaffolds coding-specific env references for coding type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'coding', targetDir, zoneId: 'test-coding' },
			noGeneratedAgeIdentityDependencies,
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).toContain('ANTHROPIC_API_KEY_REF=');
		expect(envContent).toContain('OPENAI_API_KEY_REF=');
		expect(envContent).not.toContain('DISCORD_BOT_TOKEN_REF=');
		expect(envContent).not.toContain('OPENCLAW_GATEWAY_TOKEN_REF=');
	});

	it('scaffolds coding-specific network defaults for coding type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'coding', targetDir, zoneId: 'test-coding' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8'));
		const zone = config.zones[0];

		expect(zone.allowedHosts).toContain('api.anthropic.com');
		expect(zone.allowedHosts).toContain('api.openai.com');
		expect(zone.allowedHosts).not.toContain('discord.com');
		expect(zone.websocketBypass).toEqual([]);
	});
});
