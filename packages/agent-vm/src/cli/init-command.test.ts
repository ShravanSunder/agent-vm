import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	DEFAULT_BASE_INSTRUCTIONS,
	DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	DEFAULT_WORK_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	DEFAULT_WRAPUP_INSTRUCTIONS,
	loadWorkerConfig,
} from '@agent-vm/agent-vm-worker';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { scaffoldAgentVmProject } from './init-command.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	const directories = createdDirectories.splice(0);
	await Promise.all(
		directories.map((directoryPath) => fs.rm(directoryPath, { force: true, recursive: true })),
	);
});

async function createTestDirectory(): Promise<string> {
	const testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-init-test-'));
	createdDirectories.push(testDirectory);
	return testDirectory;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

const noGeneratedAgeIdentityDependencies = {
	copyBundledOpenClawPlugin: async (targetDir: string): Promise<'created' | 'skipped'> => {
		const pluginDirectory = path.join(
			targetDir,
			'vm-images',
			'gateways',
			'openclaw',
			'vendor',
			'gondolin',
		);
		await fs.mkdir(pluginDirectory, { recursive: true });
		await fs.writeFile(path.join(pluginDirectory, 'openclaw.plugin.json'), '{"id":"gondolin"}\n');
		return 'created';
	},
	generateAgeIdentityKey: () => undefined,
};

const scaffoldedSystemConfigSchema = z.object({
	cacheDir: z.string().min(1),
	host: z.object({
		projectNamespace: z.string().min(1),
	}),
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
		const targetDir = await createTestDirectory();

		const result = await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const config = scaffoldedSystemConfigSchema.parse(
			JSON.parse(await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8')),
		);

		expect(result.created).toContain('config/system.json');
		expect(config.cacheDir).toBe('../cache');
		expect(config.host.projectNamespace).toMatch(/^agent-vm-init-test-/u);
		expect(config.zones[0]?.id).toBe('test-zone');
		expect(config.zones[0]?.gateway.type).toBe('openclaw');
	});

	it('scaffolds a worker gateway when requested', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'worker',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);
		const config = scaffoldedSystemConfigSchema.parse(
			JSON.parse(await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8')),
		);
		const gatewayDockerfile = await fs.readFile(
			path.join(targetDir, 'vm-images', 'gateways', 'worker', 'Dockerfile'),
			'utf8',
		);

		expect(config.zones[0]?.gateway.type).toBe('worker');
		expect(gatewayDockerfile).toContain('Do not bake auth tokens');
		expect(gatewayDockerfile).toContain('@openai/codex');
		expect(gatewayDockerfile).not.toContain('openclaw@');
		expect(gatewayDockerfile).not.toContain('.npmrc');
		expect(gatewayDockerfile).not.toContain('_authToken');
	});

	it('scaffolds worker.json with editable prompt file references for every default prompt', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'worker',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-worker',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const workerConfigPath = path.join(
			targetDir,
			'config',
			'gateways',
			'test-worker',
			'worker.json',
		);
		const rawWorkerConfig = JSON.parse(await fs.readFile(workerConfigPath, 'utf8'));
		const workerConfig = await loadWorkerConfig(workerConfigPath);

		expect(rawWorkerConfig.instructions).toEqual({ path: './prompts/base.md' });
		expect(rawWorkerConfig.phases.plan.agentInstructions).toEqual({
			path: './prompts/plan-agent.md',
		});
		expect(rawWorkerConfig.phases.plan.reviewerInstructions).toEqual({
			path: './prompts/plan-reviewer.md',
		});
		expect(rawWorkerConfig.phases.work.agentInstructions).toEqual({
			path: './prompts/work-agent.md',
		});
		expect(rawWorkerConfig.phases.work.reviewerInstructions).toEqual({
			path: './prompts/work-reviewer.md',
		});
		expect(rawWorkerConfig.phases.wrapup.instructions).toEqual({ path: './prompts/wrapup.md' });

		await expect(
			fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'test-worker', 'prompts', 'base.md'),
				'utf8',
			),
		).resolves.toBe(`${DEFAULT_BASE_INSTRUCTIONS}\n`);
		await expect(
			fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'test-worker', 'prompts', 'plan-agent.md'),
				'utf8',
			),
		).resolves.toBe(`${DEFAULT_PLAN_AGENT_INSTRUCTIONS}\n`);
		await expect(
			fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'test-worker', 'prompts', 'plan-reviewer.md'),
				'utf8',
			),
		).resolves.toBe(`${DEFAULT_PLAN_REVIEWER_INSTRUCTIONS}\n`);
		await expect(
			fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'test-worker', 'prompts', 'work-agent.md'),
				'utf8',
			),
		).resolves.toBe(`${DEFAULT_WORK_AGENT_INSTRUCTIONS}\n`);
		await expect(
			fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'test-worker', 'prompts', 'work-reviewer.md'),
				'utf8',
			),
		).resolves.toBe(`${DEFAULT_WORK_REVIEWER_INSTRUCTIONS}\n`);
		await expect(
			fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'test-worker', 'prompts', 'wrapup.md'),
				'utf8',
			),
		).resolves.toBe(`${DEFAULT_WRAPUP_INSTRUCTIONS}\n`);

		expect(workerConfig.instructions).toBe(`${DEFAULT_BASE_INSTRUCTIONS}\n`);
		expect(workerConfig.phases.plan.agentInstructions).toBe(`${DEFAULT_PLAN_AGENT_INSTRUCTIONS}\n`);
		expect(workerConfig.phases.plan.reviewerInstructions).toBe(
			`${DEFAULT_PLAN_REVIEWER_INSTRUCTIONS}\n`,
		);
		expect(workerConfig.phases.work.agentInstructions).toBe(`${DEFAULT_WORK_AGENT_INSTRUCTIONS}\n`);
		expect(workerConfig.phases.work.reviewerInstructions).toBe(
			`${DEFAULT_WORK_REVIEWER_INSTRUCTIONS}\n`,
		);
		expect(workerConfig.phases.wrapup.instructions).toBe(`${DEFAULT_WRAPUP_INSTRUCTIONS}\n`);
		expect(workerConfig.defaults.provider).toBe('codex');
		expect(workerConfig.defaults.model).toBe('latest-medium');
		expect(workerConfig.phases.plan.cycle).toEqual({ kind: 'review', cycleCount: 1 });
		expect(workerConfig.phases.work.cycle).toEqual({ kind: 'review', cycleCount: 2 });
		expect(rawWorkerConfig.wrapupActions).toBeUndefined();
	});

	it('scaffolds the published gondolin plugin install into the openclaw gateway Dockerfile', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const gatewayDockerfile = await fs.readFile(
			path.join(targetDir, 'vm-images', 'gateways', 'openclaw', 'Dockerfile'),
			'utf8',
		);

		expect(gatewayDockerfile).toContain('Do not bake auth tokens');
		expect(gatewayDockerfile).toContain(
			'COPY vendor/gondolin /home/openclaw/.openclaw/extensions/gondolin',
		);
		expect(gatewayDockerfile).not.toContain('@agent-vm/openclaw-agent-vm-plugin');
		expect(
			await pathExists(
				path.join(
					targetDir,
					'vm-images',
					'gateways',
					'openclaw',
					'vendor',
					'gondolin',
					'openclaw.plugin.json',
				),
			),
		).toBe(true);
	});

	it('creates .env.local from the default template', async () => {
		const targetDir = await createTestDirectory();

		const result = await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const envContent = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');

		expect(result.created).toContain('.env.local');
		expect(envContent).toContain('# OP_SERVICE_ACCOUNT_TOKEN=');
		expect(envContent).not.toContain('DISCORD_BOT_TOKEN_REF=');
		expect(envContent).not.toContain('OPENCLAW_GATEWAY_TOKEN_REF=');
	});

	it('scaffolds macOS Keychain auth by default', async () => {
		const targetDir = await createTestDirectory();
		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);

		expect(config.host.secretsProvider.tokenSource).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account',
		});
	});

	it('appends an age identity to .env.local when one is generated', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			{
				...noGeneratedAgeIdentityDependencies,
				generateAgeIdentityKey: () => 'AGE-SECRET-KEY-1TESTVALUE',
			},
		);
		const envContent = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).toContain('AGE_IDENTITY_KEY=AGE-SECRET-KEY-1TESTVALUE');
	});

	it('leaves .env.local without an age identity when generation fails', async () => {
		const targetDir = await createTestDirectory();
		const warnings: string[] = [];

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			{
				...noGeneratedAgeIdentityDependencies,
				generateAgeIdentityKey: () => {
					throw new Error('age-keygen missing');
				},
				reportWarning: (message) => {
					warnings.push(message);
				},
			},
		);
		const envContent = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).not.toMatch(/^AGE_IDENTITY_KEY=/mu);
		expect(warnings.join('\n')).toContain('age-keygen not available');
		expect(warnings.join('\n')).toContain('age-keygen missing');
	});

	it('creates local runtime directories for local scaffolds', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'my-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		expect(await pathExists(path.join(targetDir, 'config', 'gateways', 'my-zone'))).toBe(true);
		expect(await pathExists(path.join(targetDir, 'state', 'my-zone'))).toBe(true);
		expect(await pathExists(path.join(targetDir, 'workspaces', 'my-zone'))).toBe(true);
		expect(await pathExists(path.join(targetDir, 'workspaces', 'tools'))).toBe(true);
	});

	it('does not create checkout-local runtime directories for container scaffolds', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'my-zone',
				gatewayType: 'worker',
				architecture: 'x86_64',
				secretsProvider: 'environment',
				paths: 'pod',
				hostSystemType: 'container',
			},
			noGeneratedAgeIdentityDependencies,
		);

		expect(await pathExists(path.join(targetDir, 'config', 'gateways', 'my-zone'))).toBe(true);
		expect(await pathExists(path.join(targetDir, 'state'))).toBe(false);
		expect(await pathExists(path.join(targetDir, 'workspaces'))).toBe(false);
	});

	it('scaffolds a type-specific gateway config file', async () => {
		const openClawTargetDir = await createTestDirectory();
		await scaffoldAgentVmProject(
			{
				targetDir: openClawTargetDir,
				zoneId: 'my-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const workerTargetDir = await createTestDirectory();
		await scaffoldAgentVmProject(
			{
				targetDir: workerTargetDir,
				zoneId: 'my-zone',
				gatewayType: 'worker',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		expect(
			await pathExists(
				path.join(openClawTargetDir, 'config', 'gateways', 'my-zone', 'openclaw.json'),
			),
		).toBe(true);
		expect(
			await pathExists(path.join(workerTargetDir, 'config', 'gateways', 'my-zone', 'worker.json')),
		).toBe(true);
		expect(
			await pathExists(
				path.join(workerTargetDir, 'config', 'gateways', 'my-zone', 'openclaw.json'),
			),
		).toBe(false);
	});

	it('scaffolds control-ui allowed origins for the host ingress port', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'my-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const openClawConfig = JSON.parse(
			await fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'my-zone', 'openclaw.json'),
				'utf8',
			),
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
		const targetDir = await createTestDirectory();
		await fs.mkdir(path.join(targetDir, 'config'), { recursive: true });
		await fs.writeFile(
			path.join(targetDir, 'config', 'system.json'),
			'{"existing":true}\n',
			'utf8',
		);

		const result = await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		) as {
			readonly existing: boolean;
		};

		expect(result.skipped).toContain('config/system.json');
		expect(config.existing).toBe(true);
	});

	it('overwrites existing scaffold files when overwrite is enabled', async () => {
		const targetDir = await createTestDirectory();
		await fs.mkdir(path.join(targetDir, 'config'), { recursive: true });
		await fs.writeFile(
			path.join(targetDir, 'config', 'system.json'),
			'{"existing":true}\n',
			'utf8',
		);

		const result = await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'worker',
				architecture: 'aarch64',
				secretsProvider: '1password',
				overwrite: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		) as { readonly existing?: boolean };

		expect(result.created).toContain('config/system.json');
		expect(config.existing).toBeUndefined();
	});

	it('scaffolds worker-appropriate secrets for worker type', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'worker',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-worker',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);
		const secrets = config.zones[0].secrets;

		expect(secrets).not.toHaveProperty('DISCORD_BOT_TOKEN');
		expect(secrets).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
		expect(secrets).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(secrets).toHaveProperty('GITHUB_TOKEN');
		expect(secrets).toHaveProperty('OPENAI_API_KEY');
		expect(config.host.githubToken.ref).toBe('op://agent-vm/github-token/credential');
	});

	it('scaffolds openclaw-appropriate secrets for openclaw type', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-openclaw',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
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

	it('scaffolds tool VM support for openclaw gateways', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-openclaw',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		) as {
			readonly imageProfiles: {
				readonly toolVms: { readonly default: { readonly buildConfig: string } };
			};
			readonly toolProfiles: {
				readonly standard: { readonly imageProfile: string; readonly workspaceRoot: string };
			};
			readonly zones: readonly [{ readonly toolProfile: string }];
		};

		expect(config.zones[0].toolProfile).toBe('standard');
		expect(config.toolProfiles.standard.imageProfile).toBe('default');
		expect(config.imageProfiles.toolVms.default.buildConfig).toBe(
			'../vm-images/tool-vms/default/build-config.json',
		);
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'build-config.json')),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'Dockerfile')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('scaffolds worker-specific env references for worker type', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'worker',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-worker',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const envContent = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).not.toContain('ANTHROPIC_API_KEY_REF=');
		expect(envContent).not.toContain('OPENAI_API_KEY_REF=');
	});

	it('scaffolds worker-specific refs in system.json for worker type', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'worker',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-worker',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);
		const secrets = config.zones[0].secrets;

		expect(secrets.OPENAI_API_KEY.ref).toBe('op://agent-vm/workers-openai/credential');
		expect(secrets.GITHUB_TOKEN.ref).toBe('op://agent-vm/github-token/credential');
	});

	it('scaffolds worker-specific network defaults for worker type', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'worker',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-worker',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		);
		const zone = config.zones[0];

		expect(zone.allowedHosts).toContain('api.anthropic.com');
		expect(zone.allowedHosts).toContain('api.openai.com');
		expect(zone.allowedHosts).not.toContain('discord.com');
		expect(zone.websocketBypass).toEqual([]);
	});

	it('scaffolds environment-backed secrets when secretsProvider is environment', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'worker',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'env-worker',
				secretsProvider: 'environment',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const config = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		) as {
			readonly host: {
				readonly githubToken: { readonly source: string; readonly envVar?: string };
				readonly secretsProvider?: unknown;
			};
			readonly zones: readonly {
				readonly secrets: Record<
					string,
					{ readonly source: string; readonly envVar?: string; readonly ref?: string }
				>;
			}[];
		};

		expect(config.host.githubToken).toEqual({ source: 'environment', envVar: 'GITHUB_TOKEN' });
		expect(config.host.secretsProvider).toBeUndefined();
		const secrets = config.zones[0]?.secrets ?? {};
		expect(secrets['GITHUB_TOKEN']?.source).toBe('environment');
		expect(secrets['GITHUB_TOKEN']?.envVar).toBe('GITHUB_TOKEN');
		expect(secrets['OPENAI_API_KEY']?.source).toBe('environment');
		expect(secrets['OPENAI_API_KEY']?.envVar).toBe('OPENAI_API_KEY');
		for (const secret of Object.values(secrets)) {
			expect(secret.ref).toBeUndefined();
		}
	});

	it('does not write .env.local for environment-backed scaffolds by default', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'worker',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'env-worker',
				secretsProvider: 'environment',
			},
			{
				...noGeneratedAgeIdentityDependencies,
				generateAgeIdentityKey: () => 'AGE-SECRET-KEY-SHOULD-NOT-APPEAR',
			},
		);

		await expect(fs.access(path.join(targetDir, '.env.local'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('writes systemCacheIdentifier.json for local scaffolds', async () => {
		const targetDir = await createTestDirectory();

		const result = await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'coding-agent',
				gatewayType: 'worker',
				architecture: 'x86_64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);

		const raw = await fs.readFile(
			path.join(targetDir, 'config', 'systemCacheIdentifier.json'),
			'utf8',
		);
		expect(JSON.parse(raw)).toMatchObject({
			$comment:
				"System cache identifier. Contents hash into every Gondolin image fingerprint. gitSha='local' is the intentional sentinel for bare-metal dev. Container-host builds usually replace gitSha with a build provenance string such as a commit SHA.",
			schemaVersion: 1,
			os: expect.any(String),
			hostSystemType: 'bare-metal',
			gitSha: 'local',
		});
		expect(result.created).toContain('config/systemCacheIdentifier.json');
	});

	it('writes linux container identifiers and no .env.local for container scaffolds', async () => {
		const targetDir = await createTestDirectory();

		const result = await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'coding-agent',
				gatewayType: 'worker',
				architecture: 'x86_64',
				hostSystemType: 'container',
				paths: 'pod',
				secretsProvider: 'environment',
				writeLocalEnvironmentFile: false,
			},
			noGeneratedAgeIdentityDependencies,
		);

		const raw = await fs.readFile(
			path.join(targetDir, 'config', 'systemCacheIdentifier.json'),
			'utf8',
		);
		expect(JSON.parse(raw)).toMatchObject({
			schemaVersion: 1,
			os: expect.any(String),
			hostSystemType: 'container',
			gitSha: 'local',
		});
		expect(result.created).not.toContain('.env.local');
		await expect(fs.access(path.join(targetDir, '.env.local'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('scaffolds vm-host-system for container presets', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'coding-agent',
				gatewayType: 'worker',
				architecture: 'x86_64',
				hostSystemType: 'container',
				paths: 'pod',
				secretsProvider: 'environment',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const dockerfile = await fs.readFile(
			path.join(targetDir, 'vm-host-system', 'Dockerfile'),
			'utf8',
		);
		expect(dockerfile).toMatch(/ARG GIT_SHA\b(?!=)/u);
		expect(dockerfile).toContain('zig-x86_64-linux-');

		const startScript = await fs.readFile(
			path.join(targetDir, 'vm-host-system', 'start.sh'),
			'utf8',
		);
		expect(startScript).toContain('--zone coding-agent');

		await expect(
			fs.access(path.join(targetDir, 'vm-host-system', 'agent-vm-controller.service')),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(targetDir, 'vm-host-system', 'README.md')),
		).resolves.toBeUndefined();
	});

	it('does not scaffold vm-host-system for bare-metal presets', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'coding-agent',
				gatewayType: 'worker',
				architecture: 'aarch64',
				hostSystemType: 'bare-metal',
				paths: 'local',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		await expect(fs.access(path.join(targetDir, 'vm-host-system'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('scaffolds container runtime paths when requested', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'coding-agent',
				gatewayType: 'worker',
				architecture: 'x86_64',
				paths: 'pod',
				projectNamespace: 'agent-vm',
				secretsProvider: '1password',
				hostSystemType: 'container',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const systemConfig = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		) as {
			readonly host: { readonly projectNamespace: string };
			readonly cacheDir: string;
			readonly imageProfiles: {
				readonly gateways: {
					readonly worker: { readonly buildConfig: string; readonly dockerfile: string };
				};
				readonly toolVms?: Record<string, unknown>;
			};
			readonly zones: [
				{
					readonly gateway: {
						readonly config: string;
						readonly stateDir: string;
						readonly workspaceDir: string;
					};
				},
			];
			readonly toolProfiles?: Record<string, unknown>;
		};

		expect(systemConfig.host.projectNamespace).toBe('agent-vm');
		expect(systemConfig.cacheDir).toBe('/var/agent-vm/cache');
		expect(systemConfig.imageProfiles.gateways.worker.buildConfig).toBe(
			'/etc/agent-vm/vm-images/gateways/worker/build-config.json',
		);
		expect(systemConfig.imageProfiles.gateways.worker.dockerfile).toBe(
			'/etc/agent-vm/vm-images/gateways/worker/Dockerfile',
		);
		expect(systemConfig.imageProfiles.toolVms).toEqual({});
		expect(systemConfig.zones[0].gateway.config).toBe(
			'/etc/agent-vm/gateways/coding-agent/worker.json',
		);
		expect(systemConfig.zones[0].gateway.stateDir).toBe('/var/agent-vm/state');
		expect(systemConfig.zones[0].gateway.workspaceDir).toBe('/var/agent-vm/workspace');
		expect(systemConfig.toolProfiles).toEqual({});

		const gatewayBuildConfig = JSON.parse(
			await fs.readFile(
				path.join(targetDir, 'vm-images', 'gateways', 'worker', 'build-config.json'),
				'utf8',
			),
		) as { readonly arch: string };
		const workerDockerfile = await fs.readFile(
			path.join(targetDir, 'vm-images', 'gateways', 'worker', 'Dockerfile'),
			'utf8',
		);
		expect(gatewayBuildConfig.arch).toBe('x86_64');
		expect(workerDockerfile).toContain('Do not bake auth tokens');
		expect(workerDockerfile).toContain('apt-get install -y --no-install-recommends gh');
		expect(workerDockerfile).toContain('COPY agent-vm-worker/ /opt/agent-vm-worker/');
		expect(workerDockerfile).toContain('/usr/local/bin/agent-vm-worker');
		expect(workerDockerfile).not.toContain('.npmrc');
		expect(workerDockerfile).not.toContain('_authToken');
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'build-config.json')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('includes github.com in worker allowed hosts', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'coding-agent',
				gatewayType: 'worker',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const systemConfig = JSON.parse(
			await fs.readFile(path.join(targetDir, 'config', 'system.json'), 'utf8'),
		) as { readonly zones: [{ readonly allowedHosts: readonly string[] }] };

		expect(systemConfig.zones[0].allowedHosts).toContain('api.github.com');
		expect(systemConfig.zones[0].allowedHosts).toContain('github.com');
	});
});
