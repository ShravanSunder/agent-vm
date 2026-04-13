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
	copyBundledOpenClawPlugin: async (targetDir: string): Promise<'created' | 'skipped'> => {
		const pluginDirectory = path.join(targetDir, 'images', 'gateway', 'vendor', 'gondolin');
		fs.mkdirSync(pluginDirectory, { recursive: true });
		fs.writeFileSync(path.join(pluginDirectory, 'openclaw.plugin.json'), '{"id":"gondolin"}\n');
		return 'created';
	},
	generateAgeIdentityKey: () => undefined,
};

const scaffoldedSystemConfigSchema = z.object({
	cacheDir: z.string().min(1),
	zones: z.tuple([
		z.object({
			id: z.string().min(1),
			gateway: z.object({
				type: z.enum(['openclaw', 'worker']),
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
			JSON.parse(fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8')),
		);

		expect(result.created).toContain('config/system.json');
		expect(config.cacheDir).toBe('../cache');
		expect(config.zones[0]?.id).toBe('test-zone');
		expect(config.zones[0]?.gateway.type).toBe('openclaw');
	});

	it('scaffolds a worker gateway when requested', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'worker' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = scaffoldedSystemConfigSchema.parse(
			JSON.parse(fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8')),
		);
		const gatewayDockerfile = fs.readFileSync(
			path.join(targetDir, 'images', 'gateway', 'Dockerfile'),
			'utf8',
		);

		expect(config.zones[0]?.gateway.type).toBe('worker');
		expect(gatewayDockerfile).toContain('@openai/codex-cli');
		expect(gatewayDockerfile).not.toContain('openclaw@');
	});

	it('scaffolds the published gondolin plugin install into the openclaw gateway Dockerfile', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const gatewayDockerfile = fs.readFileSync(
			path.join(targetDir, 'images', 'gateway', 'Dockerfile'),
			'utf8',
		);

		expect(gatewayDockerfile).toContain(
			'COPY vendor/gondolin /home/openclaw/.openclaw/extensions/gondolin',
		);
		expect(gatewayDockerfile).not.toContain('@shravansunder/openclaw-agent-vm-plugin');
		expect(
			fs.existsSync(
				path.join(targetDir, 'images', 'gateway', 'vendor', 'gondolin', 'openclaw.plugin.json'),
			),
		).toBe(true);
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
		expect(envContent).not.toContain('DISCORD_BOT_TOKEN_REF=');
		expect(envContent).not.toContain('OPENCLAW_GATEWAY_TOKEN_REF=');
	});

	it('scaffolds macOS Keychain auth by default', async () => {
		const targetDir = createTestDirectory();
		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);

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

		const workerTargetDir = createTestDirectory();
		await scaffoldAgentVmProject(
			{ targetDir: workerTargetDir, zoneId: 'my-zone', gatewayType: 'worker' },
			noGeneratedAgeIdentityDependencies,
		);

		expect(fs.existsSync(path.join(openClawTargetDir, 'config', 'my-zone', 'openclaw.json'))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(workerTargetDir, 'config', 'my-zone', 'worker.json'))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(workerTargetDir, 'config', 'my-zone', 'openclaw.json'))).toBe(
			false,
		);
	});

	it('scaffolds control-ui allowed origins for the host ingress port', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'my-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);

		const openClawConfig = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'config', 'my-zone', 'openclaw.json'), 'utf8'),
		) as {
			readonly gateway: {
				readonly controlUi: {
					readonly allowedOrigins: readonly string[];
				};
			};
			readonly plugins: {
				readonly load: {
					readonly paths: readonly string[];
				};
			};
		};

		expect(openClawConfig.gateway.controlUi.allowedOrigins).toEqual([
			'http://127.0.0.1:18791',
			'http://localhost:18791',
		]);
		expect(openClawConfig.plugins.load.paths).toEqual(['/home/openclaw/.openclaw/extensions']);
	});

	it('does not overwrite an existing system.json', async () => {
		const targetDir = createTestDirectory();
		fs.mkdirSync(path.join(targetDir, 'config'), { recursive: true });
		fs.writeFileSync(path.join(targetDir, 'config', 'system.json'), '{"existing":true}\n', 'utf8');

		const result = await scaffoldAgentVmProject(
			{ targetDir, zoneId: 'test-zone', gatewayType: 'openclaw' },
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		) as {
			readonly existing: boolean;
		};

		expect(result.skipped).toContain('config/system.json');
		expect(config.existing).toBe(true);
	});

	it('scaffolds worker-appropriate secrets for worker type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'worker', targetDir, zoneId: 'test-worker' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);
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

		const config = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);
		const secrets = config.zones[0].secrets;

		expect(secrets).toHaveProperty('DISCORD_BOT_TOKEN');
		expect(secrets).toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
		expect(secrets).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(secrets.DISCORD_BOT_TOKEN.ref).toBe('op://agent-vm/test-openclaw-discord/bot-token');
		expect(secrets.PERPLEXITY_API_KEY.ref).toBe(
			'op://agent-vm/test-openclaw-perplexity/credential',
		);
		expect(secrets.OPENCLAW_GATEWAY_TOKEN.ref).toBe(
			'op://agent-vm/test-openclaw-gateway-auth/password',
		);
	});

	it('scaffolds worker-specific env references for worker type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'worker', targetDir, zoneId: 'test-worker' },
			noGeneratedAgeIdentityDependencies,
		);
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).not.toContain('ANTHROPIC_API_KEY_REF=');
		expect(envContent).not.toContain('OPENAI_API_KEY_REF=');
	});

	it('scaffolds worker-specific refs in system.json for worker type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'worker', targetDir, zoneId: 'test-worker' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);
		const secrets = config.zones[0].secrets;

		expect(secrets.ANTHROPIC_API_KEY.ref).toBe('op://agent-vm/test-worker-anthropic/credential');
		expect(secrets.OPENAI_API_KEY.ref).toBe('op://agent-vm/test-worker-openai/credential');
	});

	it('scaffolds worker-specific network defaults for worker type', async () => {
		const targetDir = createTestDirectory();

		await scaffoldAgentVmProject(
			{ gatewayType: 'worker', targetDir, zoneId: 'test-worker' },
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			fs.readFileSync(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);
		const zone = config.zones[0];

		expect(zone.allowedHosts).toContain('api.anthropic.com');
		expect(zone.allowedHosts).toContain('api.openai.com');
		expect(zone.allowedHosts).not.toContain('discord.com');
		expect(zone.websocketBypass).toEqual([]);
	});
});
