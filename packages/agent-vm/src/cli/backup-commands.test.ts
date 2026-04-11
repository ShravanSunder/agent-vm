import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runBackupCommand } from './backup-commands.js';

function createBackupSystemConfig(): SystemConfig {
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
				toolProfile: 'standard',
				websocketBypass: [],
			},
		],
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
				buildControllerStatus: () => ({ controllerPort: 18800, toolProfiles: [], zones: [] }),
				createAgeBackupEncryption: () => ({ decrypt: async () => {}, encrypt: async () => {} }),
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
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
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
				}),
				loadSystemConfig: () => systemConfig,
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
			backupDir: './state/shravan/backups',
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
				buildControllerStatus: () => ({ controllerPort: 18800, toolProfiles: [], zones: [] }),
				createAgeBackupEncryption: (dependencies) => {
					void dependencies.resolveIdentity();
					return { decrypt: async () => {}, encrypt: async () => {} };
				},
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				createSecretResolver: async () => ({
					resolve: async (secretRef: { ref: string }) => {
						expect(secretRef.ref).toBe('op://agent-vm/agent-shravan-backup/password');
						return 'backup-key';
					},
					resolveAll: async () => ({}),
				}),
				createZoneBackupManager: () => ({
					createBackup,
					listBackups: () => [],
					restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
				}),
				loadSystemConfig: () => systemConfig,
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
			backupDir: './state/shravan/backups',
			stateDir: './state/shravan',
			workspaceDir: './workspaces/shravan',
			zoneId: 'shravan',
		});
	});

	it('throws when restore is missing a backup path', async () => {
		const systemConfig = createBackupSystemConfig();

		await expect(
			runBackupCommand({
				dependencies: {
					...defaultCliDependencies,
					buildControllerStatus: () => ({ controllerPort: 18800, toolProfiles: [], zones: [] }),
					createAgeBackupEncryption: () => ({ decrypt: async () => {}, encrypt: async () => {} }),
					createControllerClient: () => ({
						destroyZone: async () => ({}),
						enableZoneSsh: async () => ({}),
						getControllerStatus: async () => ({}),
						getZoneLogs: async () => ({}),
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
						restoreBackup: async () => ({ stateDir: '', workspaceDir: '', zoneId: '' }),
					}),
					loadSystemConfig: () => systemConfig,
					resolveServiceAccountToken: async () => 'token',
					runControllerDoctor: () => ({ checks: [], ok: true }),
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				restArguments: ['restore'],
				systemConfig,
			}),
		).rejects.toThrow('Usage: agent-vm backup restore <path> [--zone <id>]');
	});
});
