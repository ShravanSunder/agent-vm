import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import {
	handleCliMainError,
	isCliEntrypoint,
	loadOptionalLocalEnvironmentFile,
	ReportedCliError,
	runAgentVmCli,
} from './agent-vm-entrypoint.js';

function createCliBuildSystemConfig(): LoadedSystemConfig {
	return {
		cacheDir: './cache',
		systemConfigPath: './config/system.json',
		systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
		toolProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				workspaceRoot: './workspaces/tools',
				imageProfile: 'default',
			},
		},
		zones: [
			{
				allowedHosts: ['api.anthropic.com'],
				gateway: {
					type: 'openclaw',
					imageProfile: 'openclaw',
					cpus: 2,
					memory: '2G',
					config: './config/shravan/openclaw.json',
					port: 18791,
					stateDir: './state/shravan',
					workspaceDir: './workspaces/shravan',
				},
				id: 'shravan',
				secrets: {},
				toolProfile: 'standard',
				websocketBypass: [],
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
		listLeases: async () => [],
		refreshZoneCredentials: async () => ({}),
		releaseLease: async () => {},
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

describe('runAgentVmCli', () => {
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
				systemConfig: expect.objectContaining({
					cacheDir: './cache',
					systemConfigPath: './config/system.json',
					systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
			},
		);
	});

	it('uses plain progress for build even in a TTY', async () => {
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

		expect(stderrChunks.join('')).toContain('Gondolin: gateway/openclaw...');
		expect(stderrChunks.join('')).toContain('Gondolin: gateway/openclaw done');
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
					systemConfigPath: './config/system.json',
					systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
					systemConfigPath: './config/system.json',
					systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
				}),
			},
			expect.any(Object),
		);
	});

	it('routes validate through the injected validation helper', async () => {
		const stdoutChunks: string[] = [];
		const runConfigValidation = vi.fn(async () => ({
			ok: true,
			checks: [{ name: 'system-cache-identifier', ok: true }],
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

	it('routes auth to an interactive SSH-backed OpenClaw login', async () => {
		const runInteractiveProcess = vi.fn(async () => {});

		await runAgentVmCli(
			['auth-interactive', 'codex', '--zone', 'shravan'],
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
	});

	it('auth-interactive without --zone shows available zones', async () => {
		const stderrChunks: string[] = [];
		await expect(
			runAgentVmCli(
				['auth-interactive', 'codex'],
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
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		await fs.writeFile(systemCacheIdentifierPath, '{"schemaVersion":1}\n', 'utf8');
		const outputs: string[] = [];

		await runAgentVmCli(
			['doctor'],
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
					toolProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getControllerStatus: async () => ({
						controllerPort: 18800,
						toolProfiles: ['standard'],
						zones: [],
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
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				isGatewayImageCached: async () => true,
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					cacheDir: './cache',
					systemConfigPath,
					systemCacheIdentifierPath,
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
					toolProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							workspaceRoot: './workspaces/tools',
							imageProfile: 'default',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(
					async () =>
						({
							controllerPort: 18800,
							gateway: {
								ingress: {
									host: '127.0.0.1',
									port: 18791,
								},
								vm: {
									id: 'vm-123',
								},
							},
							close: async () => {},
						}) as never,
				),
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
					toolProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getControllerStatus: async () => ({
						controllerPort: 18800,
						toolProfiles: ['standard'],
						zones: [],
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
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				isGatewayImageCached: async () => true,
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					cacheDir: './cache',
					systemConfigPath: './config/system.json',
					systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
					toolProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							workspaceRoot: './workspaces/tools',
							imageProfile: 'default',
						},
					},
					zones: [],
				}),
				runControllerDoctor: () => ({
					checks: [],
					ok: true,
				}),
				startControllerRuntime: vi.fn(
					async () =>
						({
							controllerPort: 18800,
							gateway: {
								ingress: {
									host: '127.0.0.1',
									port: 18791,
								},
								vm: {
									id: 'vm-123',
								},
							},
							close: async () => {},
						}) as never,
				),
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(outputs.join('\n')).toContain('"ok": true');
		expect(outputs.join('\n')).toContain('"controllerPort": 18800');
		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('passes the bundled gondolin plugin source path into controller start', async () => {
		const startControllerRuntime = vi.fn(
			async () =>
				({
					controllerPort: 18800,
					gateway: {
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						vm: {
							id: 'vm-123',
						},
					},
					close: async () => {},
				}) as never,
		);

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
					toolProfiles: ['standard'],
					zones: [],
				}),
				createControllerClient: () => ({
					destroyZone: async () => ({ ok: true, zoneId: 'shravan' }),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({ output: '', zoneId: 'shravan' }),
					getControllerStatus: async () => ({
						controllerPort: 18800,
						toolProfiles: ['standard'],
						zones: [],
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
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				isGatewayImageCached: async () => true,
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: async () => ({
					cacheDir: './cache',
					systemConfigPath: './config/system.json',
					systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
					toolProfiles: {
						standard: {
							cpus: 1,
							memory: '1G',
							workspaceRoot: './workspaces/tools',
							imageProfile: 'default',
						},
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								type: 'openclaw',
								imageProfile: 'openclaw',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								workspaceDir: './workspaces/shravan',
							},
							id: 'shravan',
							secrets: {},
							websocketBypass: [],
							toolProfile: 'standard',
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
		const startControllerRuntime = vi.fn(async () => ({
			controllerPort: 18800,
			gateway: {
				ingress: {
					host: '127.0.0.1',
					port: 18792,
				},
				vm: {
					id: 'vm-alevtina',
				},
			},
		}));

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
				toolProfiles: ['standard'],
				zones: [
					{
						gatewayType: 'openclaw',
						id: 'shravan',
						ingressPort: 18791,
						toolProfile: 'standard',
					},
				],
			})),
			getZoneLogs: vi.fn(async () => ({ output: 'logs', zoneId: 'shravan' })),
			listLeases: vi.fn(async () => []),
			refreshZoneCredentials: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
			releaseLease: vi.fn(async () => {}),
			stopController: vi.fn(async () => ({ ok: true })),
			upgradeZone: vi.fn(async () => ({ ok: true, zoneId: 'shravan' })),
		};

		const baseDependencies = {
			buildControllerStatus: () => ({
				controllerPort: 18800,
				toolProfiles: ['standard'],
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
				restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
				listBackups: () => [],
			}),
			resolveGondolinMinimumZigVersion: async () => '0.15.2',
			resolveServiceAccountToken: async () => 'mock-token',
			loadSystemConfig: async (): Promise<LoadedSystemConfig> => ({
				cacheDir: './cache',
				systemConfigPath: './config/system.json',
				systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
				toolProfiles: {
					standard: {
						cpus: 1,
						memory: '1G',
						workspaceRoot: './workspaces/tools',
						imageProfile: 'default',
					},
				},
				zones: [
					{
						allowedHosts: ['api.anthropic.com'],
						gateway: {
							type: 'openclaw',
							imageProfile: 'openclaw',
							cpus: 2,
							memory: '2G',
							config: './config/shravan/openclaw.json',
							port: 18791,
							stateDir: './state/shravan',
							workspaceDir: './workspaces/shravan',
						},
						id: 'shravan',
						secrets: {},
						websocketBypass: [],
						toolProfile: 'standard',
					},
				],
			}),
			runControllerDoctor: () => ({
				checks: [],
				ok: true,
			}),
			startControllerRuntime: vi.fn(async () => ({
				controllerPort: 18800,
				gateway: {
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					vm: {
						id: 'vm-123',
					},
				},
			})),
			startGatewayZone: vi.fn(async () => undefined as never),
		};

		for (const command of [
			['controller', 'status'],
			['controller', 'logs', '--zone', 'shravan'],
			['controller', 'destroy', '--zone', 'shravan', '--purge'],
			['controller', 'upgrade', '--zone', 'shravan'],
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

		expect(controllerClient.getControllerStatus).toHaveBeenCalled();
		expect(controllerClient.getZoneLogs).toHaveBeenCalledWith('shravan');
		expect(controllerClient.destroyZone).toHaveBeenCalledWith('shravan', true);
		expect(controllerClient.upgradeZone).toHaveBeenCalledWith('shravan');
		expect(controllerClient.refreshZoneCredentials).toHaveBeenCalledWith('shravan');
		expect(outputs.join('\n')).toContain('"zoneId": "shravan"');
	});

	it('routes controller ssh through the ssh command handler', async () => {
		const runInteractiveProcess = vi.fn(async () => {});

		await runAgentVmCli(
			['controller', 'ssh', '--zone', 'shravan', '--print'],
			{
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			{
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						command: 'ssh root@127.0.0.1',
					})),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).not.toHaveBeenCalled();
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

	it('routes controller lease list and release through the lease handler', async () => {
		const listLeases = vi.fn(async () => [{ id: 'lease-123' }]);
		const releaseLease = vi.fn(async () => {});

		await runAgentVmCli(
			['controller', 'lease', 'list'],
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
					listLeases,
					refreshZoneCredentials: async () => ({}),
					releaseLease,
					stopController: async () => ({ ok: true }),
					upgradeZone: async () => ({}),
				}),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
			},
		);

		await runAgentVmCli(
			['controller', 'lease', 'release', 'lease-123'],
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
					listLeases,
					refreshZoneCredentials: async () => ({}),
					releaseLease,
					stopController: async () => ({ ok: true }),
					upgradeZone: async () => ({}),
				}),
				loadSystemConfig: vi.fn(async () => createCliBuildSystemConfig()),
			},
		);

		expect(listLeases).toHaveBeenCalled();
		expect(releaseLease).toHaveBeenCalledWith('lease-123');
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
					toolProfiles: ['standard'],
					zones: [],
				}),
				createAgeBackupEncryption: () => ({ encrypt: async () => {}, decrypt: async () => {} }),
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({ command: 'ssh root@127.0.0.1' }),
					getZoneLogs: async () => ({}),
					getControllerStatus: async () => ({}),
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
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listBackups,
				}),
				loadSystemConfig: async () => ({
					cacheDir: './cache',
					systemConfigPath: './config/system.json',
					systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
					toolProfiles: {
						standard: {
							cpus: 1,
							imageProfile: 'default',
							memory: '1G',
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								type: 'openclaw',
								imageProfile: 'openclaw',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								workspaceDir: './workspaces/shravan',
							},
							id: 'shravan',
							secrets: {},
							websocketBypass: [],
							toolProfile: 'standard',
						},
					],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				startControllerRuntime: vi.fn(async () => ({
					controllerPort: 18800,
					gateway: { ingress: { host: '127.0.0.1', port: 18791 }, vm: { id: 'vm-1' } },
				})),
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
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
					toolProfiles: ['standard'],
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
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				createSecretResolver: async () => ({
					resolve: async (ref: { ref: string }) => {
						// Verify the 1P ref pattern
						expect(ref.ref).toBe('op://agent-vm/shravan-gateway-backup/password');
						return 'resolved-passphrase';
					},
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup,
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				loadSystemConfig: async () => ({
					cacheDir: './cache',
					systemConfigPath: './config/system.json',
					systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
					toolProfiles: {
						standard: {
							cpus: 1,
							imageProfile: 'default',
							memory: '1G',
							workspaceRoot: './workspaces/tools',
						},
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								type: 'openclaw',
								imageProfile: 'openclaw',
								cpus: 2,
								memory: '2G',
								config: './config/shravan/openclaw.json',
								port: 18791,
								stateDir: './state/shravan',
								workspaceDir: './workspaces/shravan',
							},
							id: 'shravan',
							secrets: {},
							websocketBypass: [],
							toolProfile: 'standard',
						},
					],
				}),
				runControllerDoctor: () => ({ checks: [], ok: true }),
				startControllerRuntime: vi.fn(async () => ({
					controllerPort: 18800,
					gateway: { ingress: { host: '127.0.0.1', port: 18791 }, vm: { id: 'vm-1' } },
				})),
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(createBackup).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'shravan',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
				backupDir: './state/shravan/backups',
			}),
		);
		expect(outputs.join('')).toContain('shravan-2026-04-06T12-00.tar.age');
	});
});
