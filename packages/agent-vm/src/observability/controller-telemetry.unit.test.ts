import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import {
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
				serviceVersion: '0.0.98',
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
				'service.version': '0.0.98',
			},
		});
		expect(driverOptions[0]?.resourceAttributes['dev.repo.hash']).toMatch(/^[a-f0-9]{16}$/u);
		expect(driverOptions[0]?.resourceAttributes['dev.worktree.hash']).toMatch(/^[a-f0-9]{16}$/u);
		expect(JSON.stringify(driverOptions[0]?.resourceAttributes)).not.toContain('shravan-claw-beta');
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
				serviceVersion: '0.0.98',
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
});
