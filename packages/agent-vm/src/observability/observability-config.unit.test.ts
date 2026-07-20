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
				stack: {
					mode: 'managed',
					scrubbing: { responsibility: 'agent-vm-managed-collector' },
				},
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
		controllerStateDir: '/controller-state-test',
		runtimeDir: '/tmp/agent-vm-runtime',
		imageProfiles: {
			gateways: {
				hermes: {
					type: 'hermes',
					buildConfig: '/tmp/hermes/build-config.json',
				},
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
				agents: [{ id: 'main' }],
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
					services: { framework: {}, toolPortal: {} },
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

function createConfigWithoutZoneObservability(): SystemConfigInput {
	const configInput = createConfig();
	const firstZone = configInput.zones[0];
	if (!firstZone) {
		throw new Error('Expected test zone.');
	}
	delete firstZone.observability;
	return configInput;
}

describe('createObservabilityRuntimeConfig', () => {
	test('fixes common producer service identities for an OpenClaw zone', () => {
		const loadedConfig = createLoadedSystemConfig(createConfig(), {
			systemConfigPath: '/tmp/config/system.json',
		});

		const runtimeConfig = createObservabilityRuntimeConfig(loadedConfig);

		if (!runtimeConfig.enabled) {
			throw new Error('Expected observability runtime config to be enabled.');
		}
		expect(runtimeConfig.zones).toEqual([
			{
				framework: {
					admissionLimits: {
						maxExportBatchRecords: 64,
						maxQueuedRecordsPerSignal: 256,
						maxRecordBytes: 65_536,
					},
					flushIntervalMs: 10_000,
					logs: true,
					metrics: true,
					sampleRate: 1,
					serviceName: 'agent-vm-openclaw',
					sourcePolicy: { admitBaggage: false, captureContent: false },
					traces: true,
				},
				toolPortal: {
					admissionLimits: {
						maxExportBatchRecords: 64,
						maxQueuedRecordsPerSignal: 256,
						maxRecordBytes: 65_536,
					},
					flushIntervalMs: 10_000,
					logs: true,
					metrics: true,
					sampleRate: 1,
					serviceName: 'agent-vm-tool-portal',
					sourcePolicy: { admitBaggage: false, captureContent: false },
					traces: true,
				},
				zoneId: 'sunfam',
			},
		]);
		const [zoneRuntimeConfig] = runtimeConfig.zones;
		if (!zoneRuntimeConfig) {
			throw new Error('Expected one observability zone runtime config.');
		}
		expect(zoneRuntimeConfig.framework.admissionLimits).not.toBe(
			zoneRuntimeConfig.toolPortal.admissionLimits,
		);
		expect(zoneRuntimeConfig.framework.sourcePolicy).not.toBe(
			zoneRuntimeConfig.toolPortal.sourcePolicy,
		);
	});

	test('fixes the Hermes framework identity independently from Tool Portal', () => {
		const configInput = createConfig();
		const firstZone = configInput.zones[0];
		if (!firstZone) {
			throw new Error('Expected test zone.');
		}
		firstZone.gateway = {
			type: 'hermes',
			imageProfile: 'hermes',
			memory: '2G',
			cpus: 2,
			port: 8642,
			config: '/tmp/hermes/config.yaml',
			stateDir: '/tmp/state/hermes',
			zoneFilesDir: '/tmp/zone-files/hermes',
			profilesByAgent: { main: 'main-profile' },
		};
		const loadedConfig = createLoadedSystemConfig(configInput, {
			systemConfigPath: '/tmp/config/system.json',
		});

		const runtimeConfig = createObservabilityRuntimeConfig(loadedConfig);

		if (!runtimeConfig.enabled) {
			throw new Error('Expected observability runtime config to be enabled.');
		}
		expect(runtimeConfig.zones[0]?.framework.serviceName).toBe('agent-vm-hermes');
		expect(runtimeConfig.zones[0]?.toolPortal.serviceName).toBe('agent-vm-tool-portal');
	});

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

	test('normalizes host observability paths without raw-tcp OpenClaw zone telemetry', () => {
		const loadedConfig = createLoadedSystemConfig(createConfigWithoutZoneObservability(), {
			systemConfigPath: '/tmp/config/system.json',
		});

		expect(createObservabilityRuntimeConfig(loadedConfig)).toEqual({
			enabled: true,
			stackMode: 'managed',
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
			startupCheckTimeoutMs: 30_000,
			zones: [],
		});
	});

	test('normalizes external observability without managed stack storage', () => {
		const configInput = createConfigWithoutZoneObservability();
		configInput.host.observability = {
			enabled: true,
			stack: {
				mode: 'external',
				scrubbing: { responsibility: 'external-collector' },
			},
			mode: 'collector',
		};
		const loadedConfig = createLoadedSystemConfig(configInput, {
			systemConfigPath: '/tmp/config/system.json',
		});

		const runtimeConfig = createObservabilityRuntimeConfig(loadedConfig);

		expect(runtimeConfig).toEqual({
			enabled: true,
			stackMode: 'external',
			runtimeDir: '/tmp/agent-vm-runtime/observability/observability-test',
			bindAddress: '127.0.0.1',
			ports: {
				collectorGrpc: 4317,
				collectorHttp: 4318,
				collectorHealth: 13_133,
				metrics: 8428,
				logs: 9428,
				traces: 10_428,
			},
			prepareOnBuild: true,
			waitOnBuild: true,
			controllerStartPolicy: 'degraded',
			startupCheckTimeoutMs: 30_000,
			zones: [],
		});
		expect('dataDir' in runtimeConfig).toBe(false);
		expect('retention' in runtimeConfig).toBe(false);
	});
});
