import { describe, expect, test } from 'vitest';

import {
	createObservabilityComposeModel,
	renderObservabilityComposeYaml,
} from './observability-compose.js';
import type { ManagedObservabilityRuntimeConfig } from './observability-config.js';

function createRuntimeConfig(): ManagedObservabilityRuntimeConfig {
	return {
		enabled: true,
		stackMode: 'managed',
		projectName: 'agent-vm-observability-sunfam',
		runtimeDir: '/tmp/runtime/observability/sunfam',
		dataDir: '/tmp/observability/sunfam',
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
			traces: { period: '7d', maxDiskUsagePercent: 80 },
		},
		prepareOnBuild: true,
		waitOnBuild: true,
		controllerStartPolicy: 'degraded',
		startupCheckTimeoutMs: 500,
		zones: [],
	};
}

describe('createObservabilityComposeModel', () => {
	test('binds every published port to host loopback and durable dataDir mounts', () => {
		const composeModel = createObservabilityComposeModel(createRuntimeConfig());
		const victoriaMetrics = composeModel.services['victoria-metrics'];
		const victoriaLogs = composeModel.services['victoria-logs'];
		const victoriaTraces = composeModel.services['victoria-traces'];
		const otelCollector = composeModel.services['otel-collector'];
		if (!victoriaMetrics || !victoriaLogs || !victoriaTraces || !otelCollector) {
			throw new Error('Expected all observability compose services to be present.');
		}

		expect(victoriaMetrics.ports).toEqual(['127.0.0.1:8428:8428']);
		expect(victoriaLogs.ports).toEqual(['127.0.0.1:9428:9428']);
		expect(victoriaTraces.ports).toEqual(['127.0.0.1:10428:10428']);
		expect(victoriaMetrics.command).not.toContain('-retention.maxDiskSpaceUsageBytes=50GiB');
		expect(victoriaMetrics.command).not.toContain('-retention.maxDiskUsagePercent=80');
		expect(victoriaLogs.command).toContain('-retention.maxDiskSpaceUsageBytes=50GiB');
		expect(victoriaLogs.command).not.toContain('-retention.maxDiskUsagePercent=80');
		expect(victoriaTraces.command).not.toContain('-retention.maxDiskSpaceUsageBytes=20GiB');
		expect(victoriaTraces.command).toContain('-retention.maxDiskUsagePercent=80');
		expect(victoriaMetrics.restart).toBe('unless-stopped');
		expect(victoriaLogs.restart).toBe('unless-stopped');
		expect(victoriaTraces.restart).toBe('unless-stopped');
		expect(otelCollector.restart).toBe('unless-stopped');
		expect(otelCollector.ports).toEqual([
			'127.0.0.1:4317:4317',
			'127.0.0.1:4318:4318',
			'127.0.0.1:13133:13133',
		]);
		expect(otelCollector.environment).toEqual([
			'HTTP_PROXY=',
			'HTTPS_PROXY=',
			'NO_PROXY=victoria-metrics,victoria-logs,victoria-traces,localhost,127.0.0.1,::1',
		]);
		expect(victoriaMetrics.volumes).toContain(
			'/tmp/observability/sunfam/metrics:/victoria-metrics-data',
		);
		expect(victoriaLogs.volumes).toContain('/tmp/observability/sunfam/logs:/victoria-logs-data');
		expect(victoriaTraces.volumes).toContain(
			'/tmp/observability/sunfam/traces:/victoria-traces-data',
		);
	});

	test('renders deterministic yaml without secrets or destructive volume deletion', () => {
		const yaml = renderObservabilityComposeYaml(
			createObservabilityComposeModel(createRuntimeConfig()),
		);

		expect(yaml).toContain('name: "agent-vm-observability-sunfam"');
		expect(yaml).toContain('victoria-metrics:');
		expect(yaml).toContain('victoriametrics/victoria-logs:v1.50.0');
		expect(yaml.match(/restart: unless-stopped/g)).toHaveLength(4);
		expect(yaml).toContain('HTTP_PROXY=');
		expect(yaml).toContain('NO_PROXY=victoria-metrics,victoria-logs,victoria-traces');
		expect(yaml).toContain('-retentionPeriod=30d');
		expect(yaml).toContain('-storage.minFreeDiskSpaceBytes=5GiB');
		expect(yaml).toContain('-retention.maxDiskSpaceUsageBytes=50GiB');
		expect(yaml).toContain('-retention.maxDiskUsagePercent=80');
		expect(yaml).toContain('-storageDataPath=/victoria-metrics-data');
		expect(yaml).not.toContain('down -v');
		expect(yaml).not.toMatch(/token|password|secret|authorization|cookie/iu);
	});

	test('quotes IPv6 loopback published ports for Docker Compose yaml parsing', () => {
		const yaml = renderObservabilityComposeYaml(
			createObservabilityComposeModel({
				...createRuntimeConfig(),
				bindAddress: '::1',
			}),
		);

		expect(yaml).toContain('- "[::1]:8428:8428"');
		expect(yaml).toContain('- "[::1]:4318:4318"');
	});
});
