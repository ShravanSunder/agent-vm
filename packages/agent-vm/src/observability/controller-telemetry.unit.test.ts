import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayTelemetryResourceAttributesEnvironmentValue,
	startControllerTelemetry,
	type ControllerTelemetryDriver,
	type ControllerTelemetryDriverOptions,
	type ControllerTelemetryLogRecord,
	type ControllerTelemetryMetricRecord,
	type ControllerTelemetrySpanRecord,
} from './controller-telemetry.js';
import type { EnabledObservabilityRuntimeConfig } from './observability-config.js';

function createObservabilityConfig(): EnabledObservabilityRuntimeConfig {
	return {
		bindAddress: '127.0.0.1',
		controllerStartPolicy: 'degraded',
		enabled: true,
		ports: {
			collectorGrpc: 4317,
			collectorHealth: 13_133,
			collectorHttp: 4318,
			logs: 9428,
			metrics: 8428,
			traces: 10_428,
		},
		prepareOnBuild: true,
		runtimeDir: '/runtime/observability/shravan-claw-beta-25319b68',
		stackMode: 'external',
		startupCheckTimeoutMs: 500,
		waitOnBuild: true,
		zones: [],
	};
}

describe('startControllerTelemetry', () => {
	it('starts a controller producer with beta-safe resource labels and proof attributes', () => {
		const driverOptions: ControllerTelemetryDriverOptions[] = [];
		const logs: ControllerTelemetryLogRecord[] = [];
		const metrics: ControllerTelemetryMetricRecord[] = [];
		const spans: ControllerTelemetrySpanRecord[] = [];
		const driver: ControllerTelemetryDriver = {
			emitLog: (record) => logs.push(record),
			emitMetric: (record) => metrics.push(record),
			emitSpan: (record) => spans.push(record),
			forceFlush: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
		};

		const telemetry = startControllerTelemetry({
			createDriver: (options) => {
				driverOptions.push(options);
				return driver;
			},
			identity: {
				branchName: 'main',
				repositoryIdentity: 'https://github.com/ShravanSunder/shravan-claw.git',
				serviceVersion: '0.0.99',
				worktreeIdentity: '/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta',
			},
			observabilityConfig: createObservabilityConfig(),
			proof: {
				marker: 'controller-proof-marker',
				startedAt: '2026-06-14T14:45:00.000Z',
			},
			projectNamespace: 'shravan-claw-beta-25319b68',
		});

		telemetry?.recordControllerLifecycleEvent({
			eventName: 'controller-started',
			observedAtMs: 1_781_445_000_000,
		});

		expect(driverOptions).toHaveLength(1);
		expect(driverOptions[0]).toMatchObject({
			endpoint: 'http://127.0.0.1:4318',
			resourceAttributes: {
				'dev.branch.name': 'main',
				'dev.release.channel': 'beta',
				'dev.runtime.flavor': 'beta',
				'service.name': 'agent-vm-controller',
				'service.version': '0.0.99',
			},
		});
		expect(driverOptions[0]?.resourceAttributes['dev.repo.hash']).toMatch(/^[a-f0-9]{16}$/u);
		expect(driverOptions[0]?.resourceAttributes['dev.worktree.hash']).toMatch(/^[a-f0-9]{16}$/u);
		expect(JSON.stringify(driverOptions[0]?.resourceAttributes)).not.toContain('shravan-claw-beta');
		expect(
			createGatewayTelemetryResourceAttributesEnvironmentValue({
				identity: {
					branchName: 'main',
					repositoryIdentity: 'https://github.com/ShravanSunder/shravan-claw.git',
					serviceVersion: '0.0.99',
					worktreeIdentity: '/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta',
				},
				projectNamespace: 'shravan-claw-beta-25319b68',
				stackMode: 'external',
			}),
		).toBe(
			[
				'dev.release.channel=beta',
				`dev.repo.hash=${String(driverOptions[0]?.resourceAttributes['dev.repo.hash'])}`,
				'dev.runtime.flavor=beta',
				`dev.worktree.hash=${String(driverOptions[0]?.resourceAttributes['dev.worktree.hash'])}`,
			].join(','),
		);
		expect(logs).toEqual([
			expect.objectContaining({
				attributes: expect.objectContaining({
					'agent.proof.marker': 'controller-proof-marker',
					'agent.proof.started_at': '2026-06-14T14:45:00.000Z',
					'agent_vm.controller.event': 'controller-started',
				}),
				body: 'agent-vm controller controller-started',
				name: 'agent_vm.controller.lifecycle',
				observedAtMs: 1_781_445_000_000,
			}),
		]);
		expect(spans).toEqual([
			expect.objectContaining({
				attributes: expect.objectContaining({
					'agent.proof.marker': 'controller-proof-marker',
					'agent_vm.controller.event': 'controller-started',
				}),
				name: 'agent_vm.controller.controller-started',
			}),
		]);
		expect(metrics).toEqual([]);
	});

	it('emits health events as logs, metrics, and short spans without metric proof labels', () => {
		const logs: ControllerTelemetryLogRecord[] = [];
		const metrics: ControllerTelemetryMetricRecord[] = [];
		const spans: ControllerTelemetrySpanRecord[] = [];
		const driver: ControllerTelemetryDriver = {
			emitLog: (record) => logs.push(record),
			emitMetric: (record) => metrics.push(record),
			emitSpan: (record) => spans.push(record),
			forceFlush: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
		};
		const telemetry = startControllerTelemetry({
			createDriver: () => driver,
			identity: {
				branchName: 'main',
				repositoryIdentity: 'repo',
				serviceVersion: '0.0.99',
				worktreeIdentity: 'worktree',
			},
			observabilityConfig: createObservabilityConfig(),
			proof: {
				marker: 'fresh-marker',
				startedAt: '2026-06-14T14:45:00.000Z',
			},
			projectNamespace: 'shravan-claw-beta-25319b68',
		});
		const event = {
			agentId: 'main',
			elapsedMs: 22,
			kind: 'tool-vm-ssh',
			leaseId: 'lease-secret-canary',
			observedAtMs: 1_781_445_100_000,
			operation: 'probe',
			result: 'timeout',
			zoneId: 'beta',
		} satisfies AgentVmHealthEvent;

		telemetry?.healthEventSink.record(event);

		expect(logs).toEqual([
			expect.objectContaining({
				attributes: expect.objectContaining({
					'agent.proof.marker': 'fresh-marker',
					'agent_vm.health.kind': 'tool-vm-ssh',
					'agent_vm.tool_vm.ssh.operation': 'probe',
				}),
				body: 'agent-vm health tool-vm-ssh timeout',
				name: 'agent_vm.health_event',
			}),
		]);
		expect(metrics).toEqual([
			expect.objectContaining({
				attributes: {
					'agent_vm.health.kind': 'tool-vm-ssh',
					'agent_vm.health.result': 'timeout',
					'agent_vm.zone.id': 'beta',
				},
				name: 'agent_vm_health_events_total',
				value: 1,
			}),
			expect.objectContaining({
				attributes: {
					'agent_vm.health.kind': 'tool-vm-ssh',
					'agent_vm.health.result': 'timeout',
					'agent_vm.zone.id': 'beta',
				},
				name: 'agent_vm_health_event_duration_ms',
				value: 22,
			}),
		]);
		expect(spans).toEqual([
			expect.objectContaining({
				attributes: expect.objectContaining({
					'agent.proof.marker': 'fresh-marker',
					'agent_vm.health.kind': 'tool-vm-ssh',
				}),
				name: 'agent_vm.health.tool-vm-ssh',
			}),
		]);
		expect(JSON.stringify({ logs, metrics, spans })).not.toContain('lease-secret-canary');
	});

	it('contains synchronous driver failures outside controller and health mutation', () => {
		const driver: ControllerTelemetryDriver = {
			emitLog: vi.fn(() => {
				throw new Error('log sink failed');
			}),
			emitMetric: vi.fn(() => {
				throw new Error('metric sink failed');
			}),
			emitSpan: vi.fn(() => {
				throw new Error('span sink failed');
			}),
			forceFlush: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
		};
		const telemetry = startControllerTelemetry({
			createDriver: () => driver,
			identity: {
				branchName: 'main',
				repositoryIdentity: 'repo',
				serviceVersion: '0.0.99',
				worktreeIdentity: 'worktree',
			},
			observabilityConfig: createObservabilityConfig(),
			projectNamespace: 'beta',
		});

		expect(() => {
			telemetry?.recordControllerLifecycleEvent({
				eventName: 'controller-started',
				observedAtMs: 1,
			});
		}).not.toThrow();
		expect(() => {
			telemetry?.healthEventSink.record({
				domain: 'gateway_control',
				elapsedMs: 1,
				kind: 'gateway-control-session',
				observedAtMs: 2,
				operation: 'control-session-disconnect',
				peerId: 'gateway-beta',
				result: 'failed',
				zoneId: 'beta',
			});
		}).not.toThrow();
		expect(telemetry?.getDiagnostics?.()).toMatchObject({
			emissionFailures: 6,
			operationFailures: 0,
		});
	});

	it('bounds flush and shutdown when the telemetry driver never resolves', async () => {
		vi.useFakeTimers();
		try {
			const neverResolve = new Promise<void>(() => {});
			const driver: ControllerTelemetryDriver = {
				emitLog: vi.fn(),
				emitMetric: vi.fn(),
				emitSpan: vi.fn(),
				forceFlush: vi.fn(async () => await neverResolve),
				shutdown: vi.fn(async () => await neverResolve),
			};
			const telemetry = startControllerTelemetry({
				createDriver: () => driver,
				driverOperationTimeoutMs: 25,
				identity: {
					branchName: 'main',
					repositoryIdentity: 'repo',
					serviceVersion: '0.0.99',
					worktreeIdentity: 'worktree',
				},
				observabilityConfig: createObservabilityConfig(),
				projectNamespace: 'beta',
			});

			let flushSettled = 0;
			const firstFlush = telemetry?.forceFlush().then(() => {
				flushSettled += 1;
			});
			const secondFlush = telemetry?.forceFlush().then(() => {
				flushSettled += 1;
			});
			await vi.advanceTimersByTimeAsync(24);
			expect(flushSettled).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			await Promise.all([firstFlush, secondFlush]);
			expect(flushSettled).toBe(2);
			expect(driver.forceFlush).toHaveBeenCalledTimes(1);

			let shutdownSettled = false;
			const shutdown = telemetry?.shutdown().then(() => {
				shutdownSettled = true;
			});
			await vi.advanceTimersByTimeAsync(25);
			await shutdown;
			expect(shutdownSettled).toBe(true);
			expect(telemetry?.getDiagnostics?.()).toEqual({
				emissionFailures: 0,
				operationFailures: 0,
				operationTimeouts: 3,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('accounts rejected driver operations without exposing them to controller shutdown', async () => {
		const driver: ControllerTelemetryDriver = {
			emitLog: vi.fn(),
			emitMetric: vi.fn(),
			emitSpan: vi.fn(),
			forceFlush: vi.fn(async () => {
				throw new Error('exporter rejected flush');
			}),
			shutdown: vi.fn(async () => {}),
		};
		const telemetry = startControllerTelemetry({
			createDriver: () => driver,
			identity: {
				branchName: 'main',
				repositoryIdentity: 'repo',
				serviceVersion: '0.0.99',
				worktreeIdentity: 'worktree',
			},
			observabilityConfig: createObservabilityConfig(),
			projectNamespace: 'beta',
		});

		await expect(telemetry?.forceFlush()).resolves.toBeUndefined();
		expect(telemetry?.getDiagnostics?.()).toEqual({
			emissionFailures: 0,
			operationFailures: 1,
			operationTimeouts: 0,
		});
	});
});
