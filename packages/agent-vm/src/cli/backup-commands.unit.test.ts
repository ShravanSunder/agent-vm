import os from 'node:os';
import path from 'node:path';

import type { SecretRef } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type { GatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
import type { ProcessIdentity } from '../shared/managed-vm-process.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { assertRestoreTargetNotLive, runBackupCommand } from './backup-commands.js';

function createBackupSystemConfig(): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: './cache',
			runtimeDir: './runtime',
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
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath: './config/system.json' },
	);
}

const managedProcessIdentity = {
	command: 'qemu-system-aarch64 -m 2G',
	lstart: 'Thu Jun 11 10:00:00 2026',
} satisfies ProcessIdentity;

const nonManagedProcessIdentity = {
	command: '/usr/bin/ssh-agent',
	lstart: 'Thu Jun 11 10:00:00 2026',
} satisfies ProcessIdentity;

const defaultShravanBackupDir = path.join(os.homedir(), '.agent-vm-backups', 'shravan');

function createRuntimeRecord(processIdentity: ProcessIdentity): GatewayRuntimeRecord {
	return {
		configPath: '/project/config/system.json',
		controllerPort: 18800,
		createdAt: '2026-06-11T10:00:00.000Z',
		gatewayType: 'openclaw',
		guestListenPort: 3000,
		ingressPort: 18791,
		processIdentity,
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 12345,
		schemaVersion: 1,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: 'gateway-vm-123',
		zoneId: 'shravan',
	};
}

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
			backupDir: defaultShravanBackupDir,
			zoneId: 'shravan',
		});
		expect(outputs.join('')).toContain('shravan__2026-04-11.tar.age');
	});

	it('creates a backup with the per-zone 1Password key ref', async () => {
		const createBackup = vi.fn(async () => ({
			backupPath: './state/shravan/backups/shravan__2026-04-11.tar.age',
			timestamp: '2026-04-11',
			zoneId: 'shravan',
		}));
		const systemConfig = createBackupSystemConfig();

		await runBackupCommand({
			dependencies: {
				...defaultCliDependencies,
				buildControllerStatus: () => ({ controllerPort: 18800, toolVmProfiles: [], zones: [] }),
				createAgeBackupEncryption: (dependencies) => {
					void dependencies.resolveIdentity();
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
					resolve: async (secretRef: SecretRef) => {
						if (secretRef.source === 'config') {
							throw new Error('Unexpected config secret.');
						}
						expect(secretRef.ref).toBe('op://agent-vm/shravan-gateway-backup/password');
						return 'backup-key';
					},
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

		expect(createBackup).toHaveBeenCalledWith({
			backupDir: defaultShravanBackupDir,
			cacheDir: './cache',
			runtimeDir: './runtime',
			stateDir: './state/shravan',
			zoneFilesDir: './zone-files/shravan',
			zoneId: 'shravan',
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
		).rejects.toThrow('Usage: agent-vm backup restore <path> [--zone <id>] [--force]');
	});

	it('restores a backup into the target zone files and state directories', async () => {
		const restoreBackup = vi.fn(async () => ({
			stateDir: './state/shravan',
			zoneFilesDir: './zone-files/shravan',
			zoneId: 'shravan',
		}));
		const systemConfig = createBackupSystemConfig();
		const outputs: string[] = [];

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
			restArguments: ['restore', '/tmp/backup.tar.age', '--force', '--zone', 'shravan'],
			systemConfig,
		});

		expect(restoreBackup).toHaveBeenCalledWith({
			backupPath: '/tmp/backup.tar.age',
			stateDir: './state/shravan',
			zoneFilesDir: './zone-files/shravan',
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

	it('refuses restore when the gateway runtime record still identifies a live VM process', async () => {
		const runtimeRecord = createRuntimeRecord(managedProcessIdentity);

		await expect(
			assertRestoreTargetNotLive({
				force: false,
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'loaded',
					path: '/state/shravan/gateway-runtime.json',
					record: runtimeRecord,
				}),
				readProcessIdentity: async () => managedProcessIdentity,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			/Refusing to restore zone 'shravan' while gateway pid 12345 is still running/u,
		);
	});

	it('requires --force when the gateway runtime record is missing', async () => {
		await expect(
			assertRestoreTargetNotLive({
				force: false,
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'missing',
					path: '/state/shravan/gateway-runtime.json',
				}),
				readProcessIdentity: async () => null,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			/Cannot prove zone 'shravan' is stopped before restore because gateway runtime record '\/state\/shravan\/gateway-runtime\.json' is missing/u,
		);

		await expect(
			assertRestoreTargetNotLive({
				force: true,
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'missing',
					path: '/state/shravan/gateway-runtime.json',
				}),
				readProcessIdentity: async () => null,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).resolves.toBeUndefined();
	});

	it('requires --force when the gateway runtime record is malformed', async () => {
		await expect(
			assertRestoreTargetNotLive({
				force: false,
				loadGatewayRuntimeRecordResult: async () => ({
					error: new Error('invalid runtime record'),
					kind: 'parse-error',
					path: '/state/shravan/gateway-runtime.json',
				}),
				readProcessIdentity: async () => null,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(
			/gateway runtime record '\/state\/shravan\/gateway-runtime\.json' is malformed/u,
		);

		await expect(
			assertRestoreTargetNotLive({
				force: true,
				loadGatewayRuntimeRecordResult: async () => ({
					error: new Error('invalid runtime record'),
					kind: 'parse-error',
					path: '/state/shravan/gateway-runtime.json',
				}),
				readProcessIdentity: async () => null,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).resolves.toBeUndefined();
	});

	it('requires --force when a matching runtime record points to a non-managed process', async () => {
		const runtimeRecord = createRuntimeRecord(nonManagedProcessIdentity);

		await expect(
			assertRestoreTargetNotLive({
				force: false,
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'loaded',
					path: '/state/shravan/gateway-runtime.json',
					record: runtimeRecord,
				}),
				readProcessIdentity: async () => nonManagedProcessIdentity,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/the command is not a managed VM process/u);

		await expect(
			assertRestoreTargetNotLive({
				force: true,
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'loaded',
					path: '/state/shravan/gateway-runtime.json',
					record: runtimeRecord,
				}),
				readProcessIdentity: async () => nonManagedProcessIdentity,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).resolves.toBeUndefined();
	});

	it('allows restore when the recorded pid is gone or has a different identity', async () => {
		await expect(
			assertRestoreTargetNotLive({
				force: false,
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'loaded',
					path: '/state/shravan/gateway-runtime.json',
					record: createRuntimeRecord(managedProcessIdentity),
				}),
				readProcessIdentity: async () => null,
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).resolves.toBeUndefined();

		await expect(
			assertRestoreTargetNotLive({
				force: false,
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'loaded',
					path: '/state/shravan/gateway-runtime.json',
					record: createRuntimeRecord(managedProcessIdentity),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-aarch64 -m 2G',
					lstart: 'Thu Jun 11 10:01:00 2026',
				}),
				stateDir: '/state/shravan',
				zoneId: 'shravan',
			}),
		).resolves.toBeUndefined();
	});
});
