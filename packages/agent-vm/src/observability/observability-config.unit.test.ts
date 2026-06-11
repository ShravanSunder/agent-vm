import { describe, expect, test } from 'vitest';

import { createLoadedSystemConfig, type SystemConfigInput } from '../config/system-config.js';
import { createObservabilityRuntimeConfig } from './observability-config.js';

function createConfig(): SystemConfigInput {
	return {
		host: {
			controllerPort: 18800,
			projectNamespace: 'observability-test',
			observability: {
				enabled: true,
				stack: 'victoria',
				runner: 'docker-compose',
				mode: 'collector',
				dataDir: '/tmp/agent-vm-observability',
				retention: {
					metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
					logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
					traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
				},
			},
		},
		cacheDir: '/tmp/agent-vm-cache',
		runtimeDir: '/tmp/agent-vm-runtime',
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '/tmp/openclaw/build-config.json',
					source: {
						kind: 'managedBase',
						base: 'openclaw-gateway',
					},
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '/tmp/tool-vm/build-config.json',
				},
			},
		},
		zones: [
			{
				id: 'sunfam',
				gateway: {
					type: 'openclaw',
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					imageProfile: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: '/tmp/openclaw.json',
					stateDir: '/tmp/state/sunfam',
					zoneFilesDir: '/tmp/zone-files/sunfam',
				},
				observability: {
					enabled: true,
					openclaw: {
						serviceName: 'agent-vm-openclaw-sunfam',
						traces: true,
						metrics: true,
						logs: true,
					},
				},
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				egressHosts: [{ host: 'example.com', audience: 'gateway' }],
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
		tcpPool: { basePort: 19000, size: 5 },
	};
}

describe('createObservabilityRuntimeConfig', () => {
	test('returns disabled when host observability is not enabled', () => {
		const configInput = createConfig();
		const firstZone = configInput.zones[0];
		if (!firstZone) {
			throw new Error('Expected test zone.');
		}
		delete configInput.host.observability;
		delete firstZone.observability;
		const loadedConfig = createLoadedSystemConfig(configInput, {
			systemConfigPath: '/tmp/config/system.json',
		});

		expect(createObservabilityRuntimeConfig(loadedConfig)).toEqual({ enabled: false });
	});

	test('normalizes host observability paths and supported OpenClaw zones', () => {
		const loadedConfig = createLoadedSystemConfig(createConfig(), {
			systemConfigPath: '/tmp/config/system.json',
		});

		expect(createObservabilityRuntimeConfig(loadedConfig)).toEqual({
			enabled: true,
			projectName: 'agent-vm-observability-observability-test',
			runtimeDir: '/tmp/agent-vm-runtime/observability/observability-test',
			dataDir: '/tmp/agent-vm-observability',
			bindAddress: '127.0.0.1',
			ports: {
				collectorGrpc: 4317,
				collectorHttp: 4318,
				collectorHealth: 13_133,
				metrics: 8428,
				logs: 9428,
				traces: 10_428,
			},
			retention: {
				metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
				logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
				traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
			},
			prepareOnBuild: true,
			waitOnBuild: true,
			controllerStartPolicy: 'degraded',
			startupCheckTimeoutMs: 500,
			zones: [
				{
					zoneId: 'sunfam',
					serviceName: 'agent-vm-openclaw-sunfam',
					traces: true,
					metrics: true,
					logs: true,
					sampleRate: 1,
					flushIntervalMs: 10_000,
					diagnosticsFlags: [],
				},
			],
		});
	});
});
