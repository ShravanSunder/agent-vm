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

interface ObservabilityEnabledRuntimeConfigBase {
	readonly enabled: true;
	readonly stackMode: 'external' | 'managed';
	readonly runtimeDir: string;
	readonly bindAddress: '127.0.0.1' | '::1';
	readonly ports: ObservabilityPortConfig;
	readonly prepareOnBuild: boolean;
	readonly waitOnBuild: boolean;
	readonly controllerStartPolicy: 'degraded' | 'require-ready' | 'off';
	readonly startupCheckTimeoutMs: number;
	readonly zones: readonly ObservabilityZoneRuntimeConfig[];
}

export interface ManagedObservabilityRuntimeConfig extends ObservabilityEnabledRuntimeConfigBase {
	readonly stackMode: 'managed';
	readonly projectName: string;
	readonly dataDir: string;
	readonly retention: {
		readonly metrics: ObservabilityBaseRetentionPolicy;
		readonly logs: ObservabilityByteBoundedRetentionPolicy;
		readonly traces: ObservabilityDiskBoundedRetentionPolicy;
	};
}

export interface ExternalObservabilityRuntimeConfig extends ObservabilityEnabledRuntimeConfigBase {
	readonly stackMode: 'external';
}

export type EnabledObservabilityRuntimeConfig =
	| ExternalObservabilityRuntimeConfig
	| ManagedObservabilityRuntimeConfig;

export type ObservabilityRuntimeConfig =
	| {
			readonly enabled: false;
	  }
	| EnabledObservabilityRuntimeConfig;

type HostObservabilityConfig = LoadedSystemConfig['host']['observability'];
type ExternalHostObservabilityConfig = Extract<
	NonNullable<HostObservabilityConfig>,
	{ readonly enabled: true; readonly stack: { readonly mode: 'external' } }
>;
type ManagedHostObservabilityConfig = Extract<
	NonNullable<HostObservabilityConfig>,
	{ readonly enabled: true; readonly stack: { readonly mode: 'managed' } }
>;

function isExternalHostObservabilityConfig(
	observability: HostObservabilityConfig,
): observability is ExternalHostObservabilityConfig {
	return observability?.enabled === true && observability.stack.mode === 'external';
}

function isManagedHostObservabilityConfig(
	observability: HostObservabilityConfig,
): observability is ManagedHostObservabilityConfig {
	return observability?.enabled === true && observability.stack.mode === 'managed';
}

export function createObservabilityRuntimeConfig(
	config: LoadedSystemConfig,
): ObservabilityRuntimeConfig {
	const hostObservability = config.host.observability;
	if (hostObservability?.enabled !== true) {
		return { enabled: false };
	}

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

	const baseConfig = {
		enabled: true,
		runtimeDir: path.join(config.runtimeDir, 'observability', config.host.projectNamespace),
		bindAddress: hostObservability.bindAddress,
		ports: hostObservability.ports,
		prepareOnBuild: hostObservability.prepareOnBuild,
		waitOnBuild: hostObservability.waitOnBuild,
		controllerStartPolicy: hostObservability.controllerStartPolicy,
		startupCheckTimeoutMs: hostObservability.startupCheckTimeoutMs,
		zones,
	} satisfies Omit<ObservabilityEnabledRuntimeConfigBase, 'stackMode'>;

	if (isExternalHostObservabilityConfig(hostObservability)) {
		return {
			...baseConfig,
			stackMode: 'external',
		};
	}

	if (!isManagedHostObservabilityConfig(hostObservability)) {
		throw new Error('Managed host observability requires dataDir and retention.');
	}
	const projectName =
		hostObservability.projectName ?? `agent-vm-observability-${config.host.projectNamespace}`;
	return {
		...baseConfig,
		stackMode: 'managed',
		projectName,
		dataDir: hostObservability.dataDir,
		retention: hostObservability.retention,
	};
}
