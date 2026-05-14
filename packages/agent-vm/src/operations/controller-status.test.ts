import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { buildControllerStatus, buildControllerZoneStatus } from './controller-status.js';

const systemConfig = {
	schemaVersion: 1,
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
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
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
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'worker-zone',
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				memory: '2G',
				cpus: 2,
				port: 18793,
				config: './config/worker/worker.json',
				stateDir: './state/worker',
			},
			secrets: {},
			allowedHosts: ['api.anthropic.com'],
			websocketBypass: [],
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

describe('buildControllerStatus', () => {
	it('summarizes zones, tool VM profiles, and controller port', () => {
		expect(buildControllerStatus(systemConfig)).toEqual({
			controllerPort: 18800,
			toolVmProfiles: ['standard'],
			zones: [
				{
					activeLeaseCount: 0,
					gatewayType: 'openclaw',
					id: 'shravan',
					ingressPort: 18791,
					lifecycleState: 'stopped',
					running: false,
					defaultToolVmProfile: 'standard',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'openclaw',
					id: 'alevtina',
					ingressPort: 18792,
					lifecycleState: 'stopped',
					running: false,
					defaultToolVmProfile: 'standard',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'worker',
					id: 'worker-zone',
					ingressPort: 18793,
					lifecycleState: 'stopped',
					running: false,
				},
			],
		});
	});

	it('summarizes multiple zone lifecycle states from runtime snapshots', () => {
		expect(
			buildControllerStatus(systemConfig, {
				activeLeases: [{ zoneId: 'shravan' }, { zoneId: 'shravan' }, { zoneId: 'alevtina' }],
				zones: {
					shravan: {
						bootedAt: '2026-04-30T10:00:00.000Z',
						lifecycleState: 'running',
						gateway: {
							ingress: {
								host: '127.0.0.1',
								port: 18791,
							},
							vm: {
								id: 'vm-shravan',
							},
						},
					},
					alevtina: {
						lastError: 'gateway boot failed',
						lifecycleState: 'failed',
					},
					'worker-zone': {
						lifecycleState: 'stopped',
					},
				},
			}),
		).toEqual({
			controllerPort: 18800,
			toolVmProfiles: ['standard'],
			zones: [
				{
					activeLeaseCount: 2,
					bootedAt: '2026-04-30T10:00:00.000Z',
					gatewayType: 'openclaw',
					id: 'shravan',
					ingressHost: '127.0.0.1',
					ingressPort: 18791,
					lifecycleState: 'running',
					running: true,
					defaultToolVmProfile: 'standard',
					vmId: 'vm-shravan',
				},
				{
					activeLeaseCount: 1,
					gatewayType: 'openclaw',
					id: 'alevtina',
					ingressPort: 18792,
					lastError: 'gateway boot failed',
					lifecycleState: 'failed',
					running: false,
					defaultToolVmProfile: 'standard',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'worker',
					id: 'worker-zone',
					ingressPort: 18793,
					lifecycleState: 'stopped',
					running: false,
				},
			],
		});
	});

	it('returns one zone status from the same per-zone runtime snapshot', () => {
		const zoneStatus = buildControllerZoneStatus(systemConfig, 'alevtina', {
			zones: {
				alevtina: {
					lastError: 'gateway boot failed',
					lifecycleState: 'failed',
				},
			},
		});

		expect(zoneStatus).toMatchObject({
			id: 'alevtina',
			lastError: 'gateway boot failed',
			lifecycleState: 'failed',
			running: false,
		});
	});
});
