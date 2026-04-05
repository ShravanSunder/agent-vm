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
				diskFreeBytes: 50 * 1024 * 1024 * 1024,
				env: {
					OP_SERVICE_ACCOUNT_TOKEN: 'token',
				},
				occupiedPorts: new Set<number>(),
				nodeVersion: 'v25.9.0',
				totalMemoryBytes: 16 * 1024 * 1024 * 1024,
				systemConfig,
			}),
		).toEqual({
			ok: true,
			checks: [
				{ name: 'node-version', ok: true },
				{ name: '1password-token', ok: true },
				{ name: 'controller-port', ok: true, value: 18800 },
				{ name: 'gateway-port-shravan', ok: true, value: 18791 },
				{ name: 'disk-space', ok: true },
				{ name: 'memory-budget', ok: true },
			],
		});
	});

	it('flags occupied ports and insufficient resources', () => {
		expect(
			runControllerDoctor({
				diskFreeBytes: 1,
				env: {},
				occupiedPorts: new Set<number>([18800, 18791]),
				nodeVersion: 'v20.0.0',
				totalMemoryBytes: 512 * 1024 * 1024,
				systemConfig,
			}),
		).toEqual({
			ok: false,
			checks: [
				{ name: 'node-version', ok: false },
				{ name: '1password-token', ok: false },
				{ name: 'controller-port', ok: false, value: 18800 },
				{ name: 'gateway-port-shravan', ok: false, value: 18791 },
				{ name: 'disk-space', ok: false },
				{ name: 'memory-budget', ok: false },
			],
		});
	});
});
