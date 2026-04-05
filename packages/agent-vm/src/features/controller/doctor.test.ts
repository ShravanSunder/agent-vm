import { describe, expect, it } from 'vitest';

import { runControllerDoctor } from './doctor.js';
import type { SystemConfig } from './system-config.js';

const systemConfig = {
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			serviceAccountTokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN',
		},
	},
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
			postBuild: [],
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
			postBuild: [],
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				memory: '2G',
				cpus: 2,
				port: 18791,
				openclawConfig: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
			},
			secrets: {},
			allowedHosts: ['api.anthropic.com'],
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

describe('runControllerDoctor', () => {
	it('reports healthy basics for node version and 1password token presence', () => {
		expect(
			runControllerDoctor({
				env: {
					OP_SERVICE_ACCOUNT_TOKEN: 'token',
				},
				nodeVersion: 'v25.9.0',
				systemConfig,
			}),
		).toEqual({
			ok: true,
			checks: [
				{ name: 'node-version', ok: true },
				{ name: '1password-token', ok: true },
				{ name: 'controller-port', ok: true, value: 18800 },
			],
		});
	});
});
