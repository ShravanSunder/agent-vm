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
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: { type: 'worker', buildConfig: './vm-images/gateways/worker/build-config.json' },
		},
		toolVms: {
			default: { type: 'toolVm', buildConfig: './vm-images/tool-vms/default/build-config.json' },
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
			imageProfile: 'default',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

describe('createControllerRuntimeOperations', () => {
	it('propagates gateway log read failures', async () => {
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

		await expect(operations.getZoneLogs('shravan')).rejects.toThrow('gateway handle is dead');
	});
});
