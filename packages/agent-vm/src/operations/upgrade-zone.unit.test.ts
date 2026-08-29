import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { runControllerUpgrade } from './upgrade-zone.js';

const systemConfig = {
	schemaVersion: 2,
	storageRootDir: './storage',
	cacheDir: './cache',
	controllerStateDir: '/controller-state-test',
	controllerRuntimeDir: './controller-runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'agent-vm-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	imageProfiles: {
		gateways: {
			hermes: {
				type: 'hermes',
				buildConfig: './vm-images/gateways/hermes/build-config.json',
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
				type: 'hermes',
				profileSecretProjectionsByAgent: { main: {} },
				profilesByAgent: { main: 'main' },
				imageProfile: 'hermes',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/hermes.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
				zoneRuntimeDir: './runtime/shravan',
			},
			secrets: {
				TEST_GATEWAY_SECRET: {
					source: 'environment',
					envVar: 'TEST_GATEWAY_SECRET',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
