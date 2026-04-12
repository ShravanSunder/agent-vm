import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { runControllerUpgrade } from './upgrade-zone.js';

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
				gatewayConfig: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
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

describe('runControllerUpgrade', () => {
	it('rebuilds the gateway image and restarts the zone', async () => {
		const actions: string[] = [];

		const result = await runControllerUpgrade(
			{
				systemConfig,
				zoneId: 'shravan',
			},
			{
				rebuildGatewayImage: async (zoneId: string) => {
					actions.push(`rebuild:${zoneId}`);
				},
				restartGatewayZone: async (zoneId: string) => {
					actions.push(`restart:${zoneId}`);
				},
				stopGatewayZone: async (zoneId: string) => {
					actions.push(`stop:${zoneId}`);
				},
			},
		);

		expect(actions).toEqual(['rebuild:shravan', 'stop:shravan', 'restart:shravan']);
		expect(result).toEqual({
			ok: true,
			zoneId: 'shravan',
		});
	});
});
