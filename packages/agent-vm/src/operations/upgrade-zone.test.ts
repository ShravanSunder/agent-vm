import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { runControllerUpgrade } from './upgrade-zone.js';

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
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
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
			},
		);

		expect(actions).toEqual(['rebuild:shravan', 'restart:shravan']);
		expect(result).toEqual({
			ok: true,
			zoneId: 'shravan',
		});
	});
});
