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
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		const zoneFilesDir = path.join(tempDirectory, 'zone-files', 'shravan');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(zoneFilesDir, { recursive: true });

		const systemConfig = {
			cacheDir: './cache',
			runtimeDir: './runtime',
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
						imageProfile: 'openclaw',
						memory: '2G',
						cpus: 2,
						port: 18791,
						config: './config/shravan/openclaw.json',
						stateDir,
						zoneFilesDir,
					},
					secrets: {},
					allowedHosts: ['api.anthropic.com'],
					websocketBypass: [],
					toolProfile: 'standard',
				},
			],
			toolProfiles: {
				standard: {
					memory: '1G',
					cpus: 1,
					workspaceRoot: './workspaces/tools',
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
		expect(result).toEqual({
			ok: true,
			purged: true,
			zoneId: 'shravan',
		});
	});
});
