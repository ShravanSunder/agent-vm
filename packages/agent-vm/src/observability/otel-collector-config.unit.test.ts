import { describe, expect, test } from 'vitest';

import type { ManagedObservabilityRuntimeConfig } from './observability-config.js';
import {
	createOtelCollectorConfigModel,
	renderOtelCollectorConfigYaml,
} from './otel-collector-config.js';

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
			traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
		},
		prepareOnBuild: true,
		waitOnBuild: true,
		controllerStartPolicy: 'degraded',
		startupCheckTimeoutMs: 500,
		zones: [],
	};
}

describe('createOtelCollectorConfigModel', () => {
	test('listens on stable collector container ports instead of host-published ports', () => {
		const runtimeConfig = createRuntimeConfig();
		const collectorConfig = createOtelCollectorConfigModel({
			...runtimeConfig,
			ports: {
				...runtimeConfig.ports,
				collectorGrpc: 61_317,
				collectorHttp: 61_318,
				collectorHealth: 61_133,
			},
		});

		expect(collectorConfig.receivers.otlp.protocols.grpc.endpoint).toBe('0.0.0.0:4317');
		expect(collectorConfig.receivers.otlp.protocols.http.endpoint).toBe('0.0.0.0:4318');
		expect(collectorConfig.extensions.health_check.endpoint).toBe('0.0.0.0:13133');
	});

	test('routes each OTLP signal through sanitization to Victoria endpoints', () => {
		const collectorConfig = createOtelCollectorConfigModel(createRuntimeConfig());

		expect(collectorConfig.exporters.otlphttp.metrics.metricsEndpoint).toBe(
			'http://victoria-metrics:8428/opentelemetry/v1/metrics',
		);
		expect(collectorConfig.exporters.otlphttp.logs.logsEndpoint).toBe(
			'http://victoria-logs:9428/insert/opentelemetry/v1/logs',
		);
		expect(collectorConfig.exporters.otlphttp.traces.tracesEndpoint).toBe(
			'http://victoria-traces:10428/insert/opentelemetry/v1/traces',
		);
		expect(collectorConfig.service.pipelines.metrics.processors).toContain(
			'attributes/drop-sensitive-fields',
		);
		expect(collectorConfig.service.pipelines.metrics.processors).toContain(
			'resource/drop-sensitive-fields',
		);
		expect(collectorConfig.service.pipelines.logs.processors).toContain(
			'attributes/drop-sensitive-fields',
		);
		expect(collectorConfig.service.pipelines.logs.processors).toContain(
			'resource/drop-sensitive-fields',
		);
		expect(collectorConfig.service.pipelines.logs.processors).toContain('transform/drop-log-body');
		expect(collectorConfig.service.pipelines.traces.processors).toContain(
			'attributes/drop-sensitive-fields',
		);
		expect(collectorConfig.service.pipelines.traces.processors).toContain(
			'resource/drop-sensitive-fields',
		);
	});

	test('drops known sensitive fields before any Victoria exporter', () => {
		const collectorConfig = createOtelCollectorConfigModel(createRuntimeConfig());
		const yaml = renderOtelCollectorConfigYaml(collectorConfig);

		expect(yaml).toContain('encoding: proto');
		expect(yaml.match(/compression: gzip/g)).toHaveLength(3);
		for (const fieldName of [
			'authorization',
			'cookie',
			'token',
			'password',
			'access_token',
			'client_secret',
			'http.request.header.authorization',
			'http.response.header.set_cookie',
			'db.statement',
			'x-api-key',
			'body',
			'message',
			'payload',
			'url.full',
			'url.query',
		]) {
			expect(yaml).toContain(fieldName);
		}
		expect(yaml).toContain('resource/drop-sensitive-fields:');
		expect(yaml).toContain('attributes/drop-sensitive-fields:');
		expect(yaml).toContain('actions:');
		expect(yaml).toContain('action: delete');
		expect(yaml).toContain('transform/drop-log-body:');
		expect(yaml).toContain('- "set(body, \\"\\")"');
		expect(yaml).not.toContain('    fields:');
		expect(yaml).toContain('VL-Ignore-Fields');
		expect(yaml).not.toContain('canary-secret-value');
	});
});
