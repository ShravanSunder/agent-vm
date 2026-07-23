import type { ManagedVm } from '@agent-vm/managed-vm';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayZoneVmOperations,
	mapSystemGatewayZoneToLifecycleZone,
	type GatewayZone,
} from './gateway-zone-support.js';

function createGatewayZone(ingress?: GatewayZone['gateway']['ingress']): GatewayZone {
	return {
		id: 'shravan',
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
			config: './gateways/shravan/openclaw.json',
			...(ingress === undefined ? {} : { ingress }),
			stateDir: './state/shravan',
			zoneFilesDir: './zone-files/shravan',
			zoneRuntimeDir: './shravan/runtime',
		},
		secrets: {},
		egressHosts: [],
		defaultToolVmProfile: 'standard',
		agentToolVmProfiles: {},
		websocketUpgrades: [],
	};
}

describe('mapSystemGatewayZoneToLifecycleZone', () => {
	it('omits ingress when no gateway ingress timeouts are configured', () => {
		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(createGatewayZone());

		expect(lifecycleZone.gateway).not.toHaveProperty('ingress');
	});

	it('preserves only configured gateway ingress timeout fields', () => {
		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(
			createGatewayZone({ upstreamResponseTimeoutMs: 120_000 }),
		);

		expect(lifecycleZone.gateway).toMatchObject({
			ingress: { upstreamResponseTimeoutMs: 120_000 },
		});
		expect(lifecycleZone.gateway.ingress).not.toHaveProperty('upstreamHeaderTimeoutMs');
	});

	it('preserves websocket upgrade URL policy', () => {
		const websocketUpgrades = [
			{
				audience: 'gateway' as const,
				scheme: 'wss' as const,
				host: 'gateway.discord.gg',
				port: 443,
				path: '/',
			},
		];

		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone({
			...createGatewayZone(),
			websocketUpgrades,
		});

		expect(lifecycleZone.websocketUpgrades).toEqual(websocketUpgrades);
	});

	it('maps strict Hermes profile assignments and zone files without casts', () => {
		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone({
			...createGatewayZone(),
			agents: [{ id: 'researcher' }, { id: 'reviewer' }],
			gateway: {
				type: 'hermes',
				imageProfile: 'hermes',
				memory: '4G',
				cpus: 2,
				port: 8642,
				config: './gateways/hermes/config.yaml',
				stateDir: './state/hermes',
				zoneFilesDir: './zone-files/hermes',
				zoneRuntimeDir: './hermes/runtime',
				profilesByAgent: {
					researcher: 'research-profile',
					reviewer: 'review-profile',
				},
			},
		} satisfies GatewayZone);

		expect(lifecycleZone.gateway).toEqual({
			type: 'hermes',
			memory: '4G',
			cpus: 2,
			port: 8642,
			config: './gateways/hermes/config.yaml',
			stateDir: './state/hermes',
			ssh: { secretEnv: 'explicit' },
			zoneFilesDir: './zone-files/hermes',
			profilesByAgent: {
				researcher: 'research-profile',
				reviewer: 'review-profile',
			},
		});
	});

	it('maps fixed OpenClaw, Hermes, and Tool Portal telemetry contracts', () => {
		const zone = {
			...createGatewayZone(),
			observability: {
				enabled: true,
				openclaw: {
					diagnosticsFlags: ['scheduler.debug'],
				},
				services: {
					framework: {
						traces: true,
						metrics: true,
						logs: true,
						sampleRate: 0.5,
						flushIntervalMs: 5_000,
					},
					toolPortal: {
						traces: true,
						metrics: true,
						logs: true,
						sampleRate: 1,
						flushIntervalMs: 10_000,
					},
				},
			},
		} satisfies GatewayZone;

		const hostObservability = {
			enabled: true,
			stack: {
				mode: 'managed',
				scrubbing: { responsibility: 'agent-vm-managed-collector' },
			},
			runner: 'docker-compose',
			mode: 'collector',
			dataDir: '/host/observability',
			bindAddress: '127.0.0.1',
			prepareOnBuild: true,
			waitOnBuild: true,
			startupCheckTimeoutMs: 500,
			controllerStartPolicy: 'degraded',
			ports: {
				collectorGrpc: 24_317,
				collectorHttp: 24_318,
				collectorHealth: 13_133,
				metrics: 8428,
				logs: 9428,
				traces: 10_428,
			},
			retention: {
				metrics: { period: '30d' },
				logs: { period: '14d' },
				traces: { period: '7d' },
			},
		} as const;
		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone, { hostObservability });

		expect(lifecycleZone.observability).toEqual({
			mode: 'collector',
			collector: {
				host: 'otel-collector.observability.vm.host',
				grpcPort: 4317,
				httpPort: 4318,
				targetHost: '127.0.0.1',
				targetGrpcPort: 24_317,
				targetHttpPort: 24_318,
			},
			framework: {
				admissionLimits: {
					maxExportBatchRecords: 64,
					maxQueuedRecordsPerSignal: 256,
					maxRecordBytes: 65_536,
				},
				flushIntervalMs: 5_000,
				logs: true,
				metrics: true,
				sampleRate: 0.5,
				serviceName: 'agent-vm-openclaw',
				sourcePolicy: { admitBaggage: false, captureContent: false },
				traces: true,
			},
			openclaw: {
				diagnosticsFlags: ['scheduler.debug'],
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
		});
		if (!lifecycleZone.observability) {
			throw new Error('Expected lifecycle observability config.');
		}
		expect(
			lifecycleZone.observability.framework.admissionLimits.maxExportBatchRecords,
		).toBeLessThanOrEqual(
			lifecycleZone.observability.framework.admissionLimits.maxQueuedRecordsPerSignal,
		);
		expect(lifecycleZone.observability.framework.admissionLimits).not.toBe(
			lifecycleZone.observability.toolPortal.admissionLimits,
		);
		expect(lifecycleZone.observability.framework.sourcePolicy).not.toBe(
			lifecycleZone.observability.toolPortal.sourcePolicy,
		);

		const hermesLifecycleZone = mapSystemGatewayZoneToLifecycleZone(
			{
				...zone,
				gateway: {
					type: 'hermes',
					imageProfile: 'hermes',
					memory: '4G',
					cpus: 2,
					port: 8642,
					config: './gateways/hermes/config.yaml',
					stateDir: './state/hermes',
					zoneFilesDir: './zone-files/hermes',
					zoneRuntimeDir: './hermes/runtime',
					profilesByAgent: { researcher: 'research-profile' },
				},
				observability: {
					enabled: true,
					services: {
						framework: {
							traces: true,
							metrics: true,
							logs: true,
							sampleRate: 1,
							flushIntervalMs: 10_000,
						},
						toolPortal: {
							traces: true,
							metrics: true,
							logs: true,
							sampleRate: 1,
							flushIntervalMs: 10_000,
						},
					},
				},
			},
			{ hostObservability },
		);
		expect(hermesLifecycleZone.observability?.framework.serviceName).toBe('agent-vm-hermes');
		expect(hermesLifecycleZone.observability?.toolPortal.serviceName).toBe('agent-vm-tool-portal');
	});
});

describe('createGatewayZoneVmOperations', () => {
	it('exposes required runtime operations without VM destruction authority', async () => {
		const enableSsh = vi.fn<ManagedVm['enableSsh']>(async () => ({
			close: async () => {},
			command: 'ssh sandbox@127.0.0.1',
			host: '127.0.0.1',
			identityFile: '/tmp/test-identity',
			port: 2200,
			serverHostKey: { algorithm: 'ssh-ed25519', publicKeyBase64: 'test-host-key' },
			user: 'sandbox',
		}));
		const managedVm = {
			close: vi.fn(async () => {}),
			configureIngressRoutes: vi.fn(),
			enableIngress: vi.fn(async () => ({
				close: async () => {},
				host: '127.0.0.1',
				port: 18_791,
			})),
			enableSsh,
			exec: vi.fn<ManagedVm['exec']>(() => {
				throw new Error('exec is not exercised by this contract test');
			}),
			getHostProcessId: vi.fn(() => 12_345),
			id: 'gateway-vm-test',
			start: vi.fn(async () => {}),
		} satisfies ManagedVm;

		const gatewayVm = createGatewayZoneVmOperations(managedVm);
		const sshAccess = await gatewayVm.enableSsh({ user: 'sandbox' });

		expect(gatewayVm).toMatchObject({ id: 'gateway-vm-test' });
		expect(gatewayVm.getHostProcessId()).toBe(12_345);
		expect(sshAccess.port).toBe(2200);
		expect(enableSsh).toHaveBeenCalledWith({ user: 'sandbox' });
		expect(gatewayVm).not.toHaveProperty('close');
		expect(gatewayVm).not.toHaveProperty('configureIngressRoutes');
		expect(gatewayVm).not.toHaveProperty('enableIngress');
		expect(gatewayVm).not.toHaveProperty('start');
	});
});
