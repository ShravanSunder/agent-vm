import { describe, expect, it } from 'vitest';

import { mapSystemGatewayZoneToLifecycleZone, type GatewayZone } from './gateway-zone-support.js';

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

	it('maps OpenClaw observability to collector runtime endpoints', () => {
		const zone = {
			...createGatewayZone(),
			observability: {
				enabled: true,
				openclaw: {
					serviceName: 'agent-vm-openclaw-shravan',
					traces: true,
					metrics: true,
					logs: true,
					sampleRate: 0.5,
					flushIntervalMs: 5_000,
					captureContent: { enabled: false },
					diagnosticsFlags: ['scheduler.debug'],
				},
			},
		} satisfies GatewayZone;

		const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone, {
			hostObservability: {
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
			},
		});

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
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
				traces: true,
				metrics: true,
				logs: true,
				sampleRate: 0.5,
				flushIntervalMs: 5_000,
				diagnosticsFlags: ['scheduler.debug'],
			},
		});
	});
});
