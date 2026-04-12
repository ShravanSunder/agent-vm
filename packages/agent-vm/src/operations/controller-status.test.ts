import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { buildControllerStatus } from './controller-status.js';

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

describe('buildControllerStatus', () => {
	it('summarizes zones, tool profiles, and controller port', () => {
		expect(buildControllerStatus(systemConfig)).toEqual({
			controllerPort: 18800,
			toolProfiles: ['standard'],
			zones: [
				{
					id: 'shravan',
					ingressPort: 18791,
					toolProfile: 'standard',
				},
			],
		});
	});
});
