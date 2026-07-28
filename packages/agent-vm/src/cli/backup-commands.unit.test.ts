import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runBackupCommand } from './backup-commands.js';

function createBackupSystemConfig(): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			storageRootDir: './storage',
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
					},
					id: 'shravan',
					agents: [{ id: 'main' }],
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
		},
		{ systemConfigPath: './config/system.json' },
	);
}

type BackupIdentityReference = NonNullable<
	LoadedSystemConfig['zones'][number]['gateway']['backupIdentity']
>;

function withBackupIdentity(
	systemConfig: LoadedSystemConfig,
	backupIdentity: BackupIdentityReference,
): LoadedSystemConfig {
	return {
		...systemConfig,
		zones: systemConfig.zones.map((zone) => ({
			...zone,
			gateway: { ...zone.gateway, backupIdentity },
		})),
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('runBackupCommand', () => {
	it('lists backups without resolving secrets', async () => {
		const outputs: string[] = [];
		const systemConfig = createBackupSystemConfig();
		const listBackups = vi.fn(() => [
			{
				backupPath: './state/shravan/backups/shravan__2026-04-11.tar.age',
				timestamp: '2026-04-11',
				zoneId: 'shravan',
			},
		]);

		await runBackupCommand({
			dependencies: {
				...defaultCliDependencies,
				buildControllerStatus: () => ({ controllerPort: 18800, toolVmProfiles: [], zones: [] }),
				createAgeBackupEncryption: () => ({ decrypt: async () => {}, encrypt: async () => {} }),
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
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
					listBackups,
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
				}),
				loadSystemConfig: async () => systemConfig,
				resolveServiceAccountToken: async () => 'token',
				runControllerDoctor: () => ({ checks: [], ok: true }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['list', '--zone', 'shravan'],
			systemConfig,
		});

		expect(listBackups).toHaveBeenCalledWith({
			backupDir: 'storage/shravan/state/backups',
			zoneId: 'shravan',
		});
		expect(outputs.join('')).toContain('shravan__2026-04-11.tar.age');
	});

	it('creates a backup with the configured environment identity', async () => {
		const createBackup = vi.fn(async () => ({
			backupPath: './state/shravan/backups/shravan__2026-04-11.tar.age',
			timestamp: '2026-04-11',
			zoneId: 'shravan',
		}));
		const systemConfig = withBackupIdentity(createBackupSystemConfig(), {
			source: 'environment',
			envVar: 'AGENT_VM_TEST_BACKUP_IDENTITY',
		});
		let identityPromise: Promise<string> | undefined;
		vi.stubEnv('AGENT_VM_TEST_BACKUP_IDENTITY', 'test-environment-backup-identity');
		await runBackupCommand({
			dependencies: {
				...defaultCliDependencies,
				buildControllerStatus: () => ({ controllerPort: 18800, toolVmProfiles: [], zones: [] }),
				createAgeBackupEncryption: (dependencies) => {
					identityPromise = dependencies.resolveIdentity();
					return { decrypt: async () => {}, encrypt: async () => {} };
				},
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
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
					resolve: async () => 'unused-1password-secret',
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup,
					listBackups: () => [],
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
				}),
				loadSystemConfig: async () => systemConfig,
				resolveServiceAccountToken: async () => 'token',
				runControllerDoctor: () => ({ checks: [], ok: true }),
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			restArguments: ['create', '--zone', 'shravan'],
			systemConfig,
		});

		await expect(identityPromise).resolves.toBe('test-environment-backup-identity');
		expect(createBackup).toHaveBeenCalledWith({
			backupDir: 'storage/shravan/state/backups',
			cacheDir: 'storage/cache',
			stateDir: 'storage/shravan/state',
			zoneFilesDir: 'storage/shravan/zone-files',
			zoneId: 'shravan',
			zoneRuntimeDir: 'storage/shravan/runtime',
		});
	});

	it('throws when restore is missing a backup path', async () => {
		const systemConfig = createBackupSystemConfig();

		await expect(
			runBackupCommand({
				dependencies: {
					...defaultCliDependencies,
					buildControllerStatus: () => ({ controllerPort: 18800, toolVmProfiles: [], zones: [] }),
					createAgeBackupEncryption: () => ({ decrypt: async () => {}, encrypt: async () => {} }),
					createControllerClient: () => ({
						destroyZone: async () => ({}),
						enableZoneSsh: async () => ({}),
						getControllerStatus: async () => ({}),
						getZoneLogs: async () => ({}),
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
						listBackups: () => [],
						restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
					}),
					loadSystemConfig: async () => systemConfig,
					resolveServiceAccountToken: async () => 'token',
					runControllerDoctor: () => ({ checks: [], ok: true }),
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				restArguments: ['restore', '--zone', 'shravan'],
				systemConfig,
			}),
		).rejects.toThrow('Usage: agent-vm backup restore <path> [--zone <id>]');
	});

	it.each(['create', 'restore'] as const)(
		'requires gateway.backupIdentity for backup %s',
		async (backupSubcommand) => {
			const systemConfig = createBackupSystemConfig();
			const restArguments =
				backupSubcommand === 'restore'
					? ['restore', '/tmp/backup.tar.age', '--zone', 'shravan']
					: ['create', '--zone', 'shravan'];

			await expect(
				runBackupCommand({
					dependencies: defaultCliDependencies,
					io: {
						stderr: { write: () => true },
						stdout: { write: () => true },
					},
					restArguments,
					systemConfig,
				}),
			).rejects.toThrow(
				`Zone 'shravan' must configure gateway.backupIdentity for backup ${backupSubcommand}.`,
			);
		},
	);

	it('restores a backup with the configured inline identity', async () => {
		const restoreBackup = vi.fn(async () => ({
			stateDir: './state/shravan',
			zoneFilesDir: './zone-files/shravan',
			zoneId: 'shravan',
		}));
		const systemConfig = withBackupIdentity(createBackupSystemConfig(), {
			source: 'config',
			value: 'test-inline-backup-identity',
		});
		const outputs: string[] = [];
		let identityPromise: Promise<string> | undefined;

		await runBackupCommand({
			dependencies: {
				...defaultCliDependencies,
				buildControllerStatus: () => ({ controllerPort: 18800, toolVmProfiles: [], zones: [] }),
				createAgeBackupEncryption: (dependencies) => {
					identityPromise = dependencies.resolveIdentity();
					return { decrypt: async () => {}, encrypt: async () => {} };
				},
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
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
					resolve: async () => 'unused-1password-secret',
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup: async () => ({ backupPath: '', timestamp: '', zoneId: '' }),
					listBackups: () => [],
					restoreBackup,
				}),
				loadSystemConfig: async () => systemConfig,
				resolveServiceAccountToken: async () => 'token',
				runControllerDoctor: () => ({ checks: [], ok: true }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['restore', '/tmp/backup.tar.age', '--zone', 'shravan'],
			systemConfig,
		});

		await expect(identityPromise).resolves.toBe('test-inline-backup-identity');
		expect(restoreBackup).toHaveBeenCalledWith({
			backupPath: '/tmp/backup.tar.age',
			stateDir: 'storage/shravan/state',
			zoneFilesDir: 'storage/shravan/zone-files',
		});
		expect(outputs.join('')).toContain('"zoneId": "shravan"');
	});

	it('requires --zone explicitly', async () => {
		const systemConfig = createBackupSystemConfig();

		await expect(
			runBackupCommand({
				dependencies: defaultCliDependencies,
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				restArguments: ['list'],
				systemConfig,
			}),
		).rejects.toThrow('--zone is required');
	});

	it('uses gateway.backupDir when set, not the legacy stateDir/backups', async () => {
		const baseConfig = createBackupSystemConfig();
		const systemConfig: LoadedSystemConfig = {
			...baseConfig,
			zones: baseConfig.zones.map((zone) => ({
				...zone,
				gateway: { ...zone.gateway, backupDir: '/var/agent-vm-backups/shravan' },
			})),
		};

		const listBackups = vi.fn(() => []);

		await runBackupCommand({
			dependencies: {
				...defaultCliDependencies,
				buildControllerStatus: () => ({ controllerPort: 18800, toolVmProfiles: [], zones: [] }),
				createAgeBackupEncryption: () => ({ decrypt: async () => {}, encrypt: async () => {} }),
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
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
					listBackups,
					restoreBackup: async () => ({ stateDir: '', zoneFilesDir: '', zoneId: '' }),
				}),
				loadSystemConfig: async () => systemConfig,
				resolveServiceAccountToken: async () => 'token',
				runControllerDoctor: () => ({ checks: [], ok: true }),
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			restArguments: ['list', '--zone', 'shravan'],
			systemConfig,
		});

		expect(listBackups).toHaveBeenCalledWith({
			backupDir: '/var/agent-vm-backups/shravan',
			zoneId: 'shravan',
		});
	});
});
