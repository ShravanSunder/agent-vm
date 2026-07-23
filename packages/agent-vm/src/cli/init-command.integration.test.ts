import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	DEFAULT_COMMON_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_AGENT_INSTRUCTIONS,
	DEFAULT_PLAN_REVIEWER_INSTRUCTIONS,
	DEFAULT_WORK_AGENT_INSTRUCTIONS,
	DEFAULT_WORK_REVIEWER_INSTRUCTIONS,
	DEFAULT_WRAPUP_INSTRUCTIONS,
	loadWorkerConfigDraft,
} from '@agent-vm/agent-vm-worker';
import { toolPortalConfigSchema } from '@agent-vm/config-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadJsonConfigFile } from '../config/json-config-file.js';
import { loadSystemConfig } from '../config/system-config.js';
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

async function readGeneratedSystemConfig(targetDir: string): Promise<GeneratedSystemConfigForTest> {
	return generatedSystemConfigSchema.parse(
		await loadJsonConfigFile(path.join(targetDir, 'config', 'system.jsonc')),
	);
}

async function readGeneratedJsonc(filePath: string): Promise<unknown> {
	return await loadJsonConfigFile(filePath);
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
};

const scaffoldedSystemConfigSchema = z.object({
	$schema: z.string().min(1),
	schemaVersion: z.literal(2),
	storageRootDir: z.string().min(1),
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

/**
 * Narrower schema for tests that assert storage paths written into
 * the scaffolded `system.json` (storageRootDir + optional backupDir).
 * Validates instead of
 * `as`-casting `JSON.parse` output.
 */
const scaffoldedRuntimePathsSchema = z.object({
	schemaVersion: z.literal(2),
	storageRootDir: z.string().min(1),
	host: z.object({
		projectNamespace: z.string().min(1),
	}),
	zones: z.tuple([
		z.object({
			gateway: z.union([
				z.object({
					type: z.literal('openclaw'),
					controlAuth: z.object({
						mode: z.literal('token'),
						secret: z.string().min(1),
					}),
					backupDir: z.string().min(1).optional(),
				}),
				z.object({
					type: z.literal('worker'),
					backupDir: z.string().min(1).optional(),
				}),
			]),
		}),
	]),
});

const generatedSystemConfigSchema = z
	.object({
		host: z
			.object({
				githubToken: z.object({
					envVar: z.string().optional(),
					ref: z.string().optional(),
					source: z.string().optional(),
				}),
				projectNamespace: z.string().min(1).optional(),
				secretsProvider: z
					.object({
						tokenSource: z
							.object({
								type: z.string(),
								service: z.string().optional(),
								account: z.string().optional(),
							})
							.optional(),
					})
					.optional(),
			})
			.passthrough(),
		imageProfiles: z
			.object({
				gateways: z.record(
					z.string(),
					z.object({ buildConfig: z.string(), dockerfile: z.string().optional() }).passthrough(),
				),
				toolVms: z
					.record(
						z.string(),
						z.object({ buildConfig: z.string(), dockerfile: z.string().optional() }).passthrough(),
					)
					.optional(),
			})
			.optional(),
		tcpPool: z.object({ basePort: z.number(), size: z.number() }).optional(),
		toolVmProfiles: z
			.record(z.string(), z.object({ imageProfile: z.string() }).passthrough())
			.optional(),
		zones: z.tuple([
			z
				.object({
					egressHosts: z
						.array(
							z.object({
								host: z.string(),
								audience: z.enum(['gateway', 'tool-vm', 'both']),
							}),
						)
						.optional(),
					gateway: z
						.object({ config: z.string().optional(), type: z.string().optional() })
						.passthrough(),
					adminAccess: z.object({ mode: z.literal('none') }).optional(),
					runtimeAuthHints: z
						.array(
							z
								.object({
									hosts: z.array(z.string()).optional(),
									kind: z.string(),
									secret: z.string(),
									service: z.string(),
									tools: z.array(z.string()).optional(),
								})
								.passthrough(),
						)
						.optional(),
					secrets: z
						.record(
							z.string(),
							z
								.object({
									envVar: z.string().optional(),
									ref: z.string().optional(),
									source: z.string().optional(),
								})
								.passthrough(),
						)
						.default({}),
					agentToolVmProfiles: z.record(z.string(), z.string()).optional(),
					defaultToolVmProfile: z.string().optional(),
					toolPortal: z
						.object({
							configDir: z.string(),
							surfaceEligibilityByProfile: z.record(
								z.string(),
								z.record(z.string(), z.array(z.enum(['mcp', 'protected_uds']))),
							),
						})
						.optional(),
				})
				.passthrough(),
		]),
	})
	.passthrough();

type GeneratedSystemConfigForTest = z.infer<typeof generatedSystemConfigSchema>;

const generatedSecretReferenceSchema = z.object({
	ref: z.string().min(1),
});

const generatedOpenClawToolVmSystemConfigSchema = generatedSystemConfigSchema.extend({
	imageProfiles: z.object({
		toolVms: z.object({
			default: z.object({
				buildConfig: z.string(),
				source: z.object({
					kind: z.literal('managedBase'),
					base: z.literal('tool-vm'),
					overlay: z.string(),
				}),
			}),
		}),
	}),
	tcpPool: z.object({ basePort: z.number(), size: z.number() }),
	toolVmProfiles: z.object({
		standard: z
			.object({
				imageProfile: z.string(),
				runtimeRootfsSize: z.string(),
			})
			.passthrough(),
	}),
	zones: z.tuple([
		z
			.object({
				defaultToolVmProfile: z.string(),
				gateway: z.object({ runtimeRootfsSize: z.string() }).passthrough(),
			})
			.passthrough(),
	]),
});

const generatedManagedImageOverlaySchema = z.object({
	schemaVersion: z.literal(1),
	extraAptPackages: z.array(z.string()),
	packageOverrides: z
		.object({
			npm: z.array(z.string()).optional(),
			openclaw: z.array(z.string()).optional(),
			pnpm: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
	copy: z.array(z.unknown()),
	runAfterBase: z.array(z.string()),
});

const generatedBuildConfigSchema = z.object({
	rootfs: z.object({
		sizeMb: z.number(),
	}),
});

describe('scaffoldAgentVmProject', () => {
	it('creates system.jsonc with the requested zone', async () => {
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
		const systemJsonText = await fs.readFile(
			path.join(targetDir, 'config', 'system.jsonc'),
			'utf8',
		);
		const config = scaffoldedSystemConfigSchema.parse(await readGeneratedSystemConfig(targetDir));

		expect(result.created).toContain('config/system.jsonc');
		expect(result.created).toContain('config/schemas/system.schema.json');
		expect(result.created).toContain('config/schemas/mcp.schema.json');
		expect(result.created).toContain('config/schemas/mcp-portal.schema.json');
		expect(config.$schema).toBe('./schemas/system.schema.json');
		expect(config.schemaVersion).toBe(2);
		expect(config.host.projectNamespace).toMatch(/^agent-vm-init-test-/u);
		expect(config.storageRootDir).toBe(`../.agent-vm/${config.host.projectNamespace}`);
		expect(config.zones[0]?.id).toBe('test-zone');
		expect(config.zones[0]?.gateway.type).toBe('openclaw');
		expect(systemJsonText).not.toContain('workspaceDir');
		await expect(
			readGeneratedJsonc(path.join(targetDir, 'config', 'schemas', 'system.schema.json')),
		).resolves.toMatchObject({
			$id: 'agent-vm:system:2',
			properties: {
				storageRootDir: { minLength: 1, type: 'string' },
			},
			required: expect.arrayContaining(['storageRootDir']),
		});
		await expect(
			readGeneratedJsonc(path.join(targetDir, 'config', 'schemas', 'mcp.schema.json')),
		).resolves.toMatchObject({ $id: 'agent-vm:mcp:1' });
		await expect(
			readGeneratedJsonc(path.join(targetDir, 'config', 'schemas', 'mcp-portal.schema.json')),
		).resolves.toMatchObject({ $id: 'agent-vm:mcp-portal:1' });
	});

	it('rejects an explicit project namespace before using it in storage paths', async () => {
		const targetDir = await createTestDirectory();

		await expect(
			scaffoldAgentVmProject(
				{
					targetDir,
					zoneId: 'test-zone',
					gatewayType: 'openclaw',
					architecture: 'aarch64',
					secretsProvider: '1password',
					projectNamespace: '../escape',
				},
				noGeneratedAgeIdentityDependencies,
			),
		).rejects.toThrow(/projectNamespace must use lowercase letters, numbers, and hyphens only/u);
		await expect(pathExists(path.join(targetDir, 'config', 'system.jsonc'))).resolves.toBe(false);
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
		const config = scaffoldedSystemConfigSchema.parse(await readGeneratedSystemConfig(targetDir));
		const systemConfig = await readGeneratedSystemConfig(targetDir);

		expect(config.zones[0]?.gateway.type).toBe('worker');
		expect(systemConfig.imageProfiles?.gateways.worker?.source).toEqual({
			kind: 'managedBase',
			base: 'worker-gateway',
			overlay: '../vm-images/gateways/worker/overlay.jsonc',
		});
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'gateways', 'worker', 'Dockerfile')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'gateways', 'worker', 'overlay.jsonc')),
		).resolves.toBeUndefined();
	});

	it('scaffolds worker.jsonc with editable prompt file references for every default prompt', async () => {
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
			'worker.jsonc',
		);
		const rawWorkerConfig = z
			.object({
				commonAgentInstructions: z.unknown(),
				phases: z.object({
					plan: z.object({
						agentInstructions: z.unknown(),
						reviewerInstructions: z.unknown(),
					}),
					work: z.object({
						agentInstructions: z.unknown(),
						reviewerInstructions: z.unknown(),
					}),
					wrapup: z.object({ instructions: z.unknown() }),
				}),
				wrapupActions: z.unknown().optional(),
			})
			.parse(await readGeneratedJsonc(workerConfigPath));
		const workerConfig = await loadWorkerConfigDraft(workerConfigPath);

		expect(rawWorkerConfig.commonAgentInstructions).toEqual({
			path: './prompts/common-agent-instructions.md',
		});
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
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			fs.readFile(
				path.join(
					targetDir,
					'config',
					'gateways',
					'test-worker',
					'prompts',
					'common-agent-instructions.md',
				),
				'utf8',
			),
		).resolves.toBe(`${DEFAULT_COMMON_AGENT_INSTRUCTIONS}\n`);
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

		expect(workerConfig.commonAgentInstructions).toBe(`${DEFAULT_COMMON_AGENT_INSTRUCTIONS}\n`);
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
		expect(workerConfig.phases.plan.cycle).toEqual({ kind: 'review', cycleCount: 2 });
		expect(workerConfig.phases.work.cycle).toEqual({ kind: 'review', cycleCount: 4 });
		expect(rawWorkerConfig.wrapupActions).toBeUndefined();
		expect(workerConfig.mcpServers).toEqual([
			{ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' },
		]);
	});

	it('scaffolds openclaw gateways with a managed base image overlay', async () => {
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
		const systemConfig = await readGeneratedSystemConfig(targetDir);
		const overlay = generatedManagedImageOverlaySchema.parse(
			await readGeneratedJsonc(
				path.join(targetDir, 'vm-images', 'gateways', 'openclaw', 'overlay.jsonc'),
			),
		);

		expect(systemConfig.imageProfiles?.gateways.openclaw?.source).toEqual({
			kind: 'managedBase',
			base: 'openclaw-gateway',
			overlay: '../vm-images/gateways/openclaw/overlay.jsonc',
		});
		expect(overlay).toEqual({
			schemaVersion: 1,
			extraAptPackages: [],
			copy: [],
			runAfterBase: [],
		});
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'gateways', 'openclaw', 'Dockerfile')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		expect(
			await pathExists(
				path.join(targetDir, 'vm-images', 'gateways', 'openclaw', 'vendor', 'gondolin'),
			),
		).toBe(false);
	});

	it('scaffolds generated deployment manual files and CLAUDE.md symlink', async () => {
		const targetDir = await createTestDirectory();

		const result = await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-openclaw',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);

		expect(result.created).toEqual(
			expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', 'docs/manual/README.md']),
		);
		expect(await fs.readFile(path.join(targetDir, 'AGENTS.md'), 'utf8')).toContain(
			'docs/manual/README.md',
		);
		expect(
			await fs.readFile(path.join(targetDir, 'docs', 'manual', 'layout.md'), 'utf8'),
		).toContain('zoneRuntimeDir/gitdirs/agents/<agentId>/workspace.git');
		const perAgentManual = await fs.readFile(
			path.join(targetDir, 'docs', 'manual', 'per-agent-setup.md'),
			'utf8',
		);
		expect(perAgentManual).toContain('Do not run raw git push.');
		expect(perAgentManual).toContain('controller-owned workspace_git_push Tool Portal action');
		expect(perAgentManual).not.toContain('gateway.zoneGit');
		expect(perAgentManual).not.toContain('zone_git_push');
		expect(await fs.readlink(path.join(targetDir, 'CLAUDE.md'))).toBe('AGENTS.md');
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
		const config = z
			.object({
				host: z.object({
					secretsProvider: z.object({
						tokenSource: z.object({
							type: z.string(),
							service: z.string(),
							account: z.string(),
						}),
					}),
				}),
			})
			.parse(await readGeneratedSystemConfig(targetDir));

		expect(config.host.secretsProvider.tokenSource).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account',
		});
	});

	it('scaffolds an isolated macOS Keychain account when configured', async () => {
		const targetDir = await createTestDirectory();
		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'test-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				onePasswordKeychainAccountName: 'shravan-claw-beta',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const config = z
			.object({
				host: z.object({
					secretsProvider: z.object({
						tokenSource: z.object({
							type: z.string(),
							service: z.string(),
							account: z.string(),
						}),
					}),
				}),
			})
			.parse(await readGeneratedSystemConfig(targetDir));

		expect(config.host.secretsProvider.tokenSource).toEqual({
			type: 'keychain',
			service: 'agent-vm',
			account: '1p-service-account--shravan-claw-beta',
		});
	});

	it('does not append an unused age identity to .env.local', async () => {
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
		const envContent = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).not.toMatch(/^AGE_IDENTITY_KEY=/mu);
	});

	it('does not run age-keygen for macOS local scaffolds', async () => {
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
		const envContent = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');

		expect(envContent).not.toMatch(/^AGE_IDENTITY_KEY=/mu);
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
		const systemConfig = scaffoldedRuntimePathsSchema.parse(
			await readGeneratedSystemConfig(targetDir),
		);
		const storageRootDir = path.join(targetDir, '.agent-vm', systemConfig.host.projectNamespace);

		expect(await pathExists(path.join(targetDir, 'config', 'gateways', 'my-zone'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'cache'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'controller-state'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'controller-runtime'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'my-zone', 'state'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'my-zone', 'runtime'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'my-zone', 'zone-files'))).toBe(true);
		expect(await pathExists(path.join(targetDir, 'backups', 'my-zone'))).toBe(true);
		expect(await pathExists(path.join(targetDir, 'workspaces', 'tools'))).toBe(false);
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
		expect(await pathExists(path.join(targetDir, 'controller-state'))).toBe(false);
		expect(await pathExists(path.join(targetDir, 'state'))).toBe(false);
		expect(await pathExists(path.join(targetDir, 'workspaces'))).toBe(false);
	});

	it('writes user-dir paths as absolute paths under the scaffold-time home directory', async () => {
		const targetDir = await createTestDirectory();
		const fakeHomeDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'shravan',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				paths: 'user-dir',
			},
			{
				...noGeneratedAgeIdentityDependencies,
				getHomeDir: () => fakeHomeDir,
			},
		);

		const systemConfigPath = path.join(targetDir, 'config', 'system.jsonc');
		const systemConfig = scaffoldedRuntimePathsSchema.parse(
			await readGeneratedSystemConfig(targetDir),
		);
		const loadedSystemConfig = await loadSystemConfig(systemConfigPath);
		const canonicalFakeHomeDir = await fs.realpath(fakeHomeDir);

		const expectedStorageRoot = path.join(
			fakeHomeDir,
			'.agent-vm',
			systemConfig.host.projectNamespace,
		);
		expect(systemConfig.storageRootDir).toBe(expectedStorageRoot);
		if (systemConfig.zones[0].gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw scaffold to write an OpenClaw gateway.');
		}
		expect(systemConfig.zones[0].gateway.backupDir).toBe(
			path.join(fakeHomeDir, '.agent-vm-backups', 'shravan'),
		);
		const expectedCanonicalStorageRoot = path.join(
			canonicalFakeHomeDir,
			'.agent-vm',
			systemConfig.host.projectNamespace,
		);
		expect(loadedSystemConfig.storageRootDir).toBe(expectedCanonicalStorageRoot);
		expect(loadedSystemConfig.cacheDir).toBe(path.join(expectedCanonicalStorageRoot, 'cache'));
		expect(loadedSystemConfig.controllerStateDir).toBe(
			path.join(expectedCanonicalStorageRoot, 'controller-state'),
		);
		expect(loadedSystemConfig.controllerRuntimeDir).toBe(
			path.join(expectedCanonicalStorageRoot, 'controller-runtime'),
		);
		expect(loadedSystemConfig.zones[0]?.gateway.stateDir).toBe(
			path.join(expectedCanonicalStorageRoot, 'shravan', 'state'),
		);
		if (loadedSystemConfig.zones[0]?.gateway.type !== 'openclaw') {
			throw new Error('Expected loaded scaffold to be an OpenClaw gateway.');
		}
		expect(loadedSystemConfig.zones[0].gateway.zoneFilesDir).toBe(
			path.join(expectedCanonicalStorageRoot, 'shravan', 'zone-files'),
		);
		expect(loadedSystemConfig.zones[0].gateway.zoneRuntimeDir).toBe(
			path.join(expectedCanonicalStorageRoot, 'shravan', 'runtime'),
		);
		expect(loadedSystemConfig.zones[0]?.gateway.backupDir).toBe(
			path.join(fakeHomeDir, '.agent-vm-backups', 'shravan'),
		);
	});

	it('user-dir scaffold creates configured ~/.agent-vm dirs, not repo-local ones', async () => {
		const targetDir = await createTestDirectory();
		const fakeHomeDir = await createTestDirectory();

		// Inject a fake home so the scaffolder writes ~/.agent-vm dirs into a
		// sandboxed tempdir instead of the real $HOME. Without this, a passing
		// test would silently mutate the developer's home directory.
		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'shravan',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
				paths: 'user-dir',
			},
			{
				...noGeneratedAgeIdentityDependencies,
				getHomeDir: () => fakeHomeDir,
			},
		);
		const systemConfig = scaffoldedRuntimePathsSchema.parse(
			await readGeneratedSystemConfig(targetDir),
		);
		const storageRootDir = path.join(fakeHomeDir, '.agent-vm', systemConfig.host.projectNamespace);

		// user-dir profile should NOT create misleading repo-local runtime dirs
		expect(await pathExists(path.join(targetDir, 'state'))).toBe(false);
		expect(await pathExists(path.join(targetDir, 'workspaces'))).toBe(false);

		// user-dir profile SHOULD create the dirs it advertises in system.json
		expect(await pathExists(path.join(storageRootDir, 'cache'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'controller-state'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'controller-runtime'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'shravan', 'state'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'shravan', 'runtime'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'shravan', 'zone-files'))).toBe(true);
		expect(await pathExists(path.join(fakeHomeDir, '.agent-vm-backups', 'shravan'))).toBe(true);
		expect(await pathExists(path.join(storageRootDir, 'workspaces', 'tools'))).toBe(false);
	});

	it('writes backupDir for local profile alongside the storage root', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'my-zone',
				gatewayType: 'worker',
				architecture: 'aarch64',
				secretsProvider: '1password',
				paths: 'local',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const systemConfig = scaffoldedRuntimePathsSchema.parse(
			await readGeneratedSystemConfig(targetDir),
		);

		expect(systemConfig.storageRootDir).toBe(`../.agent-vm/${systemConfig.host.projectNamespace}`);
		expect(systemConfig.zones[0].gateway.backupDir).toBe('../backups/my-zone');
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
			await pathExists(path.join(workerTargetDir, 'config', 'gateways', 'my-zone', 'worker.jsonc')),
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
			readonly agents: {
				readonly defaults: {
					readonly model: { readonly primary: string };
					readonly models?: Record<string, { readonly agentRuntime?: { readonly id?: string } }>;
					readonly thinkingDefault?: string;
					readonly workspace: string;
				};
			};
			readonly gateway: {
				readonly controlUi: {
					readonly allowedOrigins: readonly string[];
				};
				readonly http: {
					readonly endpoints: {
						readonly chatCompletions: {
							readonly enabled: boolean;
						};
					};
				};
			};
			readonly plugins: {
				readonly load: {
					readonly paths: readonly string[];
				};
			};
			readonly approvals: {
				readonly plugin: {
					readonly enabled: boolean;
					readonly mode: string;
				};
			};
			readonly tools: {
				readonly allow: readonly string[];
				readonly sandbox: {
					readonly tools: {
						readonly alsoAllow: readonly string[];
					};
				};
				readonly web: {
					readonly fetch: {
						readonly ssrfPolicy: {
							readonly allowIpv6UniqueLocalRange: boolean;
							readonly allowRfc2544BenchmarkRange: boolean;
						};
					};
				};
			};
		};
		const systemConfig = await readGeneratedSystemConfig(targetDir);

		expect(openClawConfig.gateway.controlUi.allowedOrigins).toEqual([
			'http://127.0.0.1:18791',
			'http://localhost:18791',
		]);
		expect(openClawConfig.plugins.load.paths).toEqual([
			'/home/openclaw/.openclaw/extensions',
			'/home/openclaw/.openclaw/extensions/gondolin',
			'/pnpm/global/5/node_modules/@openclaw',
			'/pnpm/global/5/node_modules/@agent-vm',
		]);
		expect(openClawConfig.gateway.http.endpoints.chatCompletions.enabled).toBe(true);
		expect(openClawConfig.agents.defaults.model.primary).toBe('openai/gpt-5.5');
		expect(openClawConfig.agents.defaults.thinkingDefault).toBeUndefined();
		expect(openClawConfig.agents.defaults.workspace).toBe('/zone/agents/default');
		expect(systemConfig.zones[0].toolPortal).toEqual({
			configDir: './gateways/my-zone',
			surfaceEligibilityByProfile: { default: {} },
		});
		expect(openClawConfig.agents.defaults.models).toEqual({
			'openai/gpt-5.5': {
				agentRuntime: { id: 'pi' },
			},
		});
		expect(openClawConfig.approvals).toEqual({
			plugin: {
				enabled: true,
				mode: 'session',
			},
		});
		expect(openClawConfig.tools.web.fetch.ssrfPolicy).toEqual({
			allowIpv6UniqueLocalRange: true,
			allowRfc2544BenchmarkRange: true,
		});
		expect(openClawConfig.tools.allow).toEqual(['*']);
		expect(openClawConfig.tools.sandbox.tools.alsoAllow).toEqual([
			'web_search',
			'web_fetch',
			'message',
			'group:plugins',
		]);
	});

	it('scaffolds OpenClaw agents with managed Tool Portal assignments', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'my-zone',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				agents: ['sun', 'shravan', 'alevtina'],
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
			readonly agents: {
				readonly defaults: {
					readonly workspace: string;
				};
				readonly list?: readonly {
					readonly id: string;
					readonly identity?: { readonly name?: string };
					readonly tools?: { readonly deny?: readonly string[] };
					readonly workspace?: string;
				}[];
			};
			readonly mcp?: {
				readonly servers?: Record<
					string,
					{
						readonly headers?: Record<string, string>;
						readonly transport?: string;
						readonly url?: string;
					}
				>;
			};
		};

		expect(openClawConfig.agents.defaults.workspace).toBe('/zone/agents/default');
		expect(openClawConfig.agents.list).toEqual([
			{
				id: 'sun',
				workspace: '/zone/agents/sun',
				identity: { name: 'Sun' },
				tools: { deny: [] },
			},
			{
				id: 'shravan',
				workspace: '/zone/agents/shravan',
				identity: { name: 'Shravan' },
				tools: { deny: [] },
			},
			{
				id: 'alevtina',
				workspace: '/zone/agents/alevtina',
				identity: { name: 'Alevtina' },
				tools: { deny: [] },
			},
		]);
		expect(openClawConfig.mcp?.servers?.mcp_portal_sun).toBeUndefined();
		await expect(
			readGeneratedJsonc(path.join(targetDir, 'config', 'gateways', 'my-zone', 'mcp.config.jsonc')),
		).resolves.toMatchObject({
			$schema: '../../schemas/mcp.schema.json',
			schemaVersion: 1,
			providers: {},
		});
		const toolPortalConfig = toolPortalConfigSchema.parse(
			await readGeneratedJsonc(
				path.join(targetDir, 'config', 'gateways', 'my-zone', 'tool-portal.config.jsonc'),
			),
		);
		expect(toolPortalConfig).toEqual({
			$schema: '../../schemas/tool-portal.schema.json',
			schemaVersion: 1,
			agents: {
				sun: { profile: 'default' },
				shravan: { profile: 'default' },
				alevtina: { profile: 'default' },
			},
			mode: 'managed',
			profiles: { default: { namespaces: {} } },
		});
		await expect(
			pathExists(path.join(targetDir, 'config', 'gateways', 'my-zone', 'mcp-portal.config.jsonc')),
		).resolves.toBe(false);
	});

	it('scaffolds control-ui allowed origins from an existing zone ingress port', async () => {
		const targetDir = await createTestDirectory();
		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'shravan',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);
		const systemConfigPath = path.join(targetDir, 'config', 'system.jsonc');
		const systemConfig = await readGeneratedSystemConfig(targetDir);
		const parsedSystemConfig = z
			.object({
				zones: z.tuple([
					z.object({
						id: z.literal('shravan'),
						gateway: z.object({
							port: z.number().int().positive(),
						}),
					}),
					z
						.object({
							id: z.literal('alevtina'),
							gateway: z.object({
								port: z.number().int().positive(),
							}),
						})
						.optional(),
				]),
			})
			.parse({
				...systemConfig,
				zones: [
					systemConfig.zones[0],
					{
						...systemConfig.zones[0],
						id: 'alevtina',
						gateway: {
							...systemConfig.zones[0].gateway,
							config: './gateways/alevtina/openclaw.json',
							port: 18792,
						},
					},
				],
			});
		await fs.writeFile(
			systemConfigPath,
			`${JSON.stringify({ ...systemConfig, zones: parsedSystemConfig.zones }, null, '\t')}\n`,
			'utf8',
		);

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'alevtina',
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				secretsProvider: '1password',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const openClawConfig = z
			.object({
				gateway: z.object({
					controlUi: z.object({
						allowedOrigins: z.array(z.string()),
					}),
				}),
			})
			.parse(
				JSON.parse(
					await fs.readFile(
						path.join(targetDir, 'config', 'gateways', 'alevtina', 'openclaw.json'),
						'utf8',
					),
				),
			);

		expect(openClawConfig.gateway.controlUi.allowedOrigins).toEqual([
			'http://127.0.0.1:18792',
			'http://localhost:18792',
		]);
	});

	it('fails loudly when an existing system config does not define the scaffolded zone port', async () => {
		const targetDir = await createTestDirectory();
		await fs.mkdir(path.join(targetDir, 'config'), { recursive: true });
		await fs.writeFile(
			path.join(targetDir, 'config', 'system.json'),
			`${JSON.stringify(
				{
					zones: [
						{
							id: 'shravan',
							gateway: { port: 18791 },
						},
					],
				},
				null,
				'\t',
			)}\n`,
			'utf8',
		);

		await expect(
			scaffoldAgentVmProject(
				{
					targetDir,
					zoneId: 'alevtina',
					gatewayType: 'openclaw',
					architecture: 'aarch64',
					secretsProvider: '1password',
				},
				noGeneratedAgeIdentityDependencies,
			),
		).rejects.toThrow(/does not define zone 'alevtina'/u);
	});

	it('does not overwrite an existing system.json', async () => {
		const targetDir = await createTestDirectory();
		await fs.mkdir(path.join(targetDir, 'config'), { recursive: true });
		await fs.writeFile(
			path.join(targetDir, 'config', 'system.json'),
			`${JSON.stringify(
				{
					existing: true,
					zones: [
						{
							id: 'test-zone',
							gateway: { port: 18791 },
						},
					],
				},
				null,
				'\t',
			)}\n`,
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

		const config = await readGeneratedSystemConfig(targetDir);
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

		const config = await readGeneratedSystemConfig(targetDir);
		const secrets = config.zones[0].secrets;

		expect(secrets).not.toHaveProperty('DISCORD_BOT_TOKEN');
		expect(secrets).toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
		expect(secrets).not.toHaveProperty('MCP_PORTAL_SERVER_SECRET');
		expect(secrets).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(generatedSecretReferenceSchema.parse(secrets.PERPLEXITY_API_KEY).ref).toBe(
			'op://agent-vm/test-openclaw-perplexity/credential',
		);
		expect(generatedSecretReferenceSchema.parse(secrets.OPENCLAW_GATEWAY_TOKEN).ref).toBe(
			'op://agent-vm/test-openclaw-gateway-auth/password',
		);
		expect(config.zones[0].adminAccess).toEqual({ mode: 'none' });
		expect(config.zones[0].gateway.controlAuth).toEqual({
			mode: 'token',
			secret: 'OPENCLAW_GATEWAY_TOKEN',
		});
		expect(config.zones[0].gateway.ssh).toEqual({ secretEnv: 'explicit' });
		expect(config.zones[0].gateway.rawEnvSecrets).toBeUndefined();
	});

	it('scaffolds broad model-provider network defaults for openclaw type', async () => {
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

		const config = await readGeneratedSystemConfig(targetDir);
		const zone = config.zones[0];
		const egressHosts = (zone.egressHosts ?? []).map((entry) => entry.host);

		expect(egressHosts).toEqual(
			expect.arrayContaining([
				'api.anthropic.com',
				'api.openai.com',
				'auth.openai.com',
				'chatgpt.com',
				'generativelanguage.googleapis.com',
				'oauth2.googleapis.com',
				'accounts.google.com',
				'api.x.ai',
				'api.groq.com',
				'api.mistral.ai',
				'api.deepseek.com',
				'api.openrouter.ai',
				'openrouter.ai',
				'api.perplexity.ai',
				'api.together.xyz',
				'api.fireworks.ai',
				'api.cerebras.ai',
				'api.cohere.ai',
			]),
		);
		expect(egressHosts).not.toContain('discord.com');
		expect(egressHosts).not.toContain('cdn.discordapp.com');
		expect(zone).not.toHaveProperty('allowedHosts');
		expect(zone).not.toHaveProperty('runtimeAuthHints');
		expect(zone).not.toHaveProperty('websocketBypass');
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

		const config = generatedOpenClawToolVmSystemConfigSchema.parse(
			await readGeneratedSystemConfig(targetDir),
		);

		expect(config.zones[0].defaultToolVmProfile).toBe('standard');
		expect(config.tcpPool).toEqual({ basePort: 19000, size: 12 });
		expect(config.toolVmProfiles.standard.imageProfile).toBe('default');
		expect(config.toolVmProfiles.standard.runtimeRootfsSize).toBe('16G');
		expect(config.zones[0].gateway.runtimeRootfsSize).toBe('12G');
		expect(config.toolVmProfiles.standard).not.toHaveProperty('workspaceRoot');
		expect(config.imageProfiles.toolVms.default.buildConfig).toBe(
			'../vm-images/tool-vms/default/build-config.jsonc',
		);
		expect(
			generatedBuildConfigSchema.parse(
				await readGeneratedJsonc(
					path.join(targetDir, 'vm-images', 'gateways', 'openclaw', 'build-config.jsonc'),
				),
			).rootfs.sizeMb,
		).toBe(4096);
		expect(
			generatedBuildConfigSchema.parse(
				await readGeneratedJsonc(
					path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'build-config.jsonc'),
				),
			).rootfs.sizeMb,
		).toBe(4096);
		expect(config.imageProfiles.toolVms.default.source).toEqual({
			kind: 'managedBase',
			base: 'tool-vm',
			overlay: '../vm-images/tool-vms/default/overlay.jsonc',
		});
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'build-config.json')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'build-config.jsonc')),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'Dockerfile')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'overlay.jsonc')),
		).resolves.toBeUndefined();
		expect(
			generatedManagedImageOverlaySchema.parse(
				await readGeneratedJsonc(
					path.join(targetDir, 'vm-images', 'tool-vms', 'default', 'overlay.jsonc'),
				),
			),
		).toEqual({
			schemaVersion: 1,
			extraAptPackages: [],
			copy: [],
			runAfterBase: [],
		});
		const openClawConfig = JSON.parse(
			await fs.readFile(
				path.join(targetDir, 'config', 'gateways', 'test-openclaw', 'openclaw.json'),
				'utf8',
			),
		) as {
			readonly gateway?: { readonly auth?: { readonly mode?: string } };
			readonly agents?: {
				readonly defaults?: {
					readonly sandbox?: {
						readonly backend?: string;
						readonly mode?: string;
						readonly scope?: string;
						readonly workspaceAccess?: string;
					};
				};
			};
			readonly commands?: { readonly ownerAllowFrom?: readonly string[] };
			readonly session?: { readonly dmScope?: string };
			readonly approvals?: {
				readonly plugin?: {
					readonly enabled?: boolean;
					readonly mode?: string;
				};
			};
			readonly mcp?: { readonly servers?: Record<string, unknown> };
			readonly plugins?: {
				readonly allow?: readonly string[];
				readonly slots?: { readonly memory?: string };
				readonly entries?: Record<
					string,
					{
						readonly enabled?: boolean;
						readonly hooks?: { readonly allowPromptInjection?: boolean };
					}
				>;
			};
			readonly tools?: { readonly allow?: readonly string[] };
		};
		expect(openClawConfig.gateway?.auth?.mode).toBe('token');
		expect(openClawConfig.agents?.defaults?.sandbox?.backend).toBe('gondolin');
		expect(openClawConfig.agents?.defaults?.sandbox?.mode).toBe('all');
		expect(openClawConfig.agents?.defaults?.sandbox?.scope).toBe('agent');
		expect(openClawConfig.agents?.defaults?.sandbox?.workspaceAccess).toBe('rw');
		expect(openClawConfig.session?.dmScope).toBe('per-channel-peer');
		expect(openClawConfig.approvals).toEqual({
			plugin: {
				enabled: true,
				mode: 'session',
			},
		});
		expect(openClawConfig.commands?.ownerAllowFrom).toEqual([]);
		expect(openClawConfig.plugins?.allow).toContain('memory-core');
		expect(openClawConfig.plugins?.allow).toContain('gondolin');
		expect(openClawConfig.plugins?.allow).not.toContain('mcp-portal');
		expect(openClawConfig.plugins?.slots?.memory).toBe('memory-core');
		expect(openClawConfig.plugins?.entries?.gondolin).toMatchObject({
			enabled: true,
			config: {
				zoneId: 'test-openclaw',
			},
		});
		expect(openClawConfig.plugins?.entries?.['memory-core']).toEqual({ enabled: true });
		expect(openClawConfig.plugins?.entries?.['mcp-portal']).toBeUndefined();
		expect(openClawConfig.mcp?.servers).toEqual({});
		expect(openClawConfig.tools?.allow).toEqual(['*']);
	});

	it('does not scaffold Discord environment variables for openclaw defaults', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				targetDir,
				zoneId: 'test-openclaw',
				secretsProvider: 'environment',
				writeLocalEnvironmentFile: true,
			},
			noGeneratedAgeIdentityDependencies,
		);
		const envContent = await fs.readFile(path.join(targetDir, '.env.local'), 'utf8');
		const config = await readGeneratedSystemConfig(targetDir);

		expect(envContent).toContain('# GITHUB_TOKEN=');
		expect(envContent).toContain('# PERPLEXITY_API_KEY=');
		expect(envContent).toContain('# OPENCLAW_GATEWAY_TOKEN=');
		expect(envContent).not.toContain('MCP_PORTAL_SERVER_SECRET');
		expect(envContent).not.toContain('SSH_ACCESS_TOKEN');
		expect(envContent).not.toContain('DISCORD_BOT_TOKEN');
		expect(config.zones[0].adminAccess).toEqual({ mode: 'none' });
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

		const config = await readGeneratedSystemConfig(targetDir);
		const secrets = config.zones[0].secrets;

		expect(generatedSecretReferenceSchema.parse(secrets.OPENAI_API_KEY).ref).toBe(
			'op://agent-vm/workers-openai/credential',
		);
		expect(generatedSecretReferenceSchema.parse(secrets.GITHUB_TOKEN).ref).toBe(
			'op://agent-vm/github-token/credential',
		);
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

		const config = await readGeneratedSystemConfig(targetDir);
		const zone = config.zones[0];
		const egressHosts = (zone.egressHosts ?? []).map((entry) => entry.host);

		expect(egressHosts).toContain('api.anthropic.com');
		expect(egressHosts).toContain('api.openai.com');
		expect(egressHosts).toContain('mcp.deepwiki.com');
		expect(egressHosts).not.toContain('discord.com');
		expect(zone).not.toHaveProperty('websocketBypass');
	});

	it('scaffolds worker runtime auth hints for mediated GitHub operations', async () => {
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

		const config = (await readGeneratedSystemConfig(targetDir)) as {
			readonly zones: readonly [
				{
					readonly runtimeAuthHints: readonly {
						readonly kind: string;
						readonly secret: string;
						readonly service: string;
						readonly hosts: readonly string[];
						readonly tools: readonly string[];
					}[];
				},
			];
		};

		expect(config.zones[0].runtimeAuthHints).toEqual([
			{
				kind: 'service-token',
				secret: 'GITHUB_TOKEN',
				service: 'github',
				hosts: ['api.github.com'],
				tools: ['gh'],
			},
		]);
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

		const config = await readGeneratedSystemConfig(targetDir);

		expect(config.host.githubToken).toEqual({ source: 'environment', envVar: 'GITHUB_TOKEN' });
		expect(config.host.secretsProvider).toBeUndefined();
		expect(config.zones[0].adminAccess).toEqual({ mode: 'none' });
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
			},
		);

		await expect(fs.access(path.join(targetDir, '.env.local'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('does not write .env.local for container scaffolds', async () => {
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
				writeLocalEnvironmentFile: false,
			},
			noGeneratedAgeIdentityDependencies,
		);

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
		expect(dockerfile).not.toContain('ARG GIT_SHA');
		expect(dockerfile).not.toContain('gitSha');
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

	it('scaffolds arm64 container hosts with matching config and host tooling', async () => {
		const targetDir = await createTestDirectory();

		await scaffoldAgentVmProject(
			{
				targetDir,
				zoneId: 'coding-agent',
				gatewayType: 'worker',
				architecture: 'aarch64',
				hostSystemType: 'container',
				paths: 'pod',
				secretsProvider: 'environment',
			},
			noGeneratedAgeIdentityDependencies,
		);

		const gatewayBuildConfig = z
			.object({ arch: z.literal('aarch64') })
			.parse(
				await readGeneratedJsonc(
					path.join(targetDir, 'vm-images', 'gateways', 'worker', 'build-config.jsonc'),
				),
			);
		const dockerfile = await fs.readFile(
			path.join(targetDir, 'vm-host-system', 'Dockerfile'),
			'utf8',
		);

		expect(gatewayBuildConfig.arch).toBe('aarch64');
		expect(dockerfile).toContain('zig-aarch64-linux-');
		expect(dockerfile).toContain('image pull alpine-base:latest --arch aarch64');
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

		const systemConfig = await readGeneratedSystemConfig(targetDir);
		const podWorkerSystemConfig = z
			.object({
				schemaVersion: z.literal(2),
				host: z.object({ projectNamespace: z.string().min(1) }),
				storageRootDir: z.string().min(1),
				imageProfiles: z.object({
					gateways: z.object({
						worker: z.object({
							buildConfig: z.string().min(1),
							source: z.object({
								kind: z.literal('managedBase'),
								base: z.literal('worker-gateway'),
								overlay: z.string().min(1),
							}),
						}),
					}),
					toolVms: z.record(z.string(), z.unknown()).optional(),
				}),
				zones: z.tuple([
					z.object({
						gateway: z.object({
							config: z.string().min(1),
							backupDir: z.string().min(1),
						}),
					}),
				]),
				toolVmProfiles: z.record(z.string(), z.unknown()).optional(),
			})
			.parse(systemConfig);

		expect(podWorkerSystemConfig.host.projectNamespace).toBe('agent-vm');
		expect(podWorkerSystemConfig.storageRootDir).toBe('/var/agent-vm/agent-vm');
		expect(podWorkerSystemConfig.imageProfiles.gateways.worker.buildConfig).toBe(
			'/etc/agent-vm/vm-images/gateways/worker/build-config.jsonc',
		);
		expect(podWorkerSystemConfig.imageProfiles.gateways.worker.source).toEqual({
			kind: 'managedBase',
			base: 'worker-gateway',
			overlay: '/etc/agent-vm/vm-images/gateways/worker/overlay.jsonc',
		});
		expect(podWorkerSystemConfig.imageProfiles.toolVms).toEqual({});
		expect(podWorkerSystemConfig.zones[0].gateway.config).toBe(
			'/etc/agent-vm/gateways/coding-agent/worker.jsonc',
		);
		expect(podWorkerSystemConfig.zones[0].gateway.backupDir).toBe('/var/agent-vm/backups');
		expect(podWorkerSystemConfig.zones[0].gateway).not.toHaveProperty('zoneFilesDir');
		expect(podWorkerSystemConfig.toolVmProfiles).toEqual({});

		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'gateways', 'worker', 'build-config.json')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		const gatewayBuildConfig = z
			.object({ arch: z.string() })
			.parse(
				await readGeneratedJsonc(
					path.join(targetDir, 'vm-images', 'gateways', 'worker', 'build-config.jsonc'),
				),
			);
		expect(gatewayBuildConfig.arch).toBe('x86_64');
		await expect(
			fs.access(path.join(targetDir, 'vm-images', 'gateways', 'worker', 'Dockerfile')),
		).rejects.toMatchObject({ code: 'ENOENT' });
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

		const systemConfig = (await readGeneratedSystemConfig(targetDir)) as {
			readonly zones: [{ readonly egressHosts: readonly { readonly host: string }[] }];
		};
		const egressHosts = systemConfig.zones[0].egressHosts.map((entry) => entry.host);

		expect(egressHosts).toContain('api.github.com');
		expect(egressHosts).toContain('github.com');
		expect(egressHosts).toContain('mcp.deepwiki.com');
	});
});
