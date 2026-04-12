import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { runControllerDestroy } from './destroy-zone.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

describe('runControllerDestroy', () => {
	it('releases zone leases and optionally purges persisted state', async () => {
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-destroy-'));
		createdDirectories.push(tempDirectory);
		const stateDir = path.join(tempDirectory, 'state', 'shravan');
		const workspaceDir = path.join(tempDirectory, 'workspaces', 'shravan');
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(workspaceDir, { recursive: true });

		const systemConfig = {
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
			zones: [
				{
					id: 'shravan',
					gateway: {
						type: 'openclaw',
						memory: '2G',
						cpus: 2,
						port: 18791,
						openclawConfig: './config/shravan/openclaw.json',
						stateDir,
						workspaceDir,
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
		expect(fs.existsSync(stateDir)).toBe(false);
		expect(fs.existsSync(workspaceDir)).toBe(false);
		expect(result).toEqual({
			ok: true,
			purged: true,
			zoneId: 'shravan',
		});
	});
});
