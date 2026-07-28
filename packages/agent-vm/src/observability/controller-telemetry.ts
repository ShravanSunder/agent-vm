import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';

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
	readonly getDiagnostics?: (() => ControllerTelemetryDriverDiagnostics) | undefined;
	readonly shutdown: () => Promise<void>;
}

export interface ControllerTelemetryDriverDiagnostics {
	readonly admittedRecords: number;
	readonly derivedMaxAdmittedPayloadBytesPerSignal: number;
	readonly droppedOversizedRecords: number;
	readonly maxQueuedRecordsPerSignal: number;
	readonly maxRecordBytes: number;
	readonly providerOperationFailures: number;
	readonly signals: Readonly<
		Record<ControllerTelemetrySignalKind, ControllerTelemetrySignalAdmissionDiagnostics>
	>;
}

export type ControllerTelemetrySignalKind = 'logs' | 'metrics' | 'traces';

export interface ControllerTelemetrySignalAdmissionDiagnostics {
	readonly currentPayloadBytes: number;
	readonly currentRecords: number;
	readonly highWaterPayloadBytes: number;
	readonly highWaterRecords: number;
	readonly saturationDroppedRecords: number;
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
	readonly getDiagnostics?: (() => ControllerTelemetryDiagnostics) | undefined;
	readonly recordControllerLifecycleEvent: (event: ControllerLifecycleTelemetryEvent) => void;
	readonly shutdown: () => Promise<void>;
}

export interface ControllerTelemetryDiagnostics {
	readonly driver?: ControllerTelemetryDriverDiagnostics | undefined;
	readonly emissionFailures: number;
	readonly operationFailures: number;
	readonly operationTimeouts: number;
}

export const defaultControllerTelemetryDriverOperationTimeoutMs = 2_000;
export const OTEL_RESOURCE_ATTRIBUTES_ENVIRONMENT_VARIABLE = 'OTEL_RESOURCE_ATTRIBUTES' as const;

export interface StartControllerTelemetryOptions {
	readonly createDriver?:
		| ((options: ControllerTelemetryDriverOptions) => ControllerTelemetryDriver)
		| undefined;
	readonly driverOperationTimeoutMs?: number | undefined;
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
	const driverOperationTimeoutMs = resolveDriverOperationTimeoutMs(
		options.driverOperationTimeoutMs,
	);
	let emissionFailures = 0;
	let operationFailures = 0;
	let operationTimeouts = 0;
	let activeForceFlush: Promise<void> | undefined;
	let activeShutdown: Promise<void> | undefined;
	const emitWithoutAffectingProductMutation = (emit: () => void): void => {
		try {
			emit();
		} catch {
			emissionFailures += 1;
		}
	};

	const emitLog = (record: {
		readonly attributes: TelemetryAttributes;
		readonly body: string;
		readonly logName: string;
		readonly observedAtMs: number;
	}): void => {
		emitWithoutAffectingProductMutation(() => {
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
		emitWithoutAffectingProductMutation(() => {
			driver.emitSpan({
				attributes,
				name: record.spanName,
				observedAtMs: record.observedAtMs,
			});
		});
	};

	const getOrStartDriverOperation = (operationKind: 'forceFlush' | 'shutdown'): Promise<void> => {
		const activeOperation = operationKind === 'forceFlush' ? activeForceFlush : activeShutdown;
		if (activeOperation !== undefined) {
			return activeOperation;
		}
		const driverOperation = Promise.resolve()
			.then(operationKind === 'forceFlush' ? driver.forceFlush : driver.shutdown)
			.catch(() => {
				operationFailures += 1;
			});
		if (operationKind === 'forceFlush') {
			activeForceFlush = driverOperation;
		} else {
			activeShutdown = driverOperation;
		}
		void driverOperation.finally(() => {
			if (operationKind === 'forceFlush' && activeForceFlush === driverOperation) {
				activeForceFlush = undefined;
			}
			if (operationKind === 'shutdown' && activeShutdown === driverOperation) {
				activeShutdown = undefined;
			}
		});
		return driverOperation;
	};

	const settleDriverOperationWithinDeadline = async (
		operationKind: 'forceFlush' | 'shutdown',
	): Promise<void> => {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const driverOperation = getOrStartDriverOperation(operationKind);
		const deadline = new Promise<'timeout'>((resolve) => {
			timeout = setTimeout(() => resolve('timeout'), driverOperationTimeoutMs);
			timeout.unref?.();
		});
		try {
			const outcome = await Promise.race([
				driverOperation.then(() => 'settled' as const),
				deadline,
			]);
			if (outcome === 'timeout') {
				operationTimeouts += 1;
			}
		} finally {
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
		}
	};

	return {
		forceFlush: async () => {
			await settleDriverOperationWithinDeadline('forceFlush');
		},
		getDiagnostics: () => ({
			...(driver.getDiagnostics === undefined ? {} : { driver: driver.getDiagnostics() }),
			emissionFailures,
			operationFailures,
			operationTimeouts,
		}),
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
					emitWithoutAffectingProductMutation(() => {
						driver.emitSpan({
							attributes: {
								...telemetry.log.attributes,
								...proofAttributes,
							},
							name: `agent_vm.health.${event.kind}`,
							observedAtMs: event.observedAtMs,
						});
					});
				}
				for (const metricSample of telemetry.metricSamples) {
					emitWithoutAffectingProductMutation(() => {
						driver.emitMetric(metricSample);
					});
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
			await settleDriverOperationWithinDeadline('shutdown');
		},
	};
}

function resolveDriverOperationTimeoutMs(configuredTimeoutMs: number | undefined): number {
	const timeoutMs = configuredTimeoutMs ?? defaultControllerTelemetryDriverOperationTimeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			'Controller telemetry driver operation timeout must be a positive safe integer.',
		);
	}
	return timeoutMs;
}

export function createControllerTelemetryResourceAttributes(options: {
	readonly identity: ControllerTelemetryIdentity;
	readonly projectNamespace: string;
	readonly stackMode: EnabledObservabilityRuntimeConfig['stackMode'];
}): TelemetryAttributes {
	return {
		'dev.branch.name': options.identity.branchName,
		...createSharedDevelopmentTelemetryResourceAttributes(options),
		'service.name': 'agent-vm-controller',
		'service.version': options.identity.serviceVersion,
	};
}

export function createGatewayTelemetryResourceAttributesEnvironmentValue(options: {
	readonly identity: ControllerTelemetryIdentity;
	readonly projectNamespace: string;
	readonly stackMode: EnabledObservabilityRuntimeConfig['stackMode'];
}): string {
	return Object.entries(createSharedDevelopmentTelemetryResourceAttributes(options))
		.toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(
			([attributeName, attributeValue]) =>
				`${encodeURIComponent(attributeName)}=${encodeURIComponent(String(attributeValue))}`,
		)
		.join(',');
}

function createSharedDevelopmentTelemetryResourceAttributes(options: {
	readonly identity: ControllerTelemetryIdentity;
	readonly projectNamespace: string;
	readonly stackMode: EnabledObservabilityRuntimeConfig['stackMode'];
}): TelemetryAttributes {
	return {
		'dev.release.channel': normalizeTelemetryCategory(
			options.identity.releaseChannel,
			inferReleaseChannel(options.projectNamespace, options.stackMode),
		),
		'dev.repo.hash': stableTelemetryHash(options.identity.repositoryIdentity),
		'dev.runtime.flavor': normalizeTelemetryCategory(
			options.identity.runtimeFlavor,
			inferRuntimeFlavor(options.projectNamespace),
		),
		'dev.worktree.hash': stableTelemetryHash(options.identity.worktreeIdentity),
	};
}

function normalizeTelemetryCategory(value: string | undefined, fallback: string): string {
	const candidate = value ?? fallback;
	return /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(candidate) ? candidate : fallback;
}

function formatCollectorHttpEndpoint(config: EnabledObservabilityRuntimeConfig): string {
	return `http://${formatHttpHost(config.bindAddress)}:${String(config.ports.collectorHttp)}`;
}

function shouldEmitHealthEventSpan(event: AgentVmHealthEvent): boolean {
	switch (event.kind) {
		case 'controller-request':
		case 'gateway-control-session':
		case 'gateway-recovery':
		case 'gateway-recovery-suspended':
		case 'lease-heartbeat':
		case 'lease-renew':
		case 'tool-vm-ssh':
			return true;
		case 'agent-channel-provider-health':
		case 'caller-context-rejection':
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
