import fs from 'node:fs';
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

describe('runControllerDestroy', () => {
	it('releases zone leases and optionally purges persisted state', async () => {
		const rmSyncSpy = vi.spyOn(fs, 'rmSync');
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-destroy-'));
		createdDirectories.push(tempDirectory);
		const runtimeDir = path.join(tempDirectory, 'runtime');
		const runtimeLogsDir = path.join(runtimeDir, 'zones', 'shravan', 'logs');
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		const zoneFilesDir = path.join(tempDirectory, 'zone-files', 'shravan');
		fs.mkdirSync(runtimeLogsDir, { recursive: true });
		fs.writeFileSync(path.join(runtimeLogsDir, 'openclaw-2026-05-10.log'), 'runtime log');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });

		const systemConfig = {
			schemaVersion: 1,
			cacheDir: './cache',
			runtimeDir,
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
			zones: [
				{
					id: 'shravan',
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						imageProfile: 'openclaw',
						memory: '2G',
						cpus: 2,
						port: 18791,
						config: './config/shravan/openclaw.json',
						stateDir,
						zoneFilesDir,
					},
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: 'environment',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							audience: 'gateway',
						},
					},
					egressHosts: ['api.anthropic.com'].map((host) => ({
						host,
						audience: 'gateway' as const,
					})),
					websocketBypass: [],
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
		const runtimeDir = path.join(tempDirectory, 'runtime');
		const workerRuntimeDir = path.join(runtimeDir, 'worker-tasks', 'shravan');
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		fs.mkdirSync(path.join(workerRuntimeDir, 'task-1', 'gitdirs'), { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });

		const systemConfig = {
			schemaVersion: 1,
			cacheDir: './cache',
			runtimeDir,
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
					},
					secrets: {},
					egressHosts: ['github.com'].map((host) => ({ host, audience: 'gateway' as const })),
					websocketBypass: [],
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
