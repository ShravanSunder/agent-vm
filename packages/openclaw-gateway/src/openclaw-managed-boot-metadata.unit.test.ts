import {
	createGatewayTelemetryProducerSafetyContract,
	gatewayFrameworkTelemetryServiceNames,
	gatewayToolPortalTelemetryServiceName,
	type GatewayZoneConfig,
} from '@agent-vm/gateway-lifecycle';
import { describe, expect, it } from 'vitest';

import {
	buildOpenClawFrameworkServiceBootMetadata,
	openclawLifecycle,
} from './openclaw-lifecycle.js';

function createOpenClawZone(): GatewayZoneConfig {
	return {
		agents: [{ id: 'main' }, { id: 'research' }],
		defaultToolVmProfile: 'standard',
		egressHosts: [],
		gateway: {
			config: '/host/config/openclaw.json',
			controlAuth: { mode: 'token', secret: 'OPENCLAW_GATEWAY_TOKEN' },
			cpus: 2,
			memory: '2G',
			port: 18791,
			ssh: { secretEnv: 'explicit' },
			stateDir: '/host/state/openclaw',
			type: 'openclaw',
			zoneFilesDir: '/host/zone-files/openclaw',
		},
		id: 'openclaw-zone',
		observability: {
			collector: {
				grpcPort: 4317,
				host: 'otel-collector.observability.vm.host',
				httpPort: 4318,
				targetGrpcPort: 24_317,
				targetHost: '127.0.0.1',
				targetHttpPort: 24_318,
			},
			mode: 'collector',
			framework: {
				...createGatewayTelemetryProducerSafetyContract(),
				flushIntervalMs: 10_000,
				logs: true,
				metrics: true,
				sampleRate: 1,
				serviceName: gatewayFrameworkTelemetryServiceNames.openclaw,
				traces: true,
			},
			openclaw: {
				diagnosticsFlags: [],
			},
			toolPortal: {
				...createGatewayTelemetryProducerSafetyContract(),
				flushIntervalMs: 10_000,
				logs: true,
				metrics: true,
				sampleRate: 1,
				serviceName: gatewayToolPortalTelemetryServiceName,
				traces: true,
			},
		},
		secrets: {},
		websocketUpgrades: [],
	};
}

describe('OpenClaw managed boot metadata', () => {
	it('uses the managed lifecycle without direct process launch authority', () => {
		// Assert
		expect(openclawLifecycle.executionModel).toBe('managed-gateway');
		expect(openclawLifecycle).not.toHaveProperty('buildProcessSpec');
		expect(openclawLifecycle.buildFrameworkServiceBootInputs).toBeTypeOf('function');
	});

	it('describes only immutable image, input, ingress, log, and readiness identities', () => {
		// Act
		const metadata = buildOpenClawFrameworkServiceBootMetadata(createOpenClawZone());

		// Assert
		expect(metadata).toEqual({
			bootEntry: 'openclaw-gateway',
			configurationInputPath: '/run/agent-vm/managed-gateway/framework-service.json',
			environmentInputPath: '/run/agent-vm/managed-gateway-environment/framework.environment.sh',
			framework: 'openclaw',
			ingress: { guestPort: 18789, kind: 'framework-http' },
			logIdentity: {
				guestPath: '/var/log/agent-vm/openclaw-service.log',
				serviceName: 'agent-vm-openclaw',
			},
			readiness: { guestPort: 18789, kind: 'framework-http', path: '/readyz' },
			role: 'framework-service',
		});
		expect(metadata).not.toHaveProperty('startCommand');
		expect(metadata).not.toHaveProperty('bootstrapCommand');
		expect(metadata).not.toHaveProperty('childRecipe');
		expect(metadata).not.toHaveProperty('argv');
	});
});
