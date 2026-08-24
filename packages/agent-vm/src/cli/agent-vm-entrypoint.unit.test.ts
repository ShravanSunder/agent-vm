import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SecretRef } from '@agent-vm/secret-management';
import { formatMessage, parseSync } from '@optique/core';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ControllerRuntime } from '../controller/controller-runtime-types.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import {
	defaultCliDependencies,
	type CliDependencies,
	type CliIo,
} from './agent-vm-cli-support.js';
import { dispatchAgentVmCommand } from './agent-vm-command-dispatcher.js';
import { agentVmRootParser } from './agent-vm-command-parser.js';
import {
	handleCliMainError,
	isCliEntrypoint,
	loadOptionalLocalEnvironmentFile,
} from './agent-vm-entrypoint.js';
import { runControllerCommandOperation } from './commands/controller-command-operation.js';
import { parseAgentIds } from './commands/init-definition.js';

const hermesMainProfileSecretProjections = {
	main: {
		API_SERVER_KEY: 'API_SERVER_KEY',
		DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
	},
} as const;

const hermesMainSecrets = {
	API_SERVER_KEY: {
		source: 'environment',
		envVar: 'API_SERVER_KEY',
		injection: 'env',
		audience: 'gateway',
	},
	DISCORD_BOT_TOKEN: {
		source: 'environment',
		envVar: 'DISCORD_BOT_TOKEN',
		injection: 'env',
		audience: 'gateway',
	},
} as const;

function createCliBuildSystemConfig(): LoadedSystemConfig {
	return {
		schemaVersion: 2,
		storageRootDir: './storage',
		cacheDir: './cache',
		controllerStateDir: '/controller-state-test',
		controllerRuntimeDir: './controller-runtime',
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
				hermes: {
					type: 'hermes',
					buildConfig: './vm-images/gateways/hermes/build-config.json',
					dockerfile: './vm-images/gateways/hermes/Dockerfile',
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
					type: 'hermes',
					imageProfile: 'hermes',
					cpus: 2,
					memory: '2G',
					config: './config/shravan/hermes.yaml',
					port: 18791,
					profileSecretProjectionsByAgent: hermesMainProfileSecretProjections,
					profilesByAgent: { main: 'main' },
					stateDir: './state/shravan',
					zoneRuntimeDir: './runtime/shravan',
					zoneFilesDir: './zone-files/shravan',
				},
				id: 'shravan',
				secrets: hermesMainSecrets,
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
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

async function parseAndDispatchAgentVmCommandForTest(
	argv: readonly string[],
	io: CliIo,
	dependencies: CliDependencies = defaultCliDependencies,
): Promise<void> {
	const result = parseSync(agentVmRootParser, argv);
	if (!result.success) {
		throw new Error(formatMessage(result.error));
	}
	await dispatchAgentVmCommand(result.value, io, dependencies);
}

describe('parseAndDispatchAgentVmCommandForTest', () => {
	it('parses Hermes init agent ids with validation and dedupe', () => {
		expect(parseAgentIds(' sun,shravan, sun ,alevtina ')).toEqual(['sun', 'shravan', 'alevtina']);
		expect(() => parseAgentIds(' , , ')).toThrow(
			'--agents must include at least one non-empty agent id.',
		);
		expect(() => parseAgentIds('sun,Hello World')).toThrow("Invalid --agents value 'Hello World'");
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

		await parseAndDispatchAgentVmCommandForTest(
			['init', 'test-zone', '--type', 'hermes', '--secrets', '1password', '--arch', 'aarch64'],
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
				gatewayType: 'hermes',
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

		await parseAndDispatchAgentVmCommandForTest(
			[
				'init',
				'test-zone',
				'--type',
				'hermes',
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
			resolveManagedVmMinimumZigVersion: async () => '0.15.2',
		} satisfies CliDependencies;

		await parseAndDispatchAgentVmCommandForTest(
			[
				'init',
				'test-zone',
				'--type',
				'hermes',
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

		await parseAndDispatchAgentVmCommandForTest(
			[
				'init',
				'test-zone',
				'--type',
				'hermes',
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

	it('passes a single init agent id to the project scaffolder', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.json'],
			keychainStored: false,
			skipped: [],
		}));

		await parseAndDispatchAgentVmCommandForTest(
			[
				'init',
				'test-zone',
				'--type',
				'hermes',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--agents',
				'sun',
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
				agents: ['sun'],
			}),
		);
	});

	it('passes multi-agent managed Hermes init requests to the scaffolder', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.jsonc'],
			keychainStored: false,
			skipped: [],
		}));

		await parseAndDispatchAgentVmCommandForTest(
			[
				'init',
				'test-zone',
				'--type',
				'hermes',
				'--secrets',
				'1password',
				'--arch',
				'aarch64',
				'--agents',
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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
			parseAndDispatchAgentVmCommandForTest(
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
			parseAndDispatchAgentVmCommandForTest(
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
			parseAndDispatchAgentVmCommandForTest(
				['init', 'test-zone', '--type', 'worker', '--secrets', 'bogus'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				defaultCliDependencies,
			),
		).rejects.toThrow(/expected one of.*1password.*environment/u);
	});

	it('rejects init when --arch is missing', async () => {
		await expect(
			parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

	it('reports an empty system config instead of claiming multiple zones exist', async () => {
		const systemConfig = createCliBuildSystemConfig();

		await expect(
			parseAndDispatchAgentVmCommandForTest(
				['config', 'reset-instructions', '--config', 'config/system.json', '--phase', 'wrapup'],
				{ stderr: { write: () => true }, stdout: { write: () => true } },
				{
					...defaultCliDependencies,
					loadSystemConfig: vi.fn(async () => ({ ...systemConfig, zones: [] })),
				},
			),
		).rejects.toThrow('No zones configured in the system config.');
	});

	it('routes build to the build command handler', async () => {
		const runBuildCommand = vi.fn(async () => {});

		await parseAndDispatchAgentVmCommandForTest(
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
					controllerRuntimeDir: './controller-runtime',
					systemConfigPath: './config/system.json',
					imageProfiles: expect.objectContaining({
						gateways: expect.objectContaining({
							hermes: expect.objectContaining({
								type: 'hermes',
								dockerfile: './vm-images/gateways/hermes/Dockerfile',
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
			await dependencies.runTask('Gondolin: gateway/hermes', async () => {});
		});

		try {
			await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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
					controllerRuntimeDir: './controller-runtime',
					systemConfigPath: './config/system.json',
				}),
			},
			expect.any(Object),
		);
	});

	it('routes cache list through the cache command handler', async () => {
		const runCacheCommand = vi.fn(async () => {});

		await parseAndDispatchAgentVmCommandForTest(
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
					controllerRuntimeDir: './controller-runtime',
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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

	it('rejects an invalid gateway type value', async () => {
		await expect(
			parseAndDispatchAgentVmCommandForTest(
				['init', 'test-zone', '--type', 'banana', '--secrets', '1password'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				defaultCliDependencies,
			),
		).rejects.toThrow(/hermes|worker/u);
	});

	it('passes Hermes gateway type through to init scaffolding', async () => {
		const scaffoldAgentVmProject = vi.fn(async () => ({
			created: ['config/system.jsonc'],
			keychainStored: false,
			skipped: [],
		}));

		await parseAndDispatchAgentVmCommandForTest(
			['init', 'test-zone', '--type', 'hermes', '--secrets', 'environment', '--arch', 'aarch64'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				getCurrentWorkingDirectory: () => '/tmp/agent-vm-hermes-init',
				scaffoldAgentVmProject,
			},
		);

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith(
			expect.objectContaining({
				architecture: 'aarch64',
				gatewayType: 'hermes',
				targetDir: '/tmp/agent-vm-hermes-init',
				zoneId: 'test-zone',
			}),
		);
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
			parseAndDispatchAgentVmCommandForTest(
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

	it('routes doctor and status subcommands to their handlers', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-cli-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const hermesBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'gateways',
			'hermes',
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
			[hermesBuildConfigPath, workerBuildConfigPath, toolVmBuildConfigPath].map(
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

		await parseAndDispatchAgentVmCommandForTest(
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
				resolveManagedVmMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					schemaVersion: 2,
					storageRootDir: './storage',
					cacheDir: './cache',
					controllerStateDir: '/controller-state-test',
					controllerRuntimeDir: './controller-runtime',
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
							hermes: {
								type: 'hermes',
								buildConfig: hermesBuildConfigPath,
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
				runControllerOfflineCleanup: defaultCliDependencies.runControllerOfflineCleanup,
				startControllerRuntime: vi.fn(async () => createStartedControllerRuntime()),
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);
		await parseAndDispatchAgentVmCommandForTest(
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
				resolveManagedVmMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					schemaVersion: 2,
					storageRootDir: './storage',
					cacheDir: './cache',
					controllerStateDir: '/controller-state-test',
					controllerRuntimeDir: './controller-runtime',
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
							hermes: {
								type: 'hermes',
								buildConfig: hermesBuildConfigPath,
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
				runControllerOfflineCleanup: defaultCliDependencies.runControllerOfflineCleanup,
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

		await parseAndDispatchAgentVmCommandForTest(
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
				resolveManagedVmMinimumZigVersion: async () => '0.15.2',
				probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					schemaVersion: 2,
					storageRootDir: './storage',
					cacheDir: './cache',
					controllerStateDir: '/controller-state-test',
					controllerRuntimeDir: './controller-runtime',
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
							hermes: {
								type: 'hermes',
								buildConfig: './vm-images/gateways/hermes/build-config.json',
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
								type: 'hermes',
								profileSecretProjectionsByAgent: hermesMainProfileSecretProjections,
								profilesByAgent: { main: 'main' },
								imageProfile: 'hermes',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/hermes.yaml',
								port: 18791,
								stateDir: './state/shravan',
								zoneFilesDir: './zone-files/shravan',
								zoneRuntimeDir: './runtime/shravan',
							},
							id: 'shravan',
							secrets: hermesMainSecrets,
							defaultToolVmProfile: 'standard',
							agentToolVmProfiles: {},
						},
					],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				runControllerOfflineCleanup: defaultCliDependencies.runControllerOfflineCleanup,
				startControllerRuntime,
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(startControllerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneIds: ['shravan'],
			}),
			{
				runTask: expect.any(Function),
			},
		);
	});

	it('prints ingress and vm id from the selected controller runtime zone', async () => {
		const outputs: string[] = [];
		const baseSystemConfig = createCliBuildSystemConfig();

		await parseAndDispatchAgentVmCommandForTest(
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
			parseAndDispatchAgentVmCommandForTest(
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
			parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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
				zoneIds: ['alevtina'],
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
						gatewayType: 'hermes',
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
			resolveManagedVmMinimumZigVersion: async () => '0.15.2',
			probeOnePasswordServiceAccountHeadlessAuth: async () => ({ hint: 'ok', ok: true }),
			resolveServiceAccountToken: async () => 'mock-token',
			loadSystemConfig: async (): Promise<LoadedSystemConfig> => ({
				schemaVersion: 2,
				storageRootDir: './storage',
				cacheDir: './cache',
				controllerStateDir: '/controller-state-test',
				controllerRuntimeDir: './controller-runtime',
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
						hermes: {
							type: 'hermes',
							buildConfig: './vm-images/gateways/hermes/build-config.json',
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
							type: 'hermes',
							profileSecretProjectionsByAgent: hermesMainProfileSecretProjections,
							profilesByAgent: { main: 'main' },
							imageProfile: 'hermes',
							cpus: 2,
							memory: '2G',
							config: './config/shravan/hermes.yaml',
							port: 18791,
							stateDir: './state/shravan',
							zoneFilesDir: './zone-files/shravan',
							zoneRuntimeDir: './runtime/shravan',
						},
						id: 'shravan',
						secrets: hermesMainSecrets,
						defaultToolVmProfile: 'standard',
						agentToolVmProfiles: {},
					},
				],
			}),
			runControllerDoctor: () => ({
				checks: [],
				ok: true,
			}),
			runControllerOfflineCleanup: defaultCliDependencies.runControllerOfflineCleanup,
			startControllerRuntime: vi.fn(async () => createStartedControllerRuntime()),
			startGatewayZone: vi.fn(async () => undefined as never),
		};
		const previousApiServerKey = process.env.API_SERVER_KEY;
		const previousDiscordBotToken = process.env.DISCORD_BOT_TOKEN;
		process.env.API_SERVER_KEY = 'gateway-token';
		process.env.DISCORD_BOT_TOKEN = 'discord-token';

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
				await parseAndDispatchAgentVmCommandForTest(
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
			if (previousApiServerKey === undefined) {
				delete process.env.API_SERVER_KEY;
			} else {
				process.env.API_SERVER_KEY = previousApiServerKey;
			}
			if (previousDiscordBotToken === undefined) {
				delete process.env.DISCORD_BOT_TOKEN;
			} else {
				process.env.DISCORD_BOT_TOKEN = previousDiscordBotToken;
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
		expect(outputs.join('\n')).toContain('"resolvedSecretCount": 2');
	});

	it('routes controller ssh through the Hermes interactive shell handler', async () => {
		const runInteractiveProcess: NonNullable<CliDependencies['runInteractiveProcess']> = vi.fn(
			async () => {},
		);

		await parseAndDispatchAgentVmCommandForTest(
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
						user: 'root',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', expect.any(Array));
		const firstSshCall = vi.mocked(runInteractiveProcess).mock.calls[0];
		if (!firstSshCall) {
			throw new Error('Expected SSH process to run.');
		}
		const sshArguments = firstSshCall[1];
		const remoteCommand = sshArguments.at(-1);
		expect(remoteCommand).toEqual(
			expect.stringContaining('source /etc/profile.d/hermes-env.sh && exec bash -l'),
		);
	});

	it('routes controller stop through the controller client', async () => {
		const stopController = vi.fn(async () => ({ ok: true }));

		await parseAndDispatchAgentVmCommandForTest(
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
					ownershipDisposition: 'complete' as const,
					stateDir: './state/shravan',
					zoneId: 'shravan',
				},
			],
		}));

		await parseAndDispatchAgentVmCommandForTest(
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
					ownershipDisposition: 'complete',
					stateDir: './state/shravan',
					zoneId: 'shravan',
				},
			],
		});
	});

	it('passes controller cleanup force through offline cleanup', async () => {
		const runControllerOfflineCleanup = vi.fn(async () => ({ results: [] }));

		await parseAndDispatchAgentVmCommandForTest(
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

	it('aborts controller cleanup when process logging setup fails', async () => {
		const commandResult = parseSync(agentVmRootParser, [
			'controller',
			'cleanup',
			'--config',
			'./config/system.json',
			'--zone',
			'shravan',
		]);
		if (!commandResult.success || commandResult.value.command !== 'controller.cleanup') {
			throw new Error('Expected controller cleanup command to parse.');
		}
		const runControllerOfflineCleanup = vi.fn(async () => ({ results: [] }));
		const stdoutChunks: string[] = [];

		await expect(
			runControllerCommandOperation(
				{
					stderr: { write: () => true },
					stdout: {
						write: (chunk: string | Uint8Array): boolean => {
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
				commandResult.value,
				{
					configureProcessLogging: vi.fn(async () => {
						throw new Error('sink unavailable');
					}),
					processRoot: true,
				},
			),
		).rejects.toThrow('Controller process logging setup failed.');
		expect(runControllerOfflineCleanup).not.toHaveBeenCalled();
		expect(stdoutChunks).toEqual([]);
	});

	it('propagates exact reconciliation failure without writing a success result', async () => {
		const stderrChunks: string[] = [];
		const stdoutChunks: string[] = [];
		const reconciliationError = Object.assign(
			new Error('exact VM ownership reconciliation failed'),
			{ code: 'owner-unsafe' as const },
		);
		const runControllerOfflineCleanup = vi.fn(async () => {
			throw reconciliationError;
		});

		await expect(
			parseAndDispatchAgentVmCommandForTest(
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
		).rejects.toBe(reconciliationError);

		expect(runControllerOfflineCleanup).toHaveBeenCalledOnce();
		expect(stdoutChunks.join('')).toBe('');
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
			parseAndDispatchAgentVmCommandForTest(
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
			parseAndDispatchAgentVmCommandForTest(
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
		).rejects.toThrow('lease');
		await expect(
			parseAndDispatchAgentVmCommandForTest(
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
		).rejects.toThrow('lease');

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

		await parseAndDispatchAgentVmCommandForTest(
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
					schemaVersion: 2,
					storageRootDir: './storage',
					cacheDir: './cache',
					controllerStateDir: '/controller-state-test',
					controllerRuntimeDir: './controller-runtime',
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
							hermes: { type: 'hermes', buildConfig: '' },
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
								type: 'hermes',
								profileSecretProjectionsByAgent: hermesMainProfileSecretProjections,
								profilesByAgent: { main: 'main' },
								imageProfile: 'hermes',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/hermes.yaml',
								port: 18791,
								stateDir: './state/shravan',
								zoneFilesDir: './zone-files/shravan',
								zoneRuntimeDir: './runtime/shravan',
							},
							id: 'shravan',
							secrets: hermesMainSecrets,
							defaultToolVmProfile: 'standard',
							agentToolVmProfiles: {},
						},
					],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				runControllerOfflineCleanup: defaultCliDependencies.runControllerOfflineCleanup,
				startControllerRuntime: vi.fn(async () => createStartedControllerRuntime({ vmId: 'vm-1' })),
				resolveManagedVmMinimumZigVersion: async () => '0.15.2',
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
			parseAndDispatchAgentVmCommandForTest(
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

		await parseAndDispatchAgentVmCommandForTest(
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
						expect(ref.ref).toBe('op://test-vault/backup-identity/password');
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
					schemaVersion: 2,
					storageRootDir: './storage',
					cacheDir: './cache',
					controllerStateDir: '/controller-state-test',
					controllerRuntimeDir: './controller-runtime',
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
							hermes: { type: 'hermes', buildConfig: '' },
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
								type: 'hermes',
								profileSecretProjectionsByAgent: hermesMainProfileSecretProjections,
								profilesByAgent: { main: 'main' },
								imageProfile: 'hermes',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/hermes.yaml',
								port: 18791,
								stateDir: './state/shravan',
								zoneFilesDir: './zone-files/shravan',
								zoneRuntimeDir: './runtime/shravan',
								backupIdentity: {
									source: '1password',
									ref: 'op://test-vault/backup-identity/password',
								},
							},
							id: 'shravan',
							secrets: hermesMainSecrets,
							defaultToolVmProfile: 'standard',
							agentToolVmProfiles: {},
						},
					],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				runControllerOfflineCleanup: defaultCliDependencies.runControllerOfflineCleanup,
				startControllerRuntime: vi.fn(async () => createStartedControllerRuntime({ vmId: 'vm-1' })),
				resolveManagedVmMinimumZigVersion: async () => '0.15.2',
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
