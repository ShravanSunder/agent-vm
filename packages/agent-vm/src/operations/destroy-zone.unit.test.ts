import fs from 'node:fs';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { runControllerDestroy } from './destroy-zone.js';

const createdDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createDestroySystemConfig(tempDirectory: string, stateDir: string): SystemConfig {
	return {
		schemaVersion: 2,
		storageRootDir: tempDirectory,
		cacheDir: path.join(tempDirectory, 'cache'),
		controllerStateDir: path.join(tempDirectory, 'controller-state'),
		controllerRuntimeDir: path.join(tempDirectory, 'controller-runtime'),
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
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: './vm-images/tool-vms/default/build-config.json',
				},
			},
		},
		zones: [
			{
				id: 'shravan',
				gateway: {
					type: 'hermes',
					imageProfile: 'hermes',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './config/shravan/hermes.json',
					profileSecretProjectionsByAgent: { main: {} },
					profilesByAgent: { main: 'main' },
					stateDir,
					zoneFilesDir: path.join(tempDirectory, 'zone-files', 'shravan'),
					zoneRuntimeDir: path.join(tempDirectory, 'runtime'),
				},
				secrets: {
					TEST_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: 'TEST_GATEWAY_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				egressHosts: [],
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
			},
		],
		toolVmProfiles: {
			standard: { memory: '1G', cpus: 1, imageProfile: 'default' },
		},
		tcpPool: { basePort: 19000, size: 5 },
	};
}

describe('runControllerDestroy', () => {
	it('rejects legacy controller evidence before stop, lease release, or purge', async () => {
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-destroy-legacy-'));
		createdDirectories.push(tempDirectory);
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		fs.mkdirSync(stateDir, { recursive: true });
		const legacyRecordPath = path.join(stateDir, 'gateway-runtime.json');
		fs.writeFileSync(legacyRecordPath, '{}\n');
		const stopGatewayZone = vi.fn(async () => {});
		const releaseZoneLeases = vi.fn(async () => {});
		const systemConfig = createDestroySystemConfig(tempDirectory, stateDir);

		await expect(
			runControllerDestroy(
				{ purge: true, systemConfig, zoneId: 'shravan' },
				{ releaseZoneLeases, stopGatewayZone },
			),
		).rejects.toThrow(
			`Legacy controller record evidence exists under Gateway state for zone 'shravan': gateway-runtime:file:${legacyRecordPath}`,
		);
		expect(stopGatewayZone).not.toHaveBeenCalled();
		expect(releaseZoneLeases).not.toHaveBeenCalled();
		expect(fs.existsSync(stateDir)).toBe(true);
	});

	it('purges Hermes zone files through the same managed framework authority', async () => {
		const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-destroy-hermes-'));
		createdDirectories.push(tempDirectory);
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		const zoneFilesDir = path.join(tempDirectory, 'zone-files', 'shravan');
		await mkdir(stateDir, { recursive: true });
		await mkdir(zoneFilesDir, { recursive: true });
		const baseSystemConfig = createDestroySystemConfig(tempDirectory, stateDir);
		const zone = baseSystemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes fixture zone');
		}
		const systemConfig = {
			...baseSystemConfig,
			zones: [
				{
					...zone,
					gateway: {
						config: './config/shravan/hermes.yaml',
						cpus: zone.gateway.cpus,
						imageProfile: 'hermes',
						memory: zone.gateway.memory,
						port: zone.gateway.port,
						profilesByAgent: { shravan: 'researcher' },
						profileSecretProjectionsByAgent: {
							shravan: {
								API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
								DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
							},
						},
						stateDir: zone.gateway.stateDir,
						type: 'hermes' as const,
						zoneFilesDir,
						zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
					},
					secrets: {
						...zone.secrets,
						API_SERVER_KEY_SHRAVAN: {
							audience: 'gateway',
							envVar: 'API_SERVER_KEY_SHRAVAN',
							injection: 'env',
							source: 'environment',
						},
					},
				},
			],
		} satisfies SystemConfig;

		await runControllerDestroy(
			{ purge: true, systemConfig, zoneId: 'shravan' },
			{
				releaseZoneLeases: async () => {},
				stopGatewayZone: async () => {},
			},
		);

		await expect(access(zoneFilesDir)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('releases zone leases and optionally purges persisted state', async () => {
		const rmSyncSpy = vi.spyOn(fs, 'rmSync');
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-destroy-'));
		createdDirectories.push(tempDirectory);
		const zoneRuntimeDir = path.join(tempDirectory, 'runtime');
		const runtimeLogsDir = path.join(zoneRuntimeDir, 'logs');
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		const zoneFilesDir = path.join(tempDirectory, 'zone-files', 'shravan');
		fs.mkdirSync(runtimeLogsDir, { recursive: true });
		fs.writeFileSync(path.join(runtimeLogsDir, 'hermes-2026-05-10.log'), 'runtime log');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });

		const systemConfig = {
			schemaVersion: 2,
			storageRootDir: tempDirectory,
			cacheDir: './cache',
			controllerStateDir: path.join(tempDirectory, 'controller-state'),
			controllerRuntimeDir: path.join(tempDirectory, 'controller-runtime'),
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
			zones: [
				{
					id: 'shravan',
					gateway: {
						type: 'hermes',
						imageProfile: 'hermes',
						memory: '2G',
						cpus: 2,
						port: 18791,
						config: './config/shravan/hermes.json',
						profileSecretProjectionsByAgent: { main: {} },
						profilesByAgent: { main: 'main' },
						stateDir,
						zoneFilesDir,
						zoneRuntimeDir,
					},
					secrets: {
						TEST_GATEWAY_TOKEN: {
							source: 'environment',
							envVar: 'TEST_GATEWAY_TOKEN',
							injection: 'env',
							audience: 'gateway',
						},
					},
					egressHosts: ['api.anthropic.com'].map((host) => ({
						host,
						audience: 'gateway' as const,
					})),
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
				},
			],
			toolVmProfiles: {
				standard: {
					memory: '1G',
					cpus: 1,
					imageProfile: 'default',
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
		} satisfies SystemConfig;
		const actions: string[] = [];

		const result = await runControllerDestroy(
			{
				purge: true,
				systemConfig,
				zoneId: 'shravan',
			},
			{
				releaseZoneLeases: async (zoneId: string) => {
					actions.push(`leases:${zoneId}`);
				},
				stopGatewayZone: async (zoneId: string) => {
					actions.push(`stop:${zoneId}`);
				},
			},
		);

		expect(actions).toEqual(['stop:shravan', 'leases:shravan']);
		expect(rmSyncSpy).not.toHaveBeenCalledWith(stateDir, expect.anything());
		expect(rmSyncSpy).not.toHaveBeenCalledWith(zoneFilesDir, expect.anything());
		expect(fs.existsSync(stateDir)).toBe(false);
		expect(fs.existsSync(zoneFilesDir)).toBe(false);
		expect(fs.existsSync(runtimeLogsDir)).toBe(false);
		expect(result).toEqual({
			ok: true,
			purged: true,
			zoneId: 'shravan',
		});
	});

	it('purges worker runtime artifacts for the zone', async () => {
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-destroy-worker-'));
		createdDirectories.push(tempDirectory);
		const zoneRuntimeDir = path.join(tempDirectory, 'runtime');
		const workerRuntimeDir = path.join(zoneRuntimeDir, 'worker-tasks');
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		fs.mkdirSync(path.join(workerRuntimeDir, 'task-1', 'gitdirs'), { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });

		const systemConfig = {
			schemaVersion: 2,
			storageRootDir: tempDirectory,
			cacheDir: './cache',
			controllerStateDir: path.join(tempDirectory, 'controller-state'),
			controllerRuntimeDir: path.join(tempDirectory, 'controller-runtime'),
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
					worker: {
						type: 'worker',
						buildConfig: './vm-images/gateways/worker/build-config.json',
					},
				},
				toolVms: {},
			},
			zones: [
				{
					id: 'shravan',
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						memory: '2G',
						cpus: 2,
						port: 18791,
						config: './config/shravan/worker.json',
						stateDir,
						zoneRuntimeDir,
					},
					secrets: {},
					egressHosts: ['github.com'].map((host) => ({ host, audience: 'gateway' as const })),
				},
			],
			toolVmProfiles: {
				standard: {
					memory: '1G',
					cpus: 1,
					imageProfile: 'default',
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
		} satisfies SystemConfig;

		await runControllerDestroy(
			{
				purge: true,
				systemConfig,
				zoneId: 'shravan',
			},
			{
				releaseZoneLeases: async () => {},
				stopGatewayZone: async () => {},
			},
		);

		expect(fs.existsSync(workerRuntimeDir)).toBe(false);
	});
});
