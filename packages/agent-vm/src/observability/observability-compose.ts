import path from 'node:path';

import type {
	ObservabilityBaseRetentionPolicy,
	ObservabilityByteBoundedRetentionPolicy,
	ObservabilityDiskBoundedRetentionPolicy,
	ObservabilityRuntimeConfig,
} from './observability-config.js';

const VICTORIA_METRICS_IMAGE = 'victoriametrics/victoria-metrics:v1.144.0';
const VICTORIA_LOGS_IMAGE = 'victoriametrics/victoria-logs:v1.50.0';
const VICTORIA_TRACES_IMAGE = 'victoriametrics/victoria-traces:v0.9.2';
const OTEL_COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.116.1';

export interface ObservabilityComposeService {
	readonly image: string;
	readonly command?: readonly string[];
	readonly environment?: readonly string[];
	readonly ports: readonly string[];
	readonly restart: 'unless-stopped';
	readonly volumes: readonly string[];
	readonly depends_on?: readonly string[];
}

export interface ObservabilityComposeModel {
	readonly name: string;
	readonly services: Record<string, ObservabilityComposeService>;
}

function assertEnabledConfig(
	config: ObservabilityRuntimeConfig,
): asserts config is Extract<ObservabilityRuntimeConfig, { readonly enabled: true }> {
	if (!config.enabled) {
		throw new Error('Cannot render observability compose for a disabled config.');
	}
}

function renderLoopbackPort(bindAddress: string, hostPort: number, containerPort: number): string {
	const host = bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress;
	return `${host}:${String(hostPort)}:${String(containerPort)}`;
}

function renderBaseRetentionFlags(retention: ObservabilityBaseRetentionPolicy): readonly string[] {
	return [
		`-retentionPeriod=${retention.period}`,
		...(retention.minFreeDiskSpaceBytes === undefined
			? []
			: [`-storage.minFreeDiskSpaceBytes=${retention.minFreeDiskSpaceBytes}`]),
	];
}

function renderByteBoundedRetentionFlags(
	retention: ObservabilityByteBoundedRetentionPolicy,
): readonly string[] {
	return [
		...renderBaseRetentionFlags(retention),
		...(retention.maxDiskSpaceUsageBytes === undefined
			? []
			: [`-retention.maxDiskSpaceUsageBytes=${retention.maxDiskSpaceUsageBytes}`]),
	];
}

function renderDiskBoundedRetentionFlags(
	retention: ObservabilityDiskBoundedRetentionPolicy,
): readonly string[] {
	return [
		...renderBaseRetentionFlags(retention),
		...(retention.maxDiskSpaceUsageBytes === undefined
			? []
			: [`-retention.maxDiskSpaceUsageBytes=${retention.maxDiskSpaceUsageBytes}`]),
		...(retention.maxDiskUsagePercent === undefined
			? []
			: [`-retention.maxDiskUsagePercent=${String(retention.maxDiskUsagePercent)}`]),
	];
}

export function createObservabilityComposeModel(
	config: ObservabilityRuntimeConfig,
): ObservabilityComposeModel {
	assertEnabledConfig(config);

	return {
		name: config.projectName,
		services: {
			'victoria-metrics': {
				image: VICTORIA_METRICS_IMAGE,
				command: [
					'-storageDataPath=/victoria-metrics-data',
					...renderBaseRetentionFlags(config.retention.metrics),
				],
				ports: [renderLoopbackPort(config.bindAddress, config.ports.metrics, 8428)],
				restart: 'unless-stopped',
				volumes: [path.join(config.dataDir, 'metrics') + ':/victoria-metrics-data'],
			},
			'victoria-logs': {
				image: VICTORIA_LOGS_IMAGE,
				command: [
					'-storageDataPath=/victoria-logs-data',
					...renderByteBoundedRetentionFlags(config.retention.logs),
				],
				ports: [renderLoopbackPort(config.bindAddress, config.ports.logs, 9428)],
				restart: 'unless-stopped',
				volumes: [path.join(config.dataDir, 'logs') + ':/victoria-logs-data'],
			},
			'victoria-traces': {
				image: VICTORIA_TRACES_IMAGE,
				command: [
					'-storageDataPath=/victoria-traces-data',
					...renderDiskBoundedRetentionFlags(config.retention.traces),
				],
				ports: [renderLoopbackPort(config.bindAddress, config.ports.traces, 10_428)],
				restart: 'unless-stopped',
				volumes: [path.join(config.dataDir, 'traces') + ':/victoria-traces-data'],
			},
			'otel-collector': {
				image: OTEL_COLLECTOR_IMAGE,
				command: ['--config=/etc/otelcol/config.yaml'],
				depends_on: ['victoria-metrics', 'victoria-logs', 'victoria-traces'],
				environment: [
					'HTTP_PROXY=',
					'HTTPS_PROXY=',
					'NO_PROXY=victoria-metrics,victoria-logs,victoria-traces,localhost,127.0.0.1,::1',
				],
				ports: [
					renderLoopbackPort(config.bindAddress, config.ports.collectorGrpc, 4317),
					renderLoopbackPort(config.bindAddress, config.ports.collectorHttp, 4318),
					renderLoopbackPort(config.bindAddress, config.ports.collectorHealth, 13_133),
				],
				restart: 'unless-stopped',
				volumes: [
					path.join(config.runtimeDir, 'otel-collector-config.yaml') +
						':/etc/otelcol/config.yaml:ro',
				],
			},
		},
	};
}

function renderYamlArray(indent: string, values: readonly string[]): readonly string[] {
	return values.map((value) => `${indent}- ${JSON.stringify(value)}`);
}

export function renderObservabilityComposeYaml(model: ObservabilityComposeModel): string {
	const lines: string[] = [`name: ${JSON.stringify(model.name)}`, 'services:'];
	for (const [serviceName, service] of Object.entries(model.services)) {
		lines.push(`  ${serviceName}:`, `    image: ${service.image}`);
		if (service.command !== undefined) {
			lines.push('    command:', ...renderYamlArray('      ', service.command));
		}
		if (service.depends_on !== undefined) {
			lines.push('    depends_on:', ...renderYamlArray('      ', service.depends_on));
		}
		if (service.environment !== undefined) {
			lines.push('    environment:', ...renderYamlArray('      ', service.environment));
		}
		lines.push(`    restart: ${service.restart}`);
		lines.push('    ports:', ...renderYamlArray('      ', service.ports));
		lines.push('    volumes:', ...renderYamlArray('      ', service.volumes));
	}
	return `${lines.join('\n')}\n`;
}
