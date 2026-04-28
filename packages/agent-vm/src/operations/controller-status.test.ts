import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { buildControllerStatus } from './controller-status.js';

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
		{
			id: 'alevtina',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './config/alevtina/openclaw.json',
				stateDir: './state/alevtina',
				zoneFilesDir: './zone-files/alevtina',
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

describe('buildControllerStatus', () => {
	it('summarizes zones, tool profiles, and controller port', () => {
		expect(buildControllerStatus(systemConfig)).toEqual({
			controllerPort: 18800,
			toolProfiles: ['standard'],
			zones: [
				{
					activeLeaseCount: 0,
					gatewayType: 'openclaw',
					id: 'shravan',
					ingressPort: 18791,
					running: false,
					toolProfile: 'standard',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'openclaw',
					id: 'alevtina',
					ingressPort: 18792,
					running: false,
					toolProfile: 'standard',
				},
			],
		});
	});

	it('marks the active runtime zone as running with live runtime details', () => {
		expect(
			buildControllerStatus(systemConfig, {
				activeLeases: [{ zoneId: 'shravan' }, { zoneId: 'other-zone' }],
				activeZoneId: 'shravan',
				bootedAt: '2026-04-27T10:00:00.000Z',
				gateway: {
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					vm: {
						id: 'gateway-vm-1',
					},
				},
			}),
		).toEqual({
			controllerPort: 18800,
			toolProfiles: ['standard'],
			zones: [
				{
					activeLeaseCount: 1,
					bootedAt: '2026-04-27T10:00:00.000Z',
					gatewayType: 'openclaw',
					id: 'shravan',
					ingressHost: '127.0.0.1',
					ingressPort: 18791,
					running: true,
					toolProfile: 'standard',
					vmId: 'gateway-vm-1',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'openclaw',
					id: 'alevtina',
					ingressPort: 18792,
					running: false,
					toolProfile: 'standard',
				},
			],
		});
	});
});
