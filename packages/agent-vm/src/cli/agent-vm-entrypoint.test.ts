import { describe, expect, it, vi } from 'vitest';

import type { ControllerClient } from '../controller/controller-client.js';
import type { SystemConfig } from '../controller/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { loadOptionalLocalEnvironmentFile, runAgentVmCli } from './agent-vm-entrypoint.js';

function createCliBuildSystemConfig(): SystemConfig {
	return {
		cacheDir: './cache',
		host: {
			controllerPort: 18800,
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env' },
			},
		},
		images: {
			gateway: {
				buildConfig: './images/gateway/build-config.json',
				dockerfile: './images/gateway/Dockerfile',
			},
			tool: {
				buildConfig: './images/tool/build-config.json',
				dockerfile: './images/tool/Dockerfile',
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
			},
		},
		zones: [
			{
				allowedHosts: ['api.anthropic.com'],
				gateway: {
					cpus: 2,
					memory: '2G',
					openclawConfig: './config/shravan/openclaw.json',
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

	it('routes init to the project scaffolder', async () => {
		const outputs: string[] = [];
		const scaffoldAgentVmProject = vi.fn(() => ({
			created: ['system.json', '.env.local'],
			skipped: [],
		}));

		await runAgentVmCli(
			['init', 'test-zone'],
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

		expect(scaffoldAgentVmProject).toHaveBeenCalledWith({
			targetDir: '/tmp/agent-vm-init',
			zoneId: 'test-zone',
		});
		expect(outputs.join('')).toContain('"system.json"');
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
				loadSystemConfig: vi.fn(() => createCliBuildSystemConfig()),
				runBuildCommand,
			},
		);

		expect(runBuildCommand).toHaveBeenCalledWith(
			{
				forceRebuild: false,
				systemConfig: expect.objectContaining({
					cacheDir: './cache',
					images: expect.objectContaining({
						gateway: expect.objectContaining({
							dockerfile: './images/gateway/Dockerfile',
						}),
					}),
				}),
			},
			expect.any(Object),
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
				loadSystemConfig: vi.fn(() => createCliBuildSystemConfig()),
				runBuildCommand,
			},
		);

		expect(runBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				forceRebuild: true,
			}),
			expect.any(Object),
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
				loadSystemConfig: vi.fn(() => createCliBuildSystemConfig()),
				runCacheCommand,
			},
		);

		expect(runCacheCommand).toHaveBeenCalledWith(
			{
				confirm: true,
				subcommand: 'clean',
				systemConfig: expect.objectContaining({
					cacheDir: './cache',
				}),
			},
			expect.any(Object),
		);
	});

	it('routes auth to an interactive SSH-backed OpenClaw login', async () => {
		const runInteractiveProcess = vi.fn(async () => {});

		await runAgentVmCli(
			['auth', 'codex', '--zone', 'shravan'],
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
				loadSystemConfig: vi.fn(() => createCliBuildSystemConfig()),
				runInteractiveProcess,
			},
		);

		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', [
			'-i',
			'/tmp/test-key',
			'-p',
			'19000',
			'root@127.0.0.1',
			'openclaw',
			'auth',
			'login',
			'codex',
		]);
	});

	it('throws a usage error when auth is missing the plugin name', async () => {
		await expect(
			runAgentVmCli(
				['auth'],
				{
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				{
					...defaultCliDependencies,
					loadSystemConfig: vi.fn(() => createCliBuildSystemConfig()),
				},
			),
		).rejects.toThrow('Usage: agent-vm auth <plugin> --zone <id>');
	});

	it('routes doctor and status subcommands to their handlers', async () => {
		const outputs: string[] = [];

		await runAgentVmCli(
			['controller', 'doctor'],
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
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: () => ({
					cacheDir: './cache',
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: {
							buildConfig: './images/gateway/build-config.json',
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
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
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: () => ({
					cacheDir: './cache',
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: {
							buildConfig: './images/gateway/build-config.json',
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
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
			['controller', 'start'],
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
				resolveServiceAccountToken: async () => 'mock-token',
				loadSystemConfig: () => ({
					cacheDir: './cache',
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: {
							buildConfig: './images/gateway/build-config.json',
						},
						tool: {
							buildConfig: './images/tool/build-config.json',
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
						},
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								cpus: 2,
								memory: '2G',
								openclawConfig: './config/shravan/openclaw.json',
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
				zones: [{ id: 'shravan', ingressPort: 18791, toolProfile: 'standard' }],
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
			resolveServiceAccountToken: async () => 'mock-token',
			loadSystemConfig: (): SystemConfig => ({
				cacheDir: './cache',
				host: {
					controllerPort: 18800,
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				images: {
					gateway: {
						buildConfig: './images/gateway/build-config.json',
					},
					tool: {
						buildConfig: './images/tool/build-config.json',
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
					},
				},
				zones: [
					{
						allowedHosts: ['api.anthropic.com'],
						gateway: {
							cpus: 2,
							memory: '2G',
							openclawConfig: './config/shravan/openclaw.json',
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
				loadSystemConfig: () => ({
					cacheDir: './cache',
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: { buildConfig: '' },
						tool: { buildConfig: '' },
					},
					tcpPool: { basePort: 19000, size: 5 },
					toolProfiles: {
						standard: { cpus: 1, memory: '1G', workspaceRoot: './workspaces/tools' },
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								cpus: 2,
								memory: '2G',
								openclawConfig: './config/shravan/openclaw.json',
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
				resolveServiceAccountToken: async () => 'mock-token',
				startGatewayZone: vi.fn(async () => undefined as never),
			},
		);

		expect(listBackups).toHaveBeenCalledWith(
			expect.objectContaining({ backupDir: './state/shravan/backups', zoneId: 'shravan' }),
		);
		expect(outputs.join('')).toContain('shravan-2026-04-06.tar.age');
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
						expect(ref.ref).toBe('op://agent-vm/agent-shravan-backup/password');
						return 'resolved-passphrase';
					},
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup,
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					listBackups: () => [],
				}),
				loadSystemConfig: () => ({
					cacheDir: './cache',
					host: {
						controllerPort: 18800,
						secretsProvider: {
							type: '1password',
							tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
						},
					},
					images: {
						gateway: { buildConfig: '' },
						tool: { buildConfig: '' },
					},
					tcpPool: { basePort: 19000, size: 5 },
					toolProfiles: {
						standard: { cpus: 1, memory: '1G', workspaceRoot: './workspaces/tools' },
					},
					zones: [
						{
							allowedHosts: ['api.anthropic.com'],
							gateway: {
								cpus: 2,
								memory: '2G',
								openclawConfig: './config/shravan/openclaw.json',
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
