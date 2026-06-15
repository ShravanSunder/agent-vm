import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';

import {
	mapHealthEventToTelemetry,
	stableTelemetryHash,
	type TelemetryAttributes,
	type TelemetryAttributeValue,
} from './health-event-telemetry.js';
import type {
	EnabledObservabilityRuntimeConfig,
	ObservabilityRuntimeConfig,
} from './observability-config.js';
import { formatHttpHost } from './observability-readiness.js';
import { createOtelControllerTelemetryDriver } from './otel-controller-telemetry-driver.js';

export interface ControllerTelemetryIdentity {
	readonly branchName: string;
	readonly releaseChannel?: string | undefined;
	readonly repositoryIdentity: string;
	readonly runtimeFlavor?: string | undefined;
	readonly serviceVersion: string;
	readonly worktreeIdentity: string;
}

export interface ControllerTelemetryProofAttributes {
	readonly marker?: string | undefined;
	readonly startedAt?: string | undefined;
	readonly stateFile?: string | undefined;
}

export interface ControllerTelemetryDriverOptions {
	readonly endpoint: string;
	readonly resourceAttributes: TelemetryAttributes;
}

export interface ControllerTelemetryLogRecord {
	readonly attributes: TelemetryAttributes;
	readonly body: string;
	readonly name: string;
	readonly observedAtMs: number;
}

export interface ControllerTelemetryMetricRecord {
	readonly attributes: TelemetryAttributes;
	readonly name: string;
	readonly value: number;
}

export interface ControllerTelemetrySpanRecord {
	readonly attributes: TelemetryAttributes;
	readonly name: string;
	readonly observedAtMs: number;
}

export interface ControllerTelemetryDriver {
	readonly emitLog: (record: ControllerTelemetryLogRecord) => void;
	readonly emitMetric: (record: ControllerTelemetryMetricRecord) => void;
	readonly emitSpan: (record: ControllerTelemetrySpanRecord) => void;
	readonly forceFlush: () => Promise<void>;
	readonly shutdown: () => Promise<void>;
}

export interface ControllerLifecycleTelemetryEvent {
	readonly eventName: string;
	readonly observedAtMs: number;
}

export interface ControllerTelemetry {
	readonly healthEventSink: {
		readonly record: (event: AgentVmHealthEvent) => void;
	};
	readonly forceFlush: () => Promise<void>;
	readonly recordControllerLifecycleEvent: (event: ControllerLifecycleTelemetryEvent) => void;
	readonly shutdown: () => Promise<void>;
}

export interface StartControllerTelemetryOptions {
	readonly createDriver?:
		| ((options: ControllerTelemetryDriverOptions) => ControllerTelemetryDriver)
		| undefined;
	readonly identity: ControllerTelemetryIdentity;
	readonly observabilityConfig: ObservabilityRuntimeConfig;
	readonly projectNamespace: string;
	readonly proof?: ControllerTelemetryProofAttributes | undefined;
}

export function startControllerTelemetry(
	options: StartControllerTelemetryOptions,
): ControllerTelemetry | undefined {
	if (!options.observabilityConfig.enabled) {
		return undefined;
	}

	const enabledConfig = options.observabilityConfig;
	const driver = (options.createDriver ?? createOtelControllerTelemetryDriver)({
		endpoint: formatCollectorHttpEndpoint(enabledConfig),
		resourceAttributes: createControllerTelemetryResourceAttributes({
			identity: options.identity,
			projectNamespace: options.projectNamespace,
			stackMode: enabledConfig.stackMode,
		}),
	});
	const proofAttributes = createProofAttributes(options.proof);

	const emitLog = (record: {
		readonly attributes: TelemetryAttributes;
		readonly body: string;
		readonly logName: string;
		readonly observedAtMs: number;
	}): void => {
		driver.emitLog({
			attributes: {
				...record.attributes,
				'agent_vm.log.name': record.logName,
				...proofAttributes,
			},
			body: record.body,
			name: record.logName,
			observedAtMs: record.observedAtMs,
		});
	};

	const emitLogAndSpan = (record: {
		readonly attributes: TelemetryAttributes;
		readonly body: string;
		readonly logName: string;
		readonly observedAtMs: number;
		readonly spanName: string;
	}): void => {
		const attributes = {
			...record.attributes,
			...proofAttributes,
		};
		emitLog({
			attributes,
			body: record.body,
			logName: record.logName,
			observedAtMs: record.observedAtMs,
		});
		driver.emitSpan({
			attributes,
			name: record.spanName,
			observedAtMs: record.observedAtMs,
		});
	};

	return {
		forceFlush: async () => {
			await driver.forceFlush();
		},
		healthEventSink: {
			record: (event) => {
				const telemetry = mapHealthEventToTelemetry(event);
				emitLog({
					attributes: telemetry.log.attributes,
					body: telemetry.log.message,
					logName: 'agent_vm.health_event',
					observedAtMs: event.observedAtMs,
				});
				if (shouldEmitHealthEventSpan(event)) {
					driver.emitSpan({
						attributes: {
							...telemetry.log.attributes,
							...proofAttributes,
						},
						name: `agent_vm.health.${event.kind}`,
						observedAtMs: event.observedAtMs,
					});
				}
				for (const metricSample of telemetry.metricSamples) {
					driver.emitMetric(metricSample);
				}
			},
		},
		recordControllerLifecycleEvent: (event) => {
			emitLogAndSpan({
				attributes: {
					'agent_vm.controller.event': event.eventName,
				},
				body: `agent-vm controller ${event.eventName}`,
				logName: 'agent_vm.controller.lifecycle',
				observedAtMs: event.observedAtMs,
				spanName: `agent_vm.controller.${event.eventName}`,
			});
		},
		shutdown: async () => {
			await driver.shutdown();
		},
	};
}

export function createControllerTelemetryResourceAttributes(options: {
	readonly identity: ControllerTelemetryIdentity;
	readonly projectNamespace: string;
	readonly stackMode: EnabledObservabilityRuntimeConfig['stackMode'];
}): TelemetryAttributes {
	return {
		'dev.branch.name': options.identity.branchName,
		'dev.release.channel':
			options.identity.releaseChannel ??
			inferReleaseChannel(options.projectNamespace, options.stackMode),
		'dev.repo.hash': stableTelemetryHash(options.identity.repositoryIdentity),
		'dev.runtime.flavor':
			options.identity.runtimeFlavor ?? inferRuntimeFlavor(options.projectNamespace),
		'dev.worktree.hash': stableTelemetryHash(options.identity.worktreeIdentity),
		'service.name': 'agent-vm-controller',
		'service.version': options.identity.serviceVersion,
	};
}

function formatCollectorHttpEndpoint(config: EnabledObservabilityRuntimeConfig): string {
	return `http://${formatHttpHost(config.bindAddress)}:${String(config.ports.collectorHttp)}`;
}

function shouldEmitHealthEventSpan(event: AgentVmHealthEvent): boolean {
	switch (event.kind) {
		case 'controller-request':
		case 'gateway-control-link':
		case 'gateway-recovery':
		case 'gateway-recovery-suspended':
		case 'lease-heartbeat':
		case 'lease-renew':
		case 'tool-vm-ssh':
			return true;
		case 'agent-channel-provider-health':
		case 'gateway-plugin-health':
		case 'gateway-service-health':
			return false;
		default:
			return assertNever(event);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled health event kind: ${JSON.stringify(value)}`);
}

function inferRuntimeFlavor(projectNamespace: string): string {
	return projectNamespace.toLowerCase().includes('beta') ? 'beta' : 'agent-vm';
}

function inferReleaseChannel(
	projectNamespace: string,
	stackMode: EnabledObservabilityRuntimeConfig['stackMode'],
): string {
	if (projectNamespace.toLowerCase().includes('beta')) {
		return 'beta';
	}
	return stackMode;
}

function createProofAttributes(
	proof: ControllerTelemetryProofAttributes | undefined,
): TelemetryAttributes {
	const attributes: Record<string, TelemetryAttributeValue> = {};
	if (proof?.marker) {
		attributes['agent.proof.marker'] = proof.marker;
	}
	if (proof?.startedAt) {
		attributes['agent.proof.started_at'] = proof.startedAt;
	}
	if (proof?.stateFile) {
		attributes['agent.proof.state_file_hash'] = stableTelemetryHash(proof.stateFile);
	}
	return attributes;
}
