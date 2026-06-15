import { describe, expect, it, vi } from 'vitest';

import type {
	ControllerTelemetryDriverOptions,
	ControllerTelemetryLogRecord,
	ControllerTelemetryMetricRecord,
	ControllerTelemetrySpanRecord,
} from './controller-telemetry.js';
import {
	createOtelControllerTelemetryDriver,
	type OtelControllerTelemetryProviderFactory,
} from './otel-controller-telemetry-driver.js';

describe('createOtelControllerTelemetryDriver', () => {
	it('creates OTLP signal providers with resource attributes and signal-specific urls', async () => {
		const emittedLogs: ControllerTelemetryLogRecord[] = [];
		const emittedCounters: ControllerTelemetryMetricRecord[] = [];
		const emittedHistograms: ControllerTelemetryMetricRecord[] = [];
		const emittedSpans: ControllerTelemetrySpanRecord[] = [];
		const shutdownOrder: string[] = [];
		const factoryCalls: Parameters<OtelControllerTelemetryProviderFactory>[0][] = [];
		const providerFactory: OtelControllerTelemetryProviderFactory = (options) => {
			factoryCalls.push(options);
			return {
				loggerProvider: {
					forceFlush: vi.fn(async () => {}),
					getLogger: () => ({
						emit: (record) => emittedLogs.push(record),
					}),
					shutdown: vi.fn(async () => {
						shutdownOrder.push('logs');
					}),
				},
				meterProvider: {
					forceFlush: vi.fn(async () => {}),
					getMeter: () => ({
						createCounter: () => ({
							add: (value, attributes) =>
								emittedCounters.push({
									attributes,
									name: 'agent_vm_health_events_total',
									value,
								}),
						}),
						createHistogram: () => ({
							record: (value, attributes) =>
								emittedHistograms.push({
									attributes,
									name: 'agent_vm_health_event_duration_ms',
									value,
								}),
						}),
					}),
					shutdown: vi.fn(async () => {
						shutdownOrder.push('metrics');
					}),
				},
				tracerProvider: {
					forceFlush: vi.fn(async () => {}),
					getTracer: () => ({
						startSpan: (name, spanOptions) => {
							emittedSpans.push({
								attributes: spanOptions.attributes,
								name,
								observedAtMs: spanOptions.startTime,
							});
							return {
								end: vi.fn(),
							};
						},
					}),
					shutdown: vi.fn(async () => {
						shutdownOrder.push('traces');
					}),
				},
			};
		};
		const options: ControllerTelemetryDriverOptions = {
			endpoint: 'http://127.0.0.1:4318',
			resourceAttributes: {
				'dev.branch.name': 'main',
				'dev.release.channel': 'beta',
				'dev.repo.hash': 'repo-hash',
				'dev.runtime.flavor': 'beta',
				'dev.worktree.hash': 'worktree-hash',
				'service.name': 'agent-vm-controller',
				'service.version': '0.0.98',
			},
		};

		const driver = createOtelControllerTelemetryDriver(options, providerFactory);
		driver.emitLog({
			attributes: { 'agent_vm.controller.event': 'controller-started' },
			body: 'agent-vm controller controller-started',
			name: 'agent_vm.controller.lifecycle',
			observedAtMs: 1_781_445_000_000,
		});
		driver.emitMetric({
			attributes: {
				'agent_vm.health.kind': 'tool-vm-ssh',
				'agent_vm.health.result': 'ok',
				'agent_vm.zone.id': 'beta',
			},
			name: 'agent_vm_health_events_total',
			value: 1,
		});
		driver.emitMetric({
			attributes: {
				'agent_vm.health.kind': 'tool-vm-ssh',
				'agent_vm.health.result': 'ok',
				'agent_vm.zone.id': 'beta',
			},
			name: 'agent_vm_health_event_duration_ms',
			value: 22,
		});
		driver.emitSpan({
			attributes: { 'agent_vm.controller.event': 'controller-started' },
			name: 'agent_vm.controller.controller-started',
			observedAtMs: 1_781_445_000_000,
		});
		await driver.forceFlush();
		await driver.shutdown();

		expect(factoryCalls).toEqual([
			{
				logsUrl: 'http://127.0.0.1:4318/v1/logs',
				metricsUrl: 'http://127.0.0.1:4318/v1/metrics',
				resourceAttributes: options.resourceAttributes,
				tracesUrl: 'http://127.0.0.1:4318/v1/traces',
			},
		]);
		expect(emittedLogs).toEqual([
			expect.objectContaining({
				attributes: { 'agent_vm.controller.event': 'controller-started' },
				body: 'agent-vm controller controller-started',
				name: 'agent_vm.controller.lifecycle',
				observedAtMs: 1_781_445_000_000,
			}),
		]);
		expect(emittedCounters).toEqual([
			{
				attributes: {
					'agent_vm.health.kind': 'tool-vm-ssh',
					'agent_vm.health.result': 'ok',
					'agent_vm.zone.id': 'beta',
				},
				name: 'agent_vm_health_events_total',
				value: 1,
			},
		]);
		expect(emittedHistograms).toEqual([
			{
				attributes: {
					'agent_vm.health.kind': 'tool-vm-ssh',
					'agent_vm.health.result': 'ok',
					'agent_vm.zone.id': 'beta',
				},
				name: 'agent_vm_health_event_duration_ms',
				value: 22,
			},
		]);
		expect(emittedSpans).toEqual([
			{
				attributes: { 'agent_vm.controller.event': 'controller-started' },
				name: 'agent_vm.controller.controller-started',
				observedAtMs: 1_781_445_000_000,
			},
		]);
		expect(shutdownOrder).toEqual(['logs', 'metrics', 'traces']);
	});
});
