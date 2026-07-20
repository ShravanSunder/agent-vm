import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import {
	buildControllerStatus,
	buildControllerZoneStatus,
	type ControllerZoneDiagnosisStatus,
} from './controller-status.js';

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	controllerStateDir: '/controller-state-test',
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
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'alevtina',
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './config/alevtina/openclaw.json',
				stateDir: './state/alevtina',
				zoneFilesDir: './zone-files/alevtina',
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
		expect(buildControllerStatus(systemConfig)).toMatchObject({
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
					toolVmLeaseState: 'not-applicable',
					defaultToolVmProfile: 'standard',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'openclaw',
					id: 'alevtina',
					ingressPort: 18792,
					lifecycleState: 'stopped',
					running: false,
					toolVmLeaseState: 'not-applicable',
					defaultToolVmProfile: 'standard',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'worker',
					id: 'worker-zone',
					ingressPort: 18793,
					lifecycleState: 'stopped',
					running: false,
					toolVmLeaseState: 'not-applicable',
				},
			],
		});
	});

	it('includes only bounded numeric observability diagnostics when provided', () => {
		const queueDiagnostics = {
			activeOperations: 1,
			coalescedRecords: 3,
			droppedBytes: 128,
			droppedRecords: 2,
			failedOperations: 1,
			flushTimeoutMs: 2_000,
			flushTimeouts: 1,
			highWaterPendingBytes: 1_024,
			highWaterPendingRecords: 8,
			livenessAggregationWindowMs: 10_000,
			maxOutstandingOperations: 2,
			maxPendingBytes: 524_288,
			maxPendingRecords: 256,
			operationTimeoutMs: 1_000,
			operationTimeouts: 1,
			outstandingBytes: 64,
			pendingBytes: 512,
			pendingRecords: 4,
		};

		const status = buildControllerStatus(
			systemConfig,
			{},
			{
				evidence: {
					durableLog: queueDiagnostics,
					healthEventSinks: queueDiagnostics,
				},
				telemetry: {
					emissionFailures: 1,
					operationFailures: 2,
					operationTimeouts: 3,
				},
			},
		);

		expect(status.observability).toMatchObject({
			evidence: {
				healthEventSinks: {
					droppedRecords: 2,
					highWaterPendingRecords: 8,
				},
			},
			telemetry: {
				emissionFailures: 1,
				operationFailures: 2,
				operationTimeouts: 3,
			},
		});
		expect(JSON.stringify(status.observability)).not.toContain('secret');
		expect(JSON.stringify(status.observability)).not.toContain('leaseId');
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
		).toMatchObject({
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
					toolVmLeaseState: 'not-applicable',
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
					toolVmLeaseState: 'not-applicable',
					defaultToolVmProfile: 'standard',
				},
				{
					activeLeaseCount: 0,
					gatewayType: 'worker',
					id: 'worker-zone',
					ingressPort: 18793,
					lifecycleState: 'stopped',
					running: false,
					toolVmLeaseState: 'not-applicable',
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

	it('reports selected-zone readiness running when controller liveness and gateway infrastructure are running', () => {
		const diagnosis = runningDiagnosis();

		const status = buildControllerZoneStatus(systemConfig, 'shravan', {
			diagnoses: { shravan: diagnosis },
			zones: {
				shravan: {
					bootedAt: '2026-04-30T10:00:00.000Z',
					gateway: {
						ingress: { host: '127.0.0.1', port: 18791 },
						vm: { hostPid: 48_282, id: 'gateway-vm-1' },
					},
					lifecycleState: 'running',
				},
			},
		});

		expect(status.diagnosis).toEqual(diagnosis);
		expect(status.readiness).toBe('running');
		expect(status.toolVmLeaseState).toBe('none');
	});

	it('reports selected-zone readiness failed when controller liveness is ok but the zone failed', () => {
		const status = buildControllerZoneStatus(systemConfig, 'shravan', {
			diagnoses: {
				shravan: {
					...runningDiagnosis(),
					currentRecoveryBlocker: 'secret-resolution-failed',
					gatewayInfrastructure: 'failed',
					selectedZoneReadiness: 'failed',
				},
			},
			zones: {
				shravan: {
					lastError: 'Failed to resolve zone secrets',
					lifecycleState: 'failed',
				},
			},
		});

		expect(status.readiness).toBe('failed');
		expect(status.diagnosis).toMatchObject({
			currentRecoveryBlocker: 'secret-resolution-failed',
			originalOutageCause: { kind: 'unknown' },
			selectedZoneReadiness: 'failed',
		});
	});

	it('reports owner-unsafe readiness without loosening diagnosis unions', () => {
		const diagnosis = {
			...runningDiagnosis(),
			currentRecoveryBlocker: 'owner-unsafe',
			gatewayInfrastructure: 'owner-unsafe',
			selectedZoneReadiness: 'owner-unsafe',
		} satisfies ControllerZoneDiagnosisStatus;

		const status = buildControllerZoneStatus(systemConfig, 'shravan', {
			diagnoses: { shravan: diagnosis },
		});

		expect(status.readiness).toBe('owner-unsafe');
		expect(status.diagnosis.currentRecoveryBlocker).toBe('owner-unsafe');
	});

	it('degrades readiness when a running zone has a current recovery blocker', () => {
		const status = buildControllerZoneStatus(systemConfig, 'shravan', {
			diagnoses: {
				shravan: {
					...runningDiagnosis(),
					currentRecoveryBlocker: 'gateway-control-session-unhealthy',
					selectedZoneReadiness: 'degraded',
				},
			},
			zones: {
				shravan: {
					gateway: {
						ingress: { host: '127.0.0.1', port: 18791 },
						vm: { hostPid: 48_282, id: 'gateway-vm-1' },
					},
					lifecycleState: 'running',
				},
			},
		});

		expect(status.running).toBe(true);
		expect(status.readiness).toBe('degraded');
	});
});

function runningDiagnosis(): ControllerZoneDiagnosisStatus {
	return {
		channelProviderPlane: 'ok',
		controllerLiveness: 'ok',
		currentRecoveryBlocker: 'none',
		gatewayInfrastructure: 'running',
		lastOperation: 'none',
		originalOutageCause: { kind: 'unknown' },
		selectedZoneReadiness: 'running',
		toolVmLeaseState: 'none',
		toolVmPlane: 'unknown',
	};
}
