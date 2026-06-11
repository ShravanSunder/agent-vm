import path from 'node:path';

import type { LoadedSystemConfig } from '../config/system-config.js';

export interface ObservabilityBaseRetentionPolicy {
	readonly period: string;
	readonly minFreeDiskSpaceBytes?: string | undefined;
}

export interface ObservabilityByteBoundedRetentionPolicy extends ObservabilityBaseRetentionPolicy {
	readonly maxDiskSpaceUsageBytes?: string | undefined;
}

export interface ObservabilityDiskBoundedRetentionPolicy extends ObservabilityBaseRetentionPolicy {
	readonly maxDiskSpaceUsageBytes?: string | undefined;
	readonly maxDiskUsagePercent?: number | undefined;
}

export interface ObservabilityPortConfig {
	readonly collectorGrpc: number;
	readonly collectorHttp: number;
	readonly collectorHealth: number;
	readonly metrics: number;
	readonly logs: number;
	readonly traces: number;
}

export interface ObservabilityZoneRuntimeConfig {
	readonly zoneId: string;
	readonly serviceName: string;
	readonly traces: boolean;
	readonly metrics: boolean;
	readonly logs: boolean;
	readonly sampleRate: number;
	readonly flushIntervalMs: number;
	readonly diagnosticsFlags: readonly string[];
}

export type ObservabilityRuntimeConfig =
	| {
			readonly enabled: false;
	  }
	| {
			readonly enabled: true;
			readonly projectName: string;
			readonly runtimeDir: string;
			readonly dataDir: string;
			readonly bindAddress: '127.0.0.1' | '::1';
			readonly ports: ObservabilityPortConfig;
			readonly retention: {
				readonly metrics: ObservabilityBaseRetentionPolicy;
				readonly logs: ObservabilityByteBoundedRetentionPolicy;
				readonly traces: ObservabilityDiskBoundedRetentionPolicy;
			};
			readonly prepareOnBuild: boolean;
			readonly waitOnBuild: boolean;
			readonly controllerStartPolicy: 'degraded' | 'require-ready' | 'off';
			readonly startupCheckTimeoutMs: number;
			readonly zones: readonly ObservabilityZoneRuntimeConfig[];
	  };

export function createObservabilityRuntimeConfig(
	config: LoadedSystemConfig,
): ObservabilityRuntimeConfig {
	const hostObservability = config.host.observability;
	if (hostObservability?.enabled !== true) {
		return { enabled: false };
	}

	const projectName =
		hostObservability.projectName ?? `agent-vm-observability-${config.host.projectNamespace}`;
	const zones = config.zones.flatMap((zone): readonly ObservabilityZoneRuntimeConfig[] => {
		if (zone.observability?.enabled !== true) {
			return [];
		}
		const { openclaw } = zone.observability;
		return [
			{
				zoneId: zone.id,
				serviceName: openclaw.serviceName,
				traces: openclaw.traces,
				metrics: openclaw.metrics,
				logs: openclaw.logs,
				sampleRate: openclaw.sampleRate,
				flushIntervalMs: openclaw.flushIntervalMs,
				diagnosticsFlags: openclaw.diagnosticsFlags,
			},
		];
	});

	return {
		enabled: true,
		projectName,
		runtimeDir: path.join(config.runtimeDir, 'observability', config.host.projectNamespace),
		dataDir: hostObservability.dataDir,
		bindAddress: hostObservability.bindAddress,
		ports: hostObservability.ports,
		retention: hostObservability.retention,
		prepareOnBuild: hostObservability.prepareOnBuild,
		waitOnBuild: hostObservability.waitOnBuild,
		controllerStartPolicy: hostObservability.controllerStartPolicy,
		startupCheckTimeoutMs: hostObservability.startupCheckTimeoutMs,
		zones,
	};
}
