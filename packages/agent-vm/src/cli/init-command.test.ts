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
	host: z
		.object({
			secretsProvider: z
				.object({
					tokenSource: z.unknown(),
				})
				.optional(),
		})
		.passthrough(),
	zones: z.tuple([
		z
			.object({
				id: z.string().min(1),
				gateway: z
					.object({
						type: z.enum(['openclaw', 'worker']),
					})
					.passthrough(),
				secrets: z.record(
					z.string(),
					z
						.object({
							ref: z.string().optional(),
						})
						.passthrough(),
				),
			})
			.passthrough(),
	]),
});

const openClawConfigSchema = z.object({
	gateway: z.object({
		controlUi: z.object({
			allowedOrigins: z.array(z.string()),
		}),
	}),
});

const existingConfigSchema = z.object({
	existing: z.boolean(),
});

function readJsonFile<TSchema extends z.ZodTypeAny>(
	filePath: string,
	schema: TSchema,
): z.infer<TSchema> {
	return schema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

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
			{ targetDir, zoneId: 'test-zone', gatewayType: 'worker' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = scaffoldedSystemConfigSchema.parse(
			JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8')),
		);
		const gatewayDockerfile = fs.readFileSync(
			path.join(targetDir, 'images', 'gateway', 'Dockerfile'),
			'utf8',
		);

		expect(config.zones[0]?.gateway.type).toBe('worker');
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
		expect(envContent).not.toContain('_REF=');
	});

	it('scaffolds macOS Keychain auth by default', async () => {
		const targetDir = createTestDirectory();
		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = readJsonFile(path.join(targetDir, 'system.json'), scaffoldedSystemConfigSchema);
		expect(config.host.secretsProvider).toBeDefined();

		expect(config.host.secretsProvider?.tokenSource).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account',
		});
	});

	it('writes explicit 1Password refs into scaffolded secrets', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = readJsonFile(path.join(targetDir, 'system.json'), scaffoldedSystemConfigSchema);
		const secrets = config.zones[0].secrets;
		expect(secrets.DISCORD_BOT_TOKEN).toBeDefined();
		expect(secrets.PERPLEXITY_API_KEY).toBeDefined();
		expect(secrets.OPENCLAW_GATEWAY_TOKEN).toBeDefined();

		expect(secrets.DISCORD_BOT_TOKEN?.ref).toBe('op://agent-vm/agent-discord-app/bot-token');
		expect(secrets.PERPLEXITY_API_KEY?.ref).toBe('op://agent-vm/agent-perplexity/credential');
		expect(secrets.OPENCLAW_GATEWAY_TOKEN?.ref).toBe(
			'op://agent-vm/agent-shravan-claw-gateway/password',
		);
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
			{ targetDir: codingTargetDir, zoneId: 'my-zone', gatewayType: 'worker' },
			noGeneratedAgeIdentityDependencies,
		);

		expect(fs.existsSync(path.join(openClawTargetDir, 'config', 'my-zone', 'openclaw.json'))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(codingTargetDir, 'config', 'my-zone', 'worker.json'))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(codingTargetDir, 'config', 'my-zone', 'openclaw.json'))).toBe(
			false,
		);
	});

	it('scaffolds control-ui allowed origins for the host ingress port', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'my-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);

		const openClawConfig = readJsonFile(
			path.join(targetDir, 'config', 'my-zone', 'openclaw.json'),
			openClawConfigSchema,
		);

		expect(openClawConfig.gateway.controlUi.allowedOrigins).toEqual([
			'http://127.0.0.1:18791',
			'http://localhost:18791',
		]);
	});

	it('does not overwrite an existing system.json', async () => {
		const targetDir = createTestDirectory();
		fs.writeFileSync(path.join(targetDir, 'system.json'), '{"existing":true}\n', 'utf8');

		const result = await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = readJsonFile(path.join(targetDir, 'system.json'), existingConfigSchema);

		expect(result.skipped).toContain('system.json');
		expect(config.existing).toBe(true);
	});

	it('scaffolds coding-appropriate secrets for coding type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'worker', targetDir, zoneId: 'test-coding' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = readJsonFile(path.join(targetDir, 'system.json'), scaffoldedSystemConfigSchema);
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

		const config = readJsonFile(path.join(targetDir, 'system.json'), scaffoldedSystemConfigSchema);
		const secrets = config.zones[0].secrets;

		expect(secrets).toHaveProperty('DISCORD_BOT_TOKEN');
		expect(secrets).toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
		expect(secrets).not.toHaveProperty('ANTHROPIC_API_KEY');
	});

	it('scaffolds coding-specific env references for coding type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'worker', targetDir, zoneId: 'test-coding' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = readJsonFile(path.join(targetDir, 'system.json'), scaffoldedSystemConfigSchema);
		const secrets = config.zones[0].secrets;
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');
		expect(secrets.ANTHROPIC_API_KEY).toBeDefined();
		expect(secrets.OPENAI_API_KEY).toBeDefined();

		expect(envContent).not.toContain('_REF=');
		expect(secrets.ANTHROPIC_API_KEY?.ref).toBe('op://agent-vm/agent-anthropic/api-key');
		expect(secrets.OPENAI_API_KEY?.ref).toBe('op://agent-vm/agent-openai/api-key');
	});

	it('scaffolds coding-specific network defaults for coding type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'worker', targetDir, zoneId: 'test-coding' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = readJsonFile(path.join(targetDir, 'system.json'), scaffoldedSystemConfigSchema);
		const zone = config.zones[0];

		expect(zone.allowedHosts).toContain('api.anthropic.com');
		expect(zone.allowedHosts).toContain('api.openai.com');
		expect(zone.allowedHosts).not.toContain('discord.com');
		expect(zone.websocketBypass).toEqual([]);
	});
});
