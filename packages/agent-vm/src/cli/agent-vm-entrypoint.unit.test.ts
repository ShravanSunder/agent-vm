import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SecretRef } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ControllerRuntime } from '../controller/controller-runtime-types.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import { defaultCliDependencies, type CliDependencies } from './agent-vm-cli-support.js';
import {
	handleCliMainError,
	isCliEntrypoint,
	loadOptionalLocalEnvironmentFile,
	ReportedCliError,
	runAgentVmCli,
} from './agent-vm-entrypoint.js';
import { parseAgentIds } from './commands/init-definition.js';

function createCliBuildSystemConfig(): LoadedSystemConfig {
	return {
		schemaVersion: 1,
		cacheDir: './cache',
		runtimeDir: './runtime',
		systemConfigPath: './config/system.json',
		host: {
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env' },
			},
		},
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: './vm-images/gateways/openclaw/build-config.json',
					dockerfile: './vm-images/gateways/openclaw/Dockerfile',
				},
				worker: {
					type: 'worker',
					buildConfig: './vm-images/gateways/worker/build-config.json',
					dockerfile: './vm-images/gateways/worker/Dockerfile',
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: './vm-images/tool-vms/default/build-config.json',
					dockerfile: './vm-images/tool-vms/default/Dockerfile',
				},
			},
		},
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
		toolVmProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
		},
		zones: [
			{
				egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
				gateway: {
					type: 'openclaw',
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					imageProfile: 'openclaw',
					cpus: 2,
					memory: '2G',
					config: './config/shravan/openclaw.json',
					port: 18791,
					stateDir: './state/shravan',
					zoneFilesDir: './zone-files/shravan',
					authLogin: {
						defaultAgent: 'main',
						providers: {
							openai: {
								profileIds: ['openai-codex:test@example.com'],
							},
						},
					},
				},
				id: 'shravan',
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
			},
		],
	};
}

function createCliBuildSystemConfigWithAgents(): LoadedSystemConfig {
	const systemConfig = createCliBuildSystemConfig();
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected CLI test config to include a zone.');
	}
	return {
		...systemConfig,
		zones: [
			{
				...zone,
				agents: [{ id: 'shravan' }, { id: 'ember' }],
			},
		],
	};
}

function createCliBuildWorkerSystemConfig(): LoadedSystemConfig {
	const systemConfig = createCliBuildSystemConfig();
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected CLI test config to include a zone.');
	}
	return {
		...systemConfig,
		zones: [
			{
				...zone,
				gateway: {
					type: 'worker',
					imageProfile: 'worker',
					cpus: 2,
					memory: '2G',
					config: './config/shravan/worker.json',
					port: 18791,
					stateDir: './state/shravan',
				},
			},
		],
	};
}

function createStartedControllerRuntime(
	options: {
		readonly controllerPort?: number;
		readonly ingressHost?: string;
		readonly ingressPort?: number;
		readonly vmId?: string;
		readonly zoneId?: string;
	} = {},
): ControllerRuntime {
	return {
		controllerPort: options.controllerPort ?? 18800,
		zones: [
			{
				gateway: {
					ingress: {
						host: options.ingressHost ?? '127.0.0.1',
						port: options.ingressPort ?? 18791,
					},
					vm: {
						id: options.vmId ?? 'vm-123',
					},
				},
				lifecycleState: 'running',
				zoneId: options.zoneId ?? 'shravan',
			},
		],
		close: async () => {},
	};
}

function createCliBuildSystemConfigWithoutConfiguredAgents(): LoadedSystemConfig {
	const systemConfig = createCliBuildSystemConfig();
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected CLI test config to include a zone.');
	}
	return {
		...systemConfig,
		zones: [
			{
				...zone,
				agents: [],
			},
		],
	};
}

function createControllerClientStub(
	enableZoneSsh: ControllerClient['enableZoneSsh'],
): ControllerClient {
	return {
		destroyZone: async () => ({}),
		enableZoneSsh,
		execInZone: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
		getControllerStatus: async () => ({}),
		getZoneLogs: async () => ({}),
		refreshZoneCredentials: async () => ({}),
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

describe('runAgentVmCli', () => {
	it('parses OpenClaw init agent ids with validation and dedupe', () => {
		expect(parseAgentIds(' sun,shravan, sun ,alevtina ')).toEqual(['sun', 'shravan', 'alevtina']);
		expect(() => parseAgentIds(' , , ')).toThrow(
			'--openclaw-agents must include at least one non-empty agent id.',
		);
		expect(() => parseAgentIds('sun,Hello World')).toThrow(
			"Invalid --openclaw-agents value 'Hello World'",
		);
	});

	it('ignores a missing .env.local file', () => {
		const loadEnvFileSpy = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
			const missingFileError = new Error('missing');
			Object.assign(missingFileError, { code: 'ENOENT' });
			throw missingFileError;
		});

		expect(() => loadOptionalLocalEnvironmentFile('.env.local')).not.toThrow();
		expect(loadEnvFileSpy).toHaveBeenCalledWith('.env.local');
	});

	it('surfaces non-ENOENT .env.local load failures', () => {
		const loadEnvFileSpy = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
			throw new Error('bad dotenv syntax');
		});

		expect(() => loadOptionalLocalEnvironmentFile('.env.local')).toThrow(
			'Failed to load .env.local: bad dotenv syntax',
		);
		expect(loadEnvFileSpy).toHaveBeenCalledWith('.env.local');
	});

	it('prints the resolved package version', async () => {
		const outputs: string[] = [];

		await runAgentVmCli(
			['-v'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				resolveCliVersion: async () => '9.8.7',
			},
		);

		expect(outputs.join('')).toBe('9.8.7\n');
	});

	it('recognizes symlinked package-manager bin paths as the CLI entrypoint', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-entrypoint-'));
		const realEntrypointPath = path.join(targetDir, 'real-entrypoint.js');
		const symlinkEntrypointPath = path.join(targetDir, 'agent-vm');
		await fs.writeFile(realEntrypointPath, 'export {};\n', 'utf8');
		await fs.symlink(realEntrypointPath, symlinkEntrypointPath);

		expect(isCliEntrypoint(pathToFileURL(realEntrypointPath).href, symlinkEntrypointPath)).toBe(
			true,
		);
		expect(isCliEntrypoint(`file://${realEntrypointPath}`, undefined)).toBe(false);

		await fs.rm(targetDir, { force: true, recursive: true });
	});

	it('routes init to the project scaffolder', async () => {
		const outputs: string[] = [];
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json', '.env.local'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			['init', 'test-zone', '--type', 'openclaw', '--secrets', '1password', '--arch', 'aarch64'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith(
			expect.objectContaining({
				gatewayType: 'openclaw',
				architecture: 'aarch64',
				hostSystemType: 'bare-metal',
				paths: 'local',
				secretsProvider: '1password',
				targetDir: '/tmp/agent-vm-init',
				writeLocalEnvironmentFile: false,
				zoneId: 'test-zone',
			}),
		);
		expect(outputs.join('')).toContain('"config/system.json"');
	});

	it('routes init Keychain account names to the scaffolder and token prompt', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json'],
			keychainStored: false,
			skipped: [],
		}));
		const promptAndStoreServiceAccountToken = vi.fn(async () => true);

		await runAgentVmCli(
			[
				'init',
				'test-zone',
				'--type',
				'openclaw',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--onepassword-keychain-account-name',
				'shravan-claw',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				promptAndStoreServiceAccountToken,
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith(
			expect.objectContaining({
				onePasswordKeychainAccountName: 'shravan-claw',
			}),
		);
		expect(promptAndStoreServiceAccountToken).toHaveBeenCalledWith({
			accountName: 'shravan-claw',
		});
	});

	it('routes init token prompt through the effective skipped config Keychain account', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-init-keychain-'));
		const promptAndStoreServiceAccountToken = vi.fn(async () => true);
		const dependencies = {
			...defaultCliDependencies,
			getCurrentWorkingDirectory: () => targetDir,
			promptAndStoreServiceAccountToken,
			resolveGondolinMinimumZigVersion: async () => '0.15.2',
		} satisfies CliDependencies;

		await runAgentVmCli(
			[
				'init',
				'test-zone',
				'--type',
				'openclaw',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--onepassword-keychain-account-name',
				'configured-account',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			dependencies,
		);

		await runAgentVmCli(
			[
				'init',
				'test-zone',
				'--type',
				'openclaw',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--onepassword-keychain-account-name',
				'ignored-new-account',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			dependencies,
		);

		expect(promptAndStoreServiceAccountToken).toHaveBeenNthCalledWith(2, {
			account: '1p-service-account--configured-account',
			service: 'agent-vm',
		});

		await fs.rm(targetDir, { recursive: true, force: true });
	});

	it('passes comma-separated init agent ids to the project scaffolder', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			[
				'init',
				'test-zone',
				'--type',
				'openclaw',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--openclaw-agents',
				'sun,shravan,alevtina',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith(
			expect.objectContaining({
				agents: ['sun', 'shravan', 'alevtina'],
			}),
		);
	});

	it('routes resources init to the repo resource scaffolder', async () => {
		const outputs: string[] = [];
		const initRepoResources = vi.fn(async () => ({
			created: [
				'.agent-vm/repo-resources.ts',
				'.agent-vm/repo-resources.d.ts',
				'.agent-vm/run-setup.sh',
				'.agent-vm/docker-compose.yml',
				'.agent-vm/AGENTS.md',
				'.agent-vm/README.md',
			],
			skipped: [],
			updated: [],
		}));

		await runAgentVmCli(
			['resources', 'init'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/repo',
				initRepoResources,
			},
		);

		expect(initRepoResources).toHaveBeenCalledWith({
			targetDir: '/tmp/repo',
		});
		expect(outputs.join('')).toContain('Scaffolded .agent-vm resources in /tmp/repo');
		expect(outputs.join('')).toContain('created .agent-vm/repo-resources.ts');
		expect(outputs.join('')).toContain('Next: edit .agent-vm/repo-resources.ts');
		expect(outputs.join('')).not.toContain('"created"');
	});

	it('prints resources init JSON only when requested', async () => {
		const outputs: string[] = [];
		const initRepoResources = vi.fn(async () => ({
			created: ['.agent-vm/repo-resources.ts'],
			skipped: [],
			updated: [],
		}));

		await runAgentVmCli(
			['resources', 'init', '--json'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/repo',
				initRepoResources,
			},
		);

		expect(outputs.join('')).toContain('"created"');
		expect(outputs.join('')).toContain('.agent-vm/repo-resources.ts');
	});

	it('routes resources validate to repo resource validation', async () => {
		const outputs: string[] = [];
		const validateRepoResources = vi.fn(async () => ({
			valid: true as const,
		}));

		await runAgentVmCli(
			['resources', 'validate'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/repo',
				validateRepoResources,
			},
		);

		expect(validateRepoResources).toHaveBeenCalledWith({
			targetDir: '/tmp/repo',
		});
		expect(outputs.join('')).toContain('Repo resource contract is valid.');
	});

	it('routes resources update to generated repo resource file updates', async () => {
		const outputs: string[] = [];
		const updateRepoResources = vi.fn(async () => ({
			updated: ['.agent-vm/repo-resources.d.ts', '.agent-vm/AGENTS.md', '.agent-vm/README.md'],
		}));

		await runAgentVmCli(
			['resources', 'update'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/repo',
				updateRepoResources,
			},
		);

		expect(updateRepoResources).toHaveBeenCalledWith({
			targetDir: '/tmp/repo',
		});
		expect(outputs.join('')).toContain('.agent-vm/repo-resources.d.ts');
	});

	it('routes manual update to the deployment manual updater', async () => {
		const outputs: string[] = [];
		const updateAgentVmManual = vi.fn(async () => ({
			updated: ['docs/manual/README.md', 'AGENTS.md', 'CLAUDE.md'],
		}));

		await runAgentVmCli(
			['manual', 'update', '--agents'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-manual',
				updateAgentVmManual,
			},
		);

		expect(updateAgentVmManual).toHaveBeenCalledWith({
			defaultZoneId: 'default',
			systemConfigPath: 'config/system.jsonc',
			targetDir: '/tmp/agent-vm-manual',
			updateAgentIndex: true,
		});
		expect(outputs.join('')).toContain('Updated generated agent-vm manual files');
		expect(outputs.join('')).toContain('docs/manual/README.md');
	});

	it('passes gateway type through to init scaffolding', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json', '.env.local'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			['init', 'test-zone', '--type', 'worker', '--secrets', 'environment', '--arch', 'x86_64'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith(
			expect.objectContaining({
				gatewayType: 'worker',
				architecture: 'x86_64',
				hostSystemType: 'bare-metal',
				paths: 'local',
				targetDir: '/tmp/agent-vm-init',
				writeLocalEnvironmentFile: false,
				zoneId: 'test-zone',
			}),
		);
	});

	it('passes init path profile and namespace overrides to scaffolding', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json', '.env.local'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			[
				'init',
				'coding-agent',
				'--type',
				'worker',
				'--secrets',
				'environment',
				'--arch',
				'x86_64',
				'--paths',
				'pod',
				'--namespace',
				'agent-vm',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith({
			gatewayType: 'worker',
			architecture: 'x86_64',
			hostSystemType: 'container',
			overwrite: false,
			secretsProvider: 'environment',
			paths: 'pod',
			projectNamespace: 'agent-vm',
			targetDir: '/tmp/agent-vm-init',
			writeLocalEnvironmentFile: false,
			zoneId: 'coding-agent',
		});
	});

	it('expands init preset defaults and lets explicit flags override them', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json', '.env.local'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			[
				'init',
				'coding-agent',
				'--type',
				'worker',
				'--preset',
				'container-x86',
				'--arch',
				'aarch64',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith({
			architecture: 'aarch64',
			gatewayType: 'worker',
			hostSystemType: 'container',
			overwrite: false,
			paths: 'pod',
			secretsProvider: 'environment',
			targetDir: '/tmp/agent-vm-init',
			writeLocalEnvironmentFile: false,
			zoneId: 'coding-agent',
		});
	});

	it('uses macOS local preset for local env-file scaffolding', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json', '.env.local'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			['init', 'coding-agent', '--type', 'worker', '--preset', 'macos-local'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith({
			architecture: 'aarch64',
			gatewayType: 'worker',
			hostSystemType: 'bare-metal',
			overwrite: false,
			paths: 'user-dir',
			secretsProvider: '1password',
			targetDir: '/tmp/agent-vm-init',
			writeLocalEnvironmentFile: true,
			zoneId: 'coding-agent',
		});
	});

	it('expands container arm64 preset defaults', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			['init', 'coding-agent', '--type', 'worker', '--preset', 'container-arm64'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith({
			architecture: 'aarch64',
			gatewayType: 'worker',
			hostSystemType: 'container',
			overwrite: false,
			paths: 'pod',
			secretsProvider: 'environment',
			targetDir: '/tmp/agent-vm-init',
			writeLocalEnvironmentFile: false,
			zoneId: 'coding-agent',
		});
	});

	it('passes init overwrite flag to scaffolding', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json'],
			keychainStored: false,
			skipped: [],
		}));

		await runAgentVmCli(
			['init', 'coding-agent', '--type', 'worker', '--preset', 'container-x86', '--overwrite'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith(
			expect.objectContaining({
				overwrite: true,
			}),
		);
	});

	it('rejects init when --type is missing', async () => {
		await expect(
			runAgentVmCli(
				['init', 'test-zone', '--secrets', '1password'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				defaultCliDependencies,
			),
		).rejects.toThrow(/type/u);
	});

	it('rejects init when --secrets is missing', async () => {
		await expect(
			runAgentVmCli(
				['init', 'test-zone', '--type', 'worker'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				defaultCliDependencies,
			),
		).rejects.toThrow(/Secrets provider/u);
	});

	it('rejects init when --secrets is invalid', async () => {
		await expect(
			runAgentVmCli(
				['init', 'test-zone', '--type', 'worker', '--secrets', 'bogus'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				defaultCliDependencies,
			),
		).rejects.toThrow(/Invalid value 'bogus'/u);
	});

	it('rejects init when --arch is missing', async () => {
		await expect(
			runAgentVmCli(
				['init', 'test-zone', '--type', 'worker', '--secrets', 'environment'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				defaultCliDependencies,
			),
		).rejects.toThrow(/Architecture is required/u);
	});

	it('routes config reset-instructions through the injected reset helper', async () => {
		const stdoutChunks: string[] = [];
		const resetWorkerInstructions = vi.fn(async () => ({
			changed: ['phases.wrapup.instructions'],
		}));
		const systemConfig = createCliBuildSystemConfig();
		const primaryZone = systemConfig.zones[0];
		if (!primaryZone) {
			throw new Error('Expected primary zone in test system config');
		}

		await runAgentVmCli(
			[
				'config',
				'reset-instructions',
				'--config',
				'config/system.json',
				'--zone',
				'coding-agent',
				'--phase',
				'wrapup',
			],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => ({
					...systemConfig,
					zones: [
						{
							...primaryZone,
							gateway: {
								...primaryZone.gateway,
								type: 'worker' as const,
								imageProfile: 'worker',
								config: '/tmp/worker.json',
							},
							id: 'coding-agent',
						},
					],
				})),
				resetWorkerInstructions,
			},
		);

		expect(resetWorkerInstructions).toHaveBeenCalledWith({
			workerConfigPath: '/tmp/worker.json',
			phase: 'wrapup',
		});
		expect(stdoutChunks.join('')).toContain('"changed"');
	});

	it('routes build to the build command handler', async () => {
		const runBuildCommand = vi.fn(async () => {});

		await runAgentVmCli(
			['build', '--config', './custom-system.json'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runBuildCommand,
			},
		);

		expect(runBuildCommand).toHaveBeenCalledWith(
			{
				forceRebuild: false,
				skipObservability: false,
				systemConfig: expect.objectContaining({
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath: './config/system.json',
					imageProfiles: expect.objectContaining({
						gateways: expect.objectContaining({
							openclaw: expect.objectContaining({
								type: 'openclaw',
								dockerfile: './vm-images/gateways/openclaw/Dockerfile',
							}),
						}),
					}),
				}),
			},
			{
				runTask: expect.any(Function),
				runTaskGroup: expect.any(Function),
			},
		);
	});

	it('passes a progress task runner to build', async () => {
		const originalStdoutIsTty = process.stdout.isTTY;
		Object.defineProperty(process.stdout, 'isTTY', {
			configurable: true,
			value: true,
		});
		const stderrChunks: string[] = [];
		const runBuildCommand = vi.fn(async (_options, dependencies) => {
			await dependencies.runTask('Gondolin: gateway/openclaw', async () => {});
		});

		try {
			await runAgentVmCli(
				['build', '--config', './custom-system.json'],
				{
					stderr: {
						write: (chunk: string | Uint8Array) => {
							stderrChunks.push(String(chunk));
							return true;
						},
					},
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
					runBuildCommand,
				},
			);
		} finally {
			Object.defineProperty(process.stdout, 'isTTY', {
				configurable: true,
				value: originalStdoutIsTty,
			});
		}

		expect(runBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				systemConfig: expect.objectContaining({
					systemConfigPath: './config/system.json',
				}),
			}),
			{
				runTask: expect.any(Function),
				runTaskGroup: expect.any(Function),
			},
		);
	});

	it('passes build --force through to the build command handler', async () => {
		const runBuildCommand = vi.fn(async () => {});

		await runAgentVmCli(
			['build', '--force', '--config', './custom-system.json'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runBuildCommand,
			},
		);

		expect(runBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				forceRebuild: true,
			}),
			{
				runTask: expect.any(Function),
				runTaskGroup: expect.any(Function),
			},
		);
	});

	it('passes build --no-observability through to the build command handler', async () => {
		const runBuildCommand = vi.fn(async () => {});

		await runAgentVmCli(
			['build', '--no-observability', '--config', './custom-system.json'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runBuildCommand,
			},
		);

		expect(runBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				skipObservability: true,
			}),
			{
				runTask: expect.any(Function),
				runTaskGroup: expect.any(Function),
			},
		);
	});

	it('routes cache clean through the cache command handler', async () => {
		const runCacheCommand = vi.fn(async () => {});

		await runAgentVmCli(
			['cache', 'clean', '--confirm', '--config', './custom-system.json'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runCacheCommand,
			},
		);

		expect(runCacheCommand).toHaveBeenCalledWith(
			{
				confirm: true,
				subcommand: 'clean',
				systemConfig: expect.objectContaining({
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath: './config/system.json',
				}),
			},
			expect.any(Object),
		);
	});

	it('routes cache list through the cache command handler', async () => {
		const runCacheCommand = vi.fn(async () => {});

		await runAgentVmCli(
			['cache', 'list', '--config', './custom-system.json'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runCacheCommand,
			},
		);

		expect(runCacheCommand).toHaveBeenCalledWith(
			{
				subcommand: 'list',
				systemConfig: expect.objectContaining({
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath: './config/system.json',
				}),
			},
			expect.any(Object),
		);
	});

	it('routes validate through the injected validation helper', async () => {
		const stdoutChunks: string[] = [];
		const runConfigValidation = vi.fn(async () => ({
			ok: true,
			checks: [{ name: 'system-config', ok: true }],
		}));

		await runAgentVmCli(
			['validate', '--config', './custom-system.json'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runConfigValidation,
			},
		);

		expect(runConfigValidation).toHaveBeenCalledWith({
			systemConfig: expect.objectContaining({
				systemConfigPath: './config/system.json',
			}),
		});
		expect(stdoutChunks.join('')).toContain('"ok": true');
	});

	it('routes validate --mcp-live to config validation with a secret resolver', async () => {
		const runConfigValidation = vi.fn(async () => ({ checks: [], ok: true }));
		const onePasswordResolver = {
			resolve: vi.fn(async () => 'secret-value'),
			resolveAll: vi.fn(async () => ({})),
		};
		const createSecretResolver = vi.fn(async () => onePasswordResolver);
		const systemConfig = createCliBuildSystemConfig();

		await runAgentVmCli(
			['validate', '--config', './custom-system.json', '--mcp-live'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createSecretResolver,
				loadSystemConfig: vi.fn(async () => systemConfig),
				resolveServiceAccountToken: vi.fn(async () => 'service-account-token'),
				runConfigValidation,
			},
		);

		expect(createSecretResolver).toHaveBeenCalledWith({
			serviceAccountToken: 'service-account-token',
		});
		expect(runConfigValidation).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpLive: true,
				secretResolver: expect.objectContaining({ resolve: expect.any(Function) }),
				systemConfig,
			}),
		);
	});

	it('routes auth openclaw to an interactive SSH-backed OpenClaw login', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'openai-codex:test@example.com\n',
		}));

		await runAgentVmCli(
			[
				'auth',
				'openclaw',
				'login',
				'openai',
				'--zone',
				'shravan',
				'--agent',
				'main',
				'--profile-id',
				'openai-codex:test@example.com',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						host: '127.0.0.1',
						identityFile: '/tmp/test-key',
						port: 19000,
						user: 'root',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runCommand,
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', [
			'-t',
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			'-i',
			'/tmp/test-key',
			'-p',
			'19000',
			'root@127.0.0.1',
			expect.stringContaining('source /etc/profile.d/openclaw-env.sh'),
		]);
		expect(runCommand).toHaveBeenCalledWith('ssh', expect.any(Array));
	});

	it('routes auth 1password to configured Keychain storage', async () => {
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'service-account-token\n',
		}));
		const storeServiceAccountToken = vi.fn();
		const outputs: string[] = [];
		const systemConfig: LoadedSystemConfig = {
			...createCliBuildSystemConfig(),
			host: {
				...createCliBuildSystemConfig().host,
				secretsProvider: {
					type: '1password',
					tokenSource: {
						type: 'keychain',
						service: 'agent-vm',
						account: '1p-service-account--shravan-claw',
					},
				},
			},
		};

		await runAgentVmCli(
			[
				'auth',
				'1password',
				'op://agent-vm/1p-service-account-shravan-claw/credential',
				'--config',
				'config/system.jsonc',
			],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => systemConfig),
				runCommand,
				storeServiceAccountToken,
			},
		);

		expect(runCommand).toHaveBeenCalledWith('op', [
			'read',
			'op://agent-vm/1p-service-account-shravan-claw/credential',
		]);
		expect(storeServiceAccountToken).toHaveBeenCalledWith('service-account-token', {
			service: 'agent-vm',
			account: '1p-service-account--shravan-claw',
		});
		expect(outputs.join('')).not.toContain('service-account-token');
	});

	it('passes auth openclaw device-code to the login command', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'openai-codex:test@example.com\n',
		}));

		await runAgentVmCli(
			[
				'auth',
				'openclaw',
				'login',
				'openai',
				'--zone',
				'shravan',
				'--all-configured-profiles',
				'--device-code',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						host: '127.0.0.1',
						identityFile: '/tmp/test-key',
						port: 19000,
						user: 'root',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runCommand,
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([
				expect.stringContaining('openclaw models auth --agent'),
				expect.stringContaining('login --provider'),
				expect.stringContaining('--device-code'),
			]),
		);
	});

	it('routes auth openclaw login --dry-run without opening SSH', async () => {
		const stdoutChunks: string[] = [];
		const runInteractiveProcess = vi.fn(async () => {});
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'openai-codex:test@example.com\n',
		}));

		await runAgentVmCli(
			[
				'auth',
				'openclaw',
				'login',
				'openai',
				'--zone',
				'shravan',
				'--all-configured-profiles',
				'--dry-run',
			],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string) => {
						stdoutChunks.push(chunk);
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				createControllerClient: vi.fn(),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runCommand,
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).not.toHaveBeenCalled();
		expect(runCommand).not.toHaveBeenCalled();
		expect(stdoutChunks.join('')).toContain("OpenClaw auth login plan for zone 'shravan'");
		expect(stdoutChunks.join('')).toContain('openai-codex:test@example.com');
	});

	it('routes auth openclaw --agent to the OpenClaw provider login for that agent', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'openai-codex:test@example.com\n',
		}));

		await runAgentVmCli(
			[
				'auth',
				'openclaw',
				'login',
				'openai',
				'--zone',
				'shravan',
				'--agent',
				'shravan',
				'--profile-id',
				'openai-codex:test@example.com',
			],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						host: '127.0.0.1',
						identityFile: '/tmp/test-key',
						port: 19000,
						user: 'root',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithAgents()),
				runCommand,
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledTimes(1);
		const sshArguments = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1];
		if (!sshArguments) {
			throw new Error('Expected OpenClaw login to invoke ssh.');
		}
		const remoteCommand = sshArguments.at(-1);
		expect(remoteCommand).toEqual(expect.stringContaining('openclaw models auth'));
		expect(remoteCommand).toEqual(expect.stringContaining('--agent'));
		expect(remoteCommand).toEqual(expect.stringContaining('shravan'));
		expect(remoteCommand).toEqual(expect.stringContaining('login --provider'));
		expect(remoteCommand).toEqual(expect.stringContaining('openai'));
		expect(remoteCommand).toEqual(expect.stringContaining('--profile-id'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('CODEX_HOME='));
		expect(remoteCommand).not.toEqual(expect.stringContaining('codex login'));
	});

	it('routes auth openclaw login --all-configured-profiles to configured profile login', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'openai-codex:test@example.com\n',
		}));

		await runAgentVmCli(
			['auth', 'openclaw', 'login', 'openai', '--zone', 'shravan', '--all-configured-profiles'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						host: '127.0.0.1',
						identityFile: '/tmp/test-key',
						port: 19000,
						user: 'root',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithAgents()),
				runCommand,
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledTimes(1);
		const firstSshArguments = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1];
		if (!firstSshArguments) {
			throw new Error('Expected one ssh invocation.');
		}
		expect(firstSshArguments.at(-1)).toEqual(expect.stringContaining('openclaw models auth'));
		expect(firstSshArguments.at(-1)).toEqual(expect.stringContaining('--agent'));
		expect(firstSshArguments.at(-1)).toEqual(expect.stringContaining('main'));
		expect(firstSshArguments.at(-1)).toEqual(expect.stringContaining('login --provider'));
		expect(firstSshArguments.at(-1)).toEqual(
			expect.stringContaining('openai-codex:test@example.com'),
		);
	});

	it('auth openclaw without --zone shows available zones', async () => {
		const stderrChunks: string[] = [];
		await expect(
			runAgentVmCli(
				['auth', 'openclaw', 'login', 'codex', '--profile-id', 'openai-codex:test@example.com'],
				{
					stderr: {
						write: (s: string) => {
							stderrChunks.push(s);
							return true;
						},
					},
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				},
			),
		).rejects.toThrow(/--zone is required/u);
	});

	it('prints top-level help instead of throwing on --help', async () => {
		const stdoutChunks: string[] = [];

		await expect(
			runAgentVmCli(
				['--help'],
				{
					stderr: { write: () => true },
					stdout: {
						write: (chunk: string | Uint8Array) => {
							stdoutChunks.push(String(chunk));
							return true;
						},
					},
				},
				defaultCliDependencies,
			),
		).resolves.toBeUndefined();

		expect(stdoutChunks.join('')).toContain('agent-vm');
		expect(stdoutChunks.join('')).toContain('controller');
	});

	it('rejects an invalid gateway type value', async () => {
		await expect(
			runAgentVmCli(
				['init', 'test-zone', '--type', 'banana', '--secrets', '1password'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				defaultCliDependencies,
			),
		).rejects.toThrow(/openclaw|worker/u);
	});

	it('prints controller help instead of throwing on controller --help', async () => {
		const stdoutChunks: string[] = [];

		await expect(
			runAgentVmCli(
				['controller', '--help'],
				{
					stderr: { write: () => true },
					stdout: {
						write: (chunk: string | Uint8Array) => {
							stdoutChunks.push(String(chunk));
							return true;
						},
					},
				},
				defaultCliDependencies,
			),
		).resolves.toBeUndefined();

		expect(stdoutChunks.join('')).toContain('controller');
		expect(stdoutChunks.join('')).toContain('start');
		expect(stdoutChunks.join('')).toContain('credentials');
	});

	it('reports regular runtime errors to stderr in the main error handler', () => {
		const stderrChunks: string[] = [];

		handleCliMainError(new Error('boom'), {
			write: (chunk: string | Uint8Array) => {
				stderrChunks.push(String(chunk));
				return true;
			},
		});

		expect(stderrChunks.join('')).toContain('boom');
	});

	it('surfaces system config validation errors with friendly paths', async () => {
		await expect(
			runAgentVmCli(
				['build'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					loadSystemConfig: async () => {
						throw new ZodError([
							{
								code: 'invalid_type',
								expected: 'string',
								input: undefined,
								message: 'Invalid input: expected string, received undefined',
								path: ['zones', 0, 'gateway', 'config'],
							},
						]);
					},
				},
			),
		).rejects.toThrow(
			[
				'Invalid config/system.json configuration:',
				'  zones[0].gateway.config: Invalid input: expected string, received undefined',
			].join('\n'),
		);
	});

	it('does not duplicate already-reported cli exit errors in the main error handler', () => {
		const stderrChunks: string[] = [];

		handleCliMainError(new ReportedCliError('already shown'), {
			write: (chunk: string | Uint8Array) => {
				stderrChunks.push(String(chunk));
				return true;
			},
		});

		expect(stderrChunks).toEqual([]);
	});

	it('routes doctor and status subcommands to their handlers', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cli-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const openClawBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'gateways',
			'openclaw',
			'build-config.json',
		);
		const workerBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'gateways',
			'worker',
			'build-config.json',
		);
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		const outputs: string[] = [];
		await Promise.all(
			[openClawBuildConfigPath, workerBuildConfigPath, toolVmBuildConfigPath].map(
				async (buildConfigPath) => {
					await fs.mkdir(path.dirname(buildConfigPath), { recursive: true });
					await fs.writeFile(
						buildConfigPath,
						JSON.stringify({ oci: { image: 'agent-vm-test:latest' } }),
						'utf8',
					);
				},
			),
		);

		await runAgentVmCli(
			['doctor', '--json'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolVmProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getControllerStatus: async () => ({
						controllerPort: 18800,
						toolVmProfiles: ['standard'],
						zones: [],
					}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
					releaseLease: async () => {},
					stopController: async () => ({ ok: true }),
					upgradeZone: async () => ({ ok: true, zoneId: 'shravan' }),
				}),
				createAgeBackupEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup: async () => ({ backupPath: '', timestamp: '', zoneId: '' }),
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				collectControllerDoctorEnvironment: async () => ({
					availableBinaries: new Set(),
					dockerDaemonReady: false,
					env: {},
					nodeVersion: 'v24.0.0',
					requiredZigVersion: '0.16.0',
					zigVersion: '0.16.0',
				}),
				collectDynamicDoctorChecks: async () => [],
				isGatewayImageCached: async () => true,
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					schemaVersion: 1,
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath,
					host: {
						controllerPort: 18800,
						projectNamespace: 'claw-tests-a1b2c3d4',
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: openClawBuildConfigPath,
							},
							worker: {
								type: 'worker',
								buildConfig: workerBuildConfigPath,
							},
						},
						toolVms: {
							default: {
								type: 'toolVm',
								buildConfig: toolVmBuildConfigPath,
							},
						},
					},
					tcpPool: {
						basePort: 19000,
						size: 5,
					},
					toolVmProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							imageProfile: 'default',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(async () => createStartedControllerRuntime()),
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);
		await runAgentVmCli(
			['controller', 'status'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolVmProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getControllerStatus: async () => ({
						controllerPort: 18800,
						toolVmProfiles: ['standard'],
						zones: [],
					}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
					releaseLease: async () => {},
					stopController: async () => ({ ok: true }),
					upgradeZone: async () => ({ ok: true, zoneId: 'shravan' }),
				}),
				createAgeBackupEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup: async () => ({ backupPath: '', timestamp: '', zoneId: '' }),
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				isGatewayImageCached: async () => true,
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					schemaVersion: 1,
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath: './config/system.json',
					host: {
						controllerPort: 18800,
						projectNamespace: 'claw-tests-a1b2c3d4',
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: openClawBuildConfigPath,
							},
							worker: {
								type: 'worker',
								buildConfig: workerBuildConfigPath,
							},
						},
						toolVms: {
							default: {
								type: 'toolVm',
								buildConfig: toolVmBuildConfigPath,
							},
						},
					},
					tcpPool: {
						basePort: 19000,
						size: 5,
					},
					toolVmProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							imageProfile: 'default',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(async () => createStartedControllerRuntime()),
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(outputs.join('\n')).toContain('"ok": true');
		expect(outputs.join('\n')).toContain('"controllerPort": 18800');
		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('passes the bundled gondolin plugin source path into controller start', async () => {
		const startControllerRuntime = vi.fn(async () => createStartedControllerRuntime());

		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';

		await runAgentVmCli(
			['controller', 'start', '--zone', 'shravan'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: () => true,
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolVmProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getControllerStatus: async () => ({
						controllerPort: 18800,
						toolVmProfiles: ['standard'],
						zones: [],
					}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
					releaseLease: async () => {},
					stopController: async () => ({ ok: true }),
					upgradeZone: async () => ({ ok: true, zoneId: 'shravan' }),
				}),
				createAgeBackupEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup: async () => ({ backupPath: '', timestamp: '', zoneId: '' }),
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				isGatewayImageCached: async () => true,
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					schemaVersion: 1,
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath: './config/system.json',
					host: {
						controllerPort: 18800,
						projectNamespace: 'claw-tests-a1b2c3d4',
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: './vm-images/gateways/openclaw/build-config.json',
							},
							worker: {
								type: 'worker',
								buildConfig: './vm-images/gateways/worker/build-config.json',
							},
						},
						toolVms: {
							default: {
								type: 'toolVm',
								buildConfig: './vm-images/tool-vms/default/build-config.json',
							},
						},
					},
					tcpPool: {
						basePort: 19000,
						size: 5,
					},
					toolVmProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							imageProfile: 'default',
						},
					},
					zones: [
						{
							egressHosts: ['api.anthropic.com'].map((host) => ({
								host,
								audience: 'gateway' as const,
							})),
							gateway: {
								type: 'openclaw',
								controlAuth: {
									mode: 'token',
									secret: 'OPENCLAW_GATEWAY_TOKEN',
								},
								imageProfile: 'openclaw',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								zoneFilesDir: './zone-files/shravan',
							},
							id: 'shravan',
							secrets: {
								OPENCLAW_GATEWAY_TOKEN: {
									source: 'environment',
									envVar: 'OPENCLAW_GATEWAY_TOKEN',
									injection: 'env',
									audience: 'gateway',
								},
							},
							defaultToolVmProfile: 'standard',
							agentToolVmProfiles: {},
						},
					],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime,
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(startControllerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'shravan',
			}),
			{
				runTask: expect.any(Function),
			},
		);
	});

	it('prints ingress and vm id from the selected controller runtime zone', async () => {
		const outputs: string[] = [];
		const baseSystemConfig = createCliBuildSystemConfig();

		await runAgentVmCli(
			['controller', 'start', '--zone', 'shravan'],
			{
				stderr: {
					write: () => true,
				},
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				isGatewayImageCached: async () => true,
				loadSystemConfig: async () => baseSystemConfig,
				startControllerRuntime: vi.fn(
					async () =>
						({
							controllerPort: 18800,
							zones: [
								{
									gateway: {
										ingress: {
											host: '127.0.0.1',
											port: 18791,
										},
										vm: {
											id: 'vm-123',
										},
									},
									lifecycleState: 'running',
									zoneId: 'shravan',
								},
							],
							close: async () => {},
						}) as never,
				),
			},
		);

		expect(JSON.parse(outputs.join(''))).toEqual({
			controllerPort: 18800,
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
			vmId: 'vm-123',
			zoneId: 'shravan',
		});
	});

	it('fails fast when the gateway image cache is cold', async () => {
		const startControllerRuntime = vi.fn();

		await expect(
			runAgentVmCli(
				['controller', 'start', '--zone', 'shravan'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					isGatewayImageCached: async () => false,
					loadSystemConfig: async () => createCliBuildSystemConfig(),
					startControllerRuntime,
				},
			),
		).rejects.toThrow(/Gateway image not cached|agent-vm build/u);

		expect(startControllerRuntime).not.toHaveBeenCalled();
	});

	it('rejects controller start when multiple zones are configured', async () => {
		const baseSystemConfig = createCliBuildSystemConfig();
		const primaryZone = baseSystemConfig.zones[0];
		if (!primaryZone) {
			throw new Error('Expected primary zone in test system config');
		}

		await expect(
			runAgentVmCli(
				['controller', 'start'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					isGatewayImageCached: async () => true,
					loadSystemConfig: async () => ({
						...baseSystemConfig,
						zones: [
							primaryZone,
							{
								...primaryZone,
								id: 'alevtina',
							},
						],
					}),
				},
			),
		).rejects.toThrow(/--zone is required\. Available zones:/u);
	});

	it('uses the explicitly requested zone for controller start', async () => {
		const baseSystemConfig = createCliBuildSystemConfig();
		const primaryZone = baseSystemConfig.zones[0];
		if (!primaryZone) {
			throw new Error('Expected primary zone in test system config');
		}
		const startControllerRuntime = vi.fn(async () =>
			createStartedControllerRuntime({
				ingressPort: 18792,
				vmId: 'vm-alevtina',
				zoneId: 'alevtina',
			}),
		);

		await runAgentVmCli(
			['controller', 'start', '--zone', 'alevtina'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				isGatewayImageCached: async () => true,
				loadSystemConfig: async () => ({
					...baseSystemConfig,
					zones: [
						primaryZone,
						{
							...primaryZone,
							id: 'alevtina',
						},
					],
				}),
				startControllerRuntime,
			},
		);

		expect(startControllerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'alevtina',
			}),
			{
				runTask: expect.any(Function),
			},
		);
	});

	it('routes controller operation subcommands through the controller client', async () => {
		const outputs: string[] = [];
		const controllerClient = {
			destroyZone: vi.fn(async () => ({ ok: true, purged: true, zoneId: 'shravan' })),
			enableZoneSsh: vi.fn(async () => ({ command: 'ssh root@127.0.0.1' })),
			getControllerStatus: vi.fn(async () => ({
				controllerPort: 18800,
				toolVmProfiles: ['standard'],
				zones: [
					{
						gatewayType: 'openclaw',
						id: 'shravan',
						ingressPort: 18791,
						agentToolVmProfiles: {},
					},
				],
			})),
			getZoneHealth: vi.fn(async () => ({
				ok: true,
				path: '/readyz',
				zoneId: 'shravan',
			})),
			getZoneHealthSnapshot: vi.fn(async () => ({
				healthy: true,
				issues: [],
				zoneId: 'shravan',
			})),
			getZoneServiceHealth: vi.fn(async () => ({
				ok: true,
				path: '/health',
				zoneId: 'shravan',
			})),
			getZoneLogs: vi.fn(async () => ({ output: 'logs', zoneId: 'shravan' })),
			listLeases: vi.fn(async () => []),
			peekLease: vi.fn(async () => ({
				agentId: 'main',
				createdAt: 1,
				idleTtlMs: 6_000_000,
				lastUsedAt: 1,
				leaseId: 'lease-123',
				profileId: 'standard',
				ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
				tcpSlot: 0,
				transport: 'ssh-sandbox' as const,
				workdir: '/workspace',

				zoneId: 'shravan',
			})),
			refreshZoneCredentials: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
			releaseLease: vi.fn(async () => {}),
			stopController: vi.fn(async () => ({ ok: true })),
			upgradeZone: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
		};

		const baseDependencies = {
			buildControllerStatus: () => ({
				controllerPort: 18800,
				toolVmProfiles: ['standard'],
				zones: [],
			}),
			createAgeBackupEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
			createControllerClient: () => controllerClient,
			createSecretResolver: async () => ({
				resolve: async () => '',
				resolveAll: async () => ({}),
			}),
			createZoneBackupManager: () => ({
				createBackup: async () => ({ backupPath: '', timestamp: '', zoneId: '' }),
				restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
				listBackups: () => [],
			}),
			resolveGondolinMinimumZigVersion: async () => '0.15.2',
			probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
			resolveServiceAccountToken: async () => 'mock-token',
			loadSystemConfig: async (): Promise<LoadedSystemConfig> => ({
				schemaVersion: 1,
				cacheDir: './cache',
				runtimeDir: './runtime',
				systemConfigPath: './config/system.json',
				host: {
					controllerPort: 18800,
					projectNamespace: 'claw-tests-a1b2c3d4',
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: './vm-images/gateways/openclaw/build-config.json',
						},
						worker: {
							type: 'worker',
							buildConfig: './vm-images/gateways/worker/build-config.json',
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: './vm-images/tool-vms/default/build-config.json',
						},
					},
				},
				tcpPool: {
					basePort: 19000,
					size: 5,
				},
				toolVmProfiles: {
					standard: {
						cpus: 1,
						memory: '1G',
						imageProfile: 'default',
					},
				},
				zones: [
					{
						egressHosts: ['api.anthropic.com'].map((host) => ({
							host,
							audience: 'gateway' as const,
						})),
						gateway: {
							type: 'openclaw',
							controlAuth: {
								mode: 'token',
								secret: 'OPENCLAW_GATEWAY_TOKEN',
							},
							imageProfile: 'openclaw',
							cpus: 2,
							memory: '2G',
							config: './config/shravan/openclaw.json',
							port: 18791,
							stateDir: './state/shravan',
							zoneFilesDir: './zone-files/shravan',
						},
						id: 'shravan',
						secrets: {
							OPENCLAW_GATEWAY_TOKEN: {
								source: 'environment',
								envVar: 'OPENCLAW_GATEWAY_TOKEN',
								injection: 'env',
								audience: 'gateway',
							},
						},
						defaultToolVmProfile: 'standard',
						agentToolVmProfiles: {},
					},
				],
			}),
			runControllerDoctor: () => ({
				checks: [],
				ok: true,
			}),
			startControllerRuntime: vi.fn(async () => createStartedControllerRuntime()),
			startGatewayZone: vi.fn(async () => undefined as never),
		};
		const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';

		try {
			for (const command of [
				['controller', 'status'],
				['controller', 'health', '--zone', 'shravan'],
				['controller', 'health-snapshot', '--zone', 'shravan'],
				['controller', 'service-health', '--zone', 'shravan'],
				['controller', 'logs', '--zone', 'shravan'],
				['controller', 'destroy', '--zone', 'shravan', '--purge'],
				['controller', 'upgrade', '--zone', 'shravan'],
				['controller', 'credentials', 'check', '--zone', 'shravan'],
				['controller', 'credentials', 'refresh', '--zone', 'shravan'],
			] as const) {
				// oxlint-disable-next-line no-await-in-loop -- commands intentionally run serially against shared mocks
				await runAgentVmCli(
					command,
					{
						stderr: {
							write: () => true,
						},
						stdout: {
							write: (chunk: string | Uint8Array) => {
								outputs.push(String(chunk));
								return true;
							},
						},
					},
					baseDependencies,
				);
			}
		} finally {
			if (previousGatewayToken === undefined) {
				delete process.env.OPENCLAW_GATEWAY_TOKEN;
			} else {
				process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
			}
		}

		expect(controllerClient.getControllerStatus).toHaveBeenCalled();
		expect(controllerClient.getZoneHealth).toHaveBeenCalledWith('shravan');
		expect(controllerClient.getZoneHealthSnapshot).toHaveBeenCalledWith('shravan');
		expect(controllerClient.getZoneServiceHealth).toHaveBeenCalledWith('shravan');
		expect(controllerClient.getZoneLogs).toHaveBeenCalledWith('shravan');
		expect(controllerClient.destroyZone).toHaveBeenCalledWith('shravan', true);
		expect(controllerClient.upgradeZone).toHaveBeenCalledWith('shravan');
		expect(controllerClient.refreshZoneCredentials).toHaveBeenCalledWith('shravan');
		expect(outputs.join('\n')).toContain('"zoneId": "shravan"');
		expect(outputs.join('\n')).toContain('"resolvedSecretCount": 1');
	});

	it('routes controller ssh through the gateway-token-loaded ssh command handler', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async () => {},
		);

		await runAgentVmCli(
			['controller', 'ssh', '--zone', 'shravan'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						host: '127.0.0.1',
						port: 2222,
						secretEnvEnabled: true,
						user: 'root',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([expect.stringContaining('/run/openclaw/gateway-token.env')]),
		);
		const firstSshCall = vi.mocked(runInteractiveProcess).mock.calls[0];
		if (!firstSshCall) {
			throw new Error('Expected SSH process to run.');
		}
		const sshArguments = firstSshCall[1];
		const remoteCommand = sshArguments.at(-1);
		expect(remoteCommand).not.toEqual(expect.stringContaining('/run/openclaw/secrets.env'));
	});

	it('routes controller ssh --all-secrets through the raw gateway secret env file', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async () => {},
		);
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2222,
			secretEnvEnabled: true,
			user: 'root',
		}));

		await runAgentVmCli(
			['controller', 'ssh', '--zone', 'shravan', '--all-secrets'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(enableZoneSsh),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runInteractiveProcess,
			},
		);

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', { secretEnv: 'all-secrets' });
		const firstSshCall = vi.mocked(runInteractiveProcess).mock.calls[0];
		if (!firstSshCall) {
			throw new Error('Expected SSH process to run.');
		}
		const sshArguments = firstSshCall[1];
		const remoteCommand = sshArguments.at(-1);
		expect(remoteCommand).toEqual(expect.stringContaining('/run/openclaw/secrets.env'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('/run/openclaw/gateway-token.env'));
	});

	it('routes auth codex-harness to native per-agent Codex CLI auth', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2222,
			user: 'root',
		}));

		await runAgentVmCli(
			['auth', 'codex-harness', '--zone', 'shravan', '--agent', 'shravan'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(enableZoneSsh),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithAgents()),
				runInteractiveProcess,
			},
		);

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', { secretEnv: 'default' });
		const sshArguments = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1];
		if (!sshArguments) {
			throw new Error('Expected Codex login to invoke ssh.');
		}
		expect(sshArguments).toEqual(
			expect.arrayContaining(['-t', 'root@127.0.0.1', expect.stringContaining('agent_id=')]),
		);
		const remoteCommand = sshArguments?.at(-1);
		expect(remoteCommand).toEqual(expect.stringContaining('shravan'));
		expect(remoteCommand).toEqual(expect.stringContaining('source /etc/profile.d/openclaw-env.sh'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('/run/openclaw/secrets.env'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('/pnpm/global/5'));
		expect(remoteCommand).toEqual(expect.stringContaining('pnpm root -g'));
		expect(remoteCommand).toEqual(expect.stringContaining('CODEX_HOME="$codex_home"'));
		expect(remoteCommand).toEqual(expect.stringContaining('login --device-auth'));
		expect(remoteCommand).toEqual(expect.stringContaining('auth.json: present'));
		expect(remoteCommand).toEqual(expect.stringContaining('openai-codex profiles:'));
		expect(remoteCommand).toEqual(expect.stringContaining('auth-profiles.json'));
		expect(remoteCommand).toEqual(expect.stringContaining('Install @openai/codex'));
		expect(remoteCommand).toEqual(
			expect.stringContaining('Could not read OpenClaw auth profile count'),
		);
		expect(remoteCommand).toEqual(expect.stringContaining('share a Codex refresh token'));
		expect(remoteCommand).toEqual(
			expect.stringContaining('shared-refresh-token diagnostic failed'),
		);
		expect(remoteCommand).not.toEqual(expect.stringContaining('openclaw models auth login'));
	});

	it('rejects unsafe auth codex-harness agent ids before opening ssh', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);

		await expect(
			runAgentVmCli(
				['auth', 'codex-harness', '--zone', 'shravan', '--agent', '../main'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient: () =>
						createControllerClientStub(async () => ({
							host: '127.0.0.1',
							port: 2222,
							secretEnvEnabled: true,
							user: 'root',
						})),
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithAgents()),
					runInteractiveProcess,
				},
			),
		).rejects.toThrow('agent id must start with a lowercase letter or number');

		expect(runInteractiveProcess).not.toHaveBeenCalled();
	});

	it('rejects auth codex-harness on non-OpenClaw zones before opening ssh', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);

		await expect(
			runAgentVmCli(
				['auth', 'codex-harness', '--zone', 'shravan', '--agent', 'shravan'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient: vi.fn(),
					loadSystemConfig: vi.fn(async () => createCliBuildWorkerSystemConfig()),
					runInteractiveProcess,
				},
			),
		).rejects.toThrow("auth codex-harness requires an OpenClaw zone, got 'worker'");

		expect(runInteractiveProcess).not.toHaveBeenCalled();
	});

	it('rejects auth codex-harness when both target modes are provided', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);

		await expect(
			runAgentVmCli(
				['auth', 'codex-harness', '--zone', 'shravan', '--agent', 'shravan', '--all-agents'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient: vi.fn(),
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithAgents()),
					runInteractiveProcess,
				},
			),
		).rejects.toThrow('Use either --agent or --all-agents, not both.');

		expect(runInteractiveProcess).not.toHaveBeenCalled();
	});

	it('rejects auth codex-harness when no target mode is provided', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);

		await expect(
			runAgentVmCli(
				['auth', 'codex-harness', '--zone', 'shravan'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient: vi.fn(),
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithAgents()),
					runInteractiveProcess,
				},
			),
		).rejects.toThrow('auth codex-harness requires --agent <agentId> or --all-agents.');

		expect(runInteractiveProcess).not.toHaveBeenCalled();
	});

	it('rejects auth codex-harness --all-agents when the zone has no configured agents', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);

		await expect(
			runAgentVmCli(
				['auth', 'codex-harness', '--zone', 'shravan', '--all-agents'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient: vi.fn(),
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithoutConfiguredAgents()),
					runInteractiveProcess,
				},
			),
		).rejects.toThrow(
			"Zone 'shravan' has no configured agents; use --agent <agentId> for a one-off login.",
		);

		expect(runInteractiveProcess).not.toHaveBeenCalled();
	});

	it('routes auth codex-harness --all-agents one native login per configured agent', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async (_command: string, _arguments_: readonly string[]): Promise<void> => {},
		);

		await runAgentVmCli(
			['auth', 'codex-harness', '--zone', 'shravan', '--all-agents'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						host: '127.0.0.1',
						port: 2222,
						secretEnvEnabled: true,
						user: 'root',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfigWithAgents()),
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledTimes(2);
		const firstSshArguments = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1];
		const secondSshArguments = vi.mocked(runInteractiveProcess).mock.calls[1]?.[1];
		if (!firstSshArguments || !secondSshArguments) {
			throw new Error('Expected one ssh invocation per agent.');
		}
		expect(firstSshArguments.at(-1)).toEqual(expect.stringContaining('shravan'));
		expect(secondSshArguments.at(-1)).toEqual(expect.stringContaining('ember'));
	});

	it('routes controller stop through the controller client', async () => {
		const stopController = vi.fn(async () => ({ ok: true }));

		await runAgentVmCli(
			['controller', 'stop'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					execInZone: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
					getZoneLogs: async () => ({}),
					getControllerStatus: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController,
					upgradeZone: async () => ({}),
				}),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
			},
		);

		expect(stopController).toHaveBeenCalled();
	});

	it('routes controller cleanup through offline cleanup without contacting the controller', async () => {
		const stdoutChunks: string[] = [];
		const createControllerClient = vi.fn();
		const runControllerOfflineCleanup = vi.fn(async () => ({
			results: [
				{
					cleanedUp: true,
					killedPid: 48282,
					stateDir: './state/shravan',
					toolVmCleanup: {
						cleanedCount: 0,
						killedPids: [],
						quarantinedCount: 0,
						warnings: [],
					},
					zoneId: 'shravan',
				},
			],
		}));

		await runAgentVmCli(
			['controller', 'cleanup', '--config', './config/system.json', '--zone', 'shravan'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
			},
			{
				...defaultCliDependencies,
				createControllerClient,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runControllerOfflineCleanup,
			},
		);

		expect(createControllerClient).not.toHaveBeenCalled();
		expect(runControllerOfflineCleanup).toHaveBeenCalledWith({
			force: false,
			systemConfig: expect.objectContaining({
				host: expect.objectContaining({
					projectNamespace: 'claw-tests-a1b2c3d4',
				}),
			}),
			zoneId: 'shravan',
		});
		expect(JSON.parse(stdoutChunks.join(''))).toEqual({
			results: [
				{
					cleanedUp: true,
					killedPid: 48282,
					stateDir: './state/shravan',
					toolVmCleanup: {
						cleanedCount: 0,
						killedPids: [],
						quarantinedCount: 0,
						warnings: [],
					},
					zoneId: 'shravan',
				},
			],
		});
	});

	it('passes controller cleanup force through offline cleanup', async () => {
		const runControllerOfflineCleanup = vi.fn(async () => ({ results: [] }));

		await runAgentVmCli(
			['controller', 'cleanup', '--config', './config/system.json', '--zone', 'shravan', '--force'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runControllerOfflineCleanup,
			},
		);

		expect(runControllerOfflineCleanup).toHaveBeenCalledWith({
			force: true,
			systemConfig: expect.objectContaining({
				host: expect.objectContaining({
					projectNamespace: 'claw-tests-a1b2c3d4',
				}),
			}),
			zoneId: 'shravan',
		});
	});

	it('reports controller cleanup warnings as command failures', async () => {
		const stderrChunks: string[] = [];
		const stdoutChunks: string[] = [];
		const runControllerOfflineCleanup = vi.fn(async () => ({
			results: [
				{
					cleanedUp: false,
					cleanupWarning: 'failed to remove stale runtime record',
					killedPid: 48282,
					stateDir: './state/shravan',
					toolVmCleanup: {
						cleanedCount: 1,
						killedPids: [123],
						quarantinedCount: 0,
						warnings: ['failed to remove stale tool VM runtime record'],
					},
					zoneId: 'shravan',
				},
			],
		}));

		await expect(
			runAgentVmCli(
				['controller', 'cleanup', '--config', './config/system.json', '--zone', 'shravan'],
				{
					stderr: {
						write: (chunk: string | Uint8Array) => {
							stderrChunks.push(String(chunk));
							return true;
						},
					},
					stdout: {
						write: (chunk: string | Uint8Array) => {
							stdoutChunks.push(String(chunk));
							return true;
						},
					},
				},
				{
					...defaultCliDependencies,
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
					runControllerOfflineCleanup,
				},
			),
		).rejects.toThrow(/Controller cleanup completed with warnings/u);

		expect(JSON.parse(stdoutChunks.join(''))).toEqual({
			results: [
				{
					cleanedUp: false,
					cleanupWarning: 'failed to remove stale runtime record',
					killedPid: 48282,
					stateDir: './state/shravan',
					toolVmCleanup: {
						cleanedCount: 1,
						killedPids: [123],
						quarantinedCount: 0,
						warnings: ['failed to remove stale tool VM runtime record'],
					},
					zoneId: 'shravan',
				},
			],
		});
		expect(stderrChunks.join('')).toBe('');
	});

	it('rejects removed controller lease subcommands', async () => {
		const createControllerClient = vi.fn(
			(): ControllerClient => ({
				destroyZone: async () => ({}),
				enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
				execInZone: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
				getZoneLogs: async () => ({}),
				getControllerStatus: async () => ({}),
				refreshZoneCredentials: async () => ({}),
				stopController: async () => ({ ok: true }),
				upgradeZone: async () => ({}),
			}),
		);

		await expect(
			runAgentVmCli(
				['controller', 'lease', 'list'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient,
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				},
			),
		).rejects.toThrow('lease');
		await expect(
			runAgentVmCli(
				['controller', 'lease', 'peek', 'lease-123'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient,
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				},
			),
		).rejects.toThrow('peek');
		await expect(
			runAgentVmCli(
				['controller', 'lease', 'release', 'lease-123'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					createControllerClient,
					loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				},
			),
		).rejects.toThrow('release');

		expect(createControllerClient).not.toHaveBeenCalled();
	});

	it('routes backup list through the backup manager', async () => {
		const outputs: string[] = [];
		const listBackups = vi.fn(() => [
			{
				backupPath: '/state/shravan/backups/shravan-2026-04-06.tar.age',
				timestamp: '2026-04-06',
				zoneId: 'shravan',
			},
		]);

		await runAgentVmCli(
			['backup', 'list', '--zone', 'shravan'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolVmProfiles: ['standard'],
					zones: [],
				}),
				createAgeBackupEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({}),
					getControllerStatus: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup: async () => ({ backupPath: '', timestamp: '', zoneId: '' }),
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
					listBackups,
				}),
				loadSystemConfig: async () => ({
					schemaVersion: 1,
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath: './config/system.json',
					host: {
						controllerPort: 18800,
						projectNamespace: 'claw-tests-a1b2c3d4',
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					imageProfiles: {
						gateways: {
							openclaw: { type: 'openclaw', buildConfig: '' },
						},
						toolVms: {
							default: { type: 'toolVm', buildConfig: '' },
						},
					},
					tcpPool: { basePort: 19000, size: 5 },
					toolVmProfiles: {
						standard: {
							cpus: 1,
							imageProfile: 'default',
							memory: '1G',
						},
					},
					zones: [
						{
							egressHosts: ['api.anthropic.com'].map((host) => ({
								host,
								audience: 'gateway' as const,
							})),
							gateway: {
								type: 'openclaw',
								controlAuth: {
									mode: 'token',
									secret: 'OPENCLAW_GATEWAY_TOKEN',
								},
								imageProfile: 'openclaw',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								zoneFilesDir: './zone-files/shravan',
							},
							id: 'shravan',
							secrets: {
								OPENCLAW_GATEWAY_TOKEN: {
									source: 'environment',
									envVar: 'OPENCLAW_GATEWAY_TOKEN',
									injection: 'env',
									audience: 'gateway',
								},
							},
							defaultToolVmProfile: 'standard',
							agentToolVmProfiles: {},
						},
					],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				startControllerRuntime: vi.fn(async () => createStartedControllerRuntime({ vmId: 'vm-1' })),
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(listBackups).toHaveBeenCalledWith(
			expect.objectContaining({ backupDir: './state/shravan/backups', zoneId: 'shravan' }),
		);
		expect(outputs.join('')).toContain('shravan-2026-04-06.tar.age');
	});

	it('requires --zone for backup list', async () => {
		await expect(
			runAgentVmCli(
				['backup', 'list'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					loadSystemConfig: async () => createCliBuildSystemConfig(),
				},
			),
		).rejects.toThrow(/--zone/u);
	});

	it('routes backup create through the backup manager with a 1Password key ref', async () => {
		const outputs: string[] = [];
		const createBackup = vi.fn(async () => ({
			backupPath: './state/shravan/backups/shravan-2026-04-06T12-00.tar.age',
			timestamp: '2026-04-06T12-00',
			zoneId: 'shravan',
		}));
		const resolveIdentityCalls: string[] = [];

		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-token';

		await runAgentVmCli(
			['backup', 'create', '--zone', 'shravan'],
			{
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			{
				buildControllerStatus: () => ({
					controllerPort: 18800,
					toolVmProfiles: ['standard'],
					zones: [],
				}),
				createAgeBackupEncryption: (deps) => {
					// Capture the identity resolver to verify the 1P ref pattern
					void deps.resolveIdentity().then((identity) => resolveIdentityCalls.push(identity));
					return { encrypt: async () => {}, decrypt: async () => {} };
				},
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({}),
					getControllerStatus: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				createSecretResolver: async () => ({
					resolve: async (ref: SecretRef) => {
						// Verify the 1P ref pattern
						if (ref.source === 'config') {
							throw new Error('Unexpected config secret.');
						}
						expect(ref.ref).toBe('op://agent-vm/shravan-gateway-backup/password');
						return 'resolved-passphrase';
					},
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup,
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				loadSystemConfig: async () => ({
					schemaVersion: 1,
					cacheDir: './cache',
					runtimeDir: './runtime',
					systemConfigPath: './config/system.json',
					host: {
						controllerPort: 18800,
						projectNamespace: 'claw-tests-a1b2c3d4',
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					imageProfiles: {
						gateways: {
							openclaw: { type: 'openclaw', buildConfig: '' },
						},
						toolVms: {
							default: { type: 'toolVm', buildConfig: '' },
						},
					},
					tcpPool: { basePort: 19000, size: 5 },
					toolVmProfiles: {
						standard: {
							cpus: 1,
							imageProfile: 'default',
							memory: '1G',
						},
					},
					zones: [
						{
							egressHosts: ['api.anthropic.com'].map((host) => ({
								host,
								audience: 'gateway' as const,
							})),
							gateway: {
								type: 'openclaw',
								controlAuth: {
									mode: 'token',
									secret: 'OPENCLAW_GATEWAY_TOKEN',
								},
								imageProfile: 'openclaw',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								zoneFilesDir: './zone-files/shravan',
							},
							id: 'shravan',
							secrets: {
								OPENCLAW_GATEWAY_TOKEN: {
									source: 'environment',
									envVar: 'OPENCLAW_GATEWAY_TOKEN',
									injection: 'env',
									audience: 'gateway',
								},
							},
							defaultToolVmProfile: 'standard',
							agentToolVmProfiles: {},
						},
					],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				startControllerRuntime: vi.fn(async () => createStartedControllerRuntime({ vmId: 'vm-1' })),
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(createBackup).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'shravan',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
				backupDir: './state/shravan/backups',
			}),
		);
		expect(outputs.join('')).toContain('shravan-2026-04-06T12-00.tar.age');
	});
});
