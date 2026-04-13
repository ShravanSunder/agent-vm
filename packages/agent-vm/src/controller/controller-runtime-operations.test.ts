import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { createControllerRuntimeOperations } from './controller-runtime-operations.js';

const systemConfig = {
	cacheDir: './cache',
	host: {
		controllerPort: 18800,
		projectNamespace: 'claw-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	images: {
		gateway: { buildConfig: './images/gateway/build-config.json' },
		tool: { buildConfig: './images/tool/build-config.json' },
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
			allowedHosts: ['api.openai.com'],
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

describe('createControllerRuntimeOperations', () => {
	it('returns empty logs when the gateway exec fails', async () => {
		const operations = createControllerRuntimeOperations({
			activeZoneId: 'shravan',
			getGateway: () => ({
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap-openclaw',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/' } as const,
					logPath: '/tmp/openclaw.log',
					startCommand: 'start-openclaw',
				},
				vm: {
					close: async () => {},
					enableSsh: async () => ({}),
					exec: vi.fn(async () => {
						throw new Error('gateway handle is dead');
					}),
				},
			}),
			getZone: () => {
				const zone = systemConfig.zones[0];
				if (!zone) {
					throw new Error('Expected test zone');
				}
				return zone;
			},
			leaseManager: {
				listLeases: () => [],
				releaseLease: async () => {},
			},
			restartGatewayZone: async () => {},
			secretResolver: {
				resolve: async () => '',
				resolveAll: async () => ({}),
			},
			stopGatewayZone: async () => {},
			systemConfig,
		});

		await expect(operations.getZoneLogs('shravan')).resolves.toEqual({
			output: '',
			zoneId: 'shravan',
		});
	});
});
