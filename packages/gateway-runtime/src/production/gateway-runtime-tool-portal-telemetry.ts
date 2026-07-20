import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';

import type { GatewayRuntimeTraceContext } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import type { ToolPortalBackendKind } from '@agent-vm/config-contracts';
import type { ToolPortalBackendPort } from '@agent-vm/tool-portal';
import {
	ROOT_CONTEXT,
	SpanKind,
	SpanStatusCode,
	TraceFlags,
	createTraceState,
	trace,
	type Attributes,
	type Context,
	type Span,
	type Tracer,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
	detectResources,
	envDetector,
	resourceFromAttributes,
	type Resource,
} from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

import {
	resolveGatewayRuntimeOperationGroup,
	type GatewayRuntimeSandboxDispatchRequest,
	type GatewayRuntimeTraceContextDispatch,
} from './gateway-runtime-private-uds-dispatcher.js';
import type { GatewayRuntimeToolPortalObservabilityConfig } from './gateway-runtime-service-config.js';

type GatewayRuntimeToolPortalTelemetrySignalKind = 'logs' | 'metrics' | 'traces';
type GatewayRuntimeToolPortalTelemetryResultClass = 'failure' | 'success';
type GatewayRuntimeToolPortalTelemetryBackendKind = ToolPortalBackendKind | 'none';

export interface GatewayRuntimeToolPortalTelemetryLogRecord {
	readonly attributes: Readonly<Record<string, string>>;
	readonly name: string;
	readonly observedAtMs: number;
}

export interface GatewayRuntimeToolPortalTelemetryMetricRecord {
	readonly attributes: Readonly<Record<string, string>>;
	readonly name: string;
	readonly observedAtMs: number;
	readonly value: number;
}

export interface GatewayRuntimeToolPortalTelemetryProvider {
	readonly emitLog: (record: GatewayRuntimeToolPortalTelemetryLogRecord) => void;
	readonly emitMetric: (record: GatewayRuntimeToolPortalTelemetryMetricRecord) => void;
	readonly forceFlush: (signalKind: GatewayRuntimeToolPortalTelemetrySignalKind) => Promise<void>;
	readonly shutdown: () => Promise<void>;
	readonly tracer: Tracer;
}

export interface GatewayRuntimeToolPortalTelemetryProviderFactoryOptions {
	readonly admissionLimits: Extract<
		GatewayRuntimeToolPortalObservabilityConfig,
		{ readonly kind: 'otlp-http' }
	>['admissionLimits'];
	readonly config: Extract<
		GatewayRuntimeToolPortalObservabilityConfig,
		{ readonly kind: 'otlp-http' }
	>;
}

export type GatewayRuntimeToolPortalTelemetryProviderFactory = (
	options: GatewayRuntimeToolPortalTelemetryProviderFactoryOptions,
) => GatewayRuntimeToolPortalTelemetryProvider;

interface GatewayRuntimeToolPortalTelemetrySignalAdmissionDiagnostics {
	readonly currentPayloadBytes: number;
	readonly currentRecords: number;
	readonly highWaterPayloadBytes: number;
	readonly highWaterRecords: number;
	readonly saturationDroppedRecords: number;
}

export interface GatewayRuntimeToolPortalTelemetryDiagnostics {
	readonly admittedRecords: number;
	readonly derivedMaxAdmittedPayloadBytesPerSignal: number;
	readonly droppedOversizedRecords: number;
	readonly providerOperationFailures: number;
	readonly signals: Readonly<
		Record<
			GatewayRuntimeToolPortalTelemetrySignalKind,
			GatewayRuntimeToolPortalTelemetrySignalAdmissionDiagnostics
		>
	>;
}

export interface GatewayRuntimeToolPortalTelemetryRuntime {
	readonly getDiagnostics: () => GatewayRuntimeToolPortalTelemetryDiagnostics;
	readonly shutdown: () => Promise<void>;
	readonly traceContextDispatch: GatewayRuntimeTraceContextDispatch;
	readonly wrapBackendPort: <TBackendKind extends ToolPortalBackendKind>(
		backendPort: ToolPortalBackendPort<TBackendKind>,
	) => ToolPortalBackendPort<TBackendKind>;
	readonly wrapSandboxDispatch: (
		dispatch: (request: GatewayRuntimeSandboxDispatchRequest) => Promise<unknown>,
	) => (request: GatewayRuntimeSandboxDispatchRequest) => Promise<unknown>;
}

export interface CreateGatewayRuntimeToolPortalTelemetryRuntimeProps {
	readonly config: GatewayRuntimeToolPortalObservabilityConfig;
	readonly now?: () => number;
	readonly providerFactory?: GatewayRuntimeToolPortalTelemetryProviderFactory;
}

interface MutableSignalAdmissionState {
	currentPayloadBytes: number;
	currentRecords: number;
	highWaterPayloadBytes: number;
	highWaterRecords: number;
	saturationDroppedRecords: number;
}

interface ActiveUdsTelemetryContext {
	readonly operationGroup: string;
	readonly spanContext: Context;
}

interface CompletionSignalOptions {
	readonly backendKind: GatewayRuntimeToolPortalTelemetryBackendKind;
	readonly durationMs: number;
	readonly operationGroup: string;
	readonly resultClass: GatewayRuntimeToolPortalTelemetryResultClass;
	readonly surface: 'backend' | 'uds';
}

const instrumentationName = 'agent-vm-tool-portal';
const telemetrySpanNames = {
	backend: 'gateway_runtime.backend.request',
	uds: 'gateway_runtime.uds.request',
} as const;
const telemetryLogNames = {
	backend: 'tool_portal.backend.completed',
	lifecycleStarted: 'tool_portal.telemetry.started',
	lifecycleStopped: 'tool_portal.telemetry.stopped',
	uds: 'tool_portal.uds.completed',
} as const;

function joinEndpointPath(endpoint: string, signalPath: string): string {
	return `${endpoint.replace(/\/+$/u, '')}${signalPath}`;
}

export function createGatewayRuntimeToolPortalTelemetryResource(
	config: Extract<GatewayRuntimeToolPortalObservabilityConfig, { readonly kind: 'otlp-http' }>,
): Resource {
	return detectResources({ detectors: [envDetector] }).merge(
		resourceFromAttributes({ 'service.name': config.serviceName }),
	);
}

function createDefaultTelemetryProvider(
	options: GatewayRuntimeToolPortalTelemetryProviderFactoryOptions,
): GatewayRuntimeToolPortalTelemetryProvider {
	const { config } = options;
	const resource = createGatewayRuntimeToolPortalTelemetryResource(config);
	const loggerProvider = new LoggerProvider({
		processors: [
			new BatchLogRecordProcessor(
				new OTLPLogExporter({ url: joinEndpointPath(config.endpoint, '/v1/logs') }),
				{
					exportTimeoutMillis: 5_000,
					maxExportBatchSize: config.admissionLimits.maxExportBatchRecords,
					maxQueueSize: config.admissionLimits.maxQueuedRecordsPerSignal,
					scheduledDelayMillis: config.flushIntervalMs,
				},
			),
		],
		resource,
	});
	const metricReader = new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter({ url: joinEndpointPath(config.endpoint, '/v1/metrics') }),
		exportIntervalMillis: config.flushIntervalMs,
		exportTimeoutMillis: Math.min(5_000, config.flushIntervalMs),
	});
	const meterProvider = new MeterProvider({ readers: [metricReader], resource });
	const tracerProvider = new BasicTracerProvider({
		resource,
		sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRate) }),
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({ url: joinEndpointPath(config.endpoint, '/v1/traces') }),
				{
					exportTimeoutMillis: 5_000,
					maxExportBatchSize: config.admissionLimits.maxExportBatchRecords,
					maxQueueSize: config.admissionLimits.maxQueuedRecordsPerSignal,
					scheduledDelayMillis: config.flushIntervalMs,
				},
			),
		],
	});
	const logger = loggerProvider.getLogger(instrumentationName);
	const meter = meterProvider.getMeter(instrumentationName);
	const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
	const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();

	return {
		emitLog: (record): void => {
			logger.emit({
				attributes: record.attributes,
				body: record.name,
				eventName: record.name,
				observedTimestamp: record.observedAtMs,
				severityNumber: SeverityNumber.INFO,
				severityText: 'INFO',
			});
		},
		emitMetric: (record): void => {
			if (record.name.endsWith('_total')) {
				let counter = counters.get(record.name);
				if (counter === undefined) {
					counter = meter.createCounter(record.name);
					counters.set(record.name, counter);
				}
				counter.add(record.value, record.attributes);
				return;
			}
			let histogram = histograms.get(record.name);
			if (histogram === undefined) {
				histogram = meter.createHistogram(record.name);
				histograms.set(record.name, histogram);
			}
			histogram.record(record.value, record.attributes);
		},
		forceFlush: async (signalKind): Promise<void> => {
			if (signalKind === 'logs') await loggerProvider.forceFlush();
			if (signalKind === 'metrics') await meterProvider.forceFlush();
			if (signalKind === 'traces') await tracerProvider.forceFlush();
		},
		shutdown: async (): Promise<void> => {
			const results = await Promise.allSettled([
				loggerProvider.shutdown(),
				meterProvider.shutdown(),
				tracerProvider.shutdown(),
			]);
			const failures = results.filter((result) => result.status === 'rejected');
			if (failures.length > 0) {
				throw new Error('Tool Portal telemetry providers failed to shut down.');
			}
		},
		tracer: tracerProvider.getTracer(instrumentationName),
	};
}

function createSignalAdmissionState(): MutableSignalAdmissionState {
	return {
		currentPayloadBytes: 0,
		currentRecords: 0,
		highWaterPayloadBytes: 0,
		highWaterRecords: 0,
		saturationDroppedRecords: 0,
	};
}

function snapshotSignalAdmission(
	state: MutableSignalAdmissionState,
): GatewayRuntimeToolPortalTelemetrySignalAdmissionDiagnostics {
	return { ...state };
}

function boundedAttributes(options: {
	readonly backendKind: GatewayRuntimeToolPortalTelemetryBackendKind;
	readonly operationGroup: string;
	readonly resultClass?: GatewayRuntimeToolPortalTelemetryResultClass;
}): Readonly<Record<string, string>> {
	return Object.freeze({
		'agent_vm.backend_kind': options.backendKind,
		'agent_vm.operation_group': options.operationGroup,
		...(options.resultClass === undefined ? {} : { 'agent_vm.result_class': options.resultClass }),
	});
}

function remoteParentContext(
	traceContext: GatewayRuntimeTraceContext | undefined,
): Context | undefined {
	if (traceContext === undefined) return undefined;
	const traceparent = traceContext.traceparent;
	const traceFlagsHex = traceparent.slice(53, 55);
	return trace.setSpanContext(ROOT_CONTEXT, {
		isRemote: true,
		spanId: traceparent.slice(36, 52),
		traceFlags:
			(Number.parseInt(traceFlagsHex, 16) & 1) === 1 ? TraceFlags.SAMPLED : TraceFlags.NONE,
		traceId: traceparent.slice(3, 35),
		...(traceContext.tracestate === undefined
			? {}
			: { traceState: createTraceState(traceContext.tracestate) }),
	});
}

function disabledTelemetryRuntime(): GatewayRuntimeToolPortalTelemetryRuntime {
	return {
		getDiagnostics: () => ({
			admittedRecords: 0,
			derivedMaxAdmittedPayloadBytesPerSignal: 0,
			droppedOversizedRecords: 0,
			providerOperationFailures: 0,
			signals: {
				logs: createSignalAdmissionState(),
				metrics: createSignalAdmissionState(),
				traces: createSignalAdmissionState(),
			},
		}),
		shutdown: async (): Promise<void> => undefined,
		traceContextDispatch: async (_options, dispatch) => await dispatch(),
		wrapBackendPort: (backendPort) => backendPort,
		wrapSandboxDispatch: (dispatch) => dispatch,
	};
}

export function createGatewayRuntimeToolPortalTelemetryRuntime(
	props: CreateGatewayRuntimeToolPortalTelemetryRuntimeProps,
): GatewayRuntimeToolPortalTelemetryRuntime {
	if (props.config.kind === 'disabled') return disabledTelemetryRuntime();

	const config = props.config;
	const now = props.now ?? Date.now;
	const provider = (props.providerFactory ?? createDefaultTelemetryProvider)({
		admissionLimits: config.admissionLimits,
		config,
	});
	const activeUdsContext = new AsyncLocalStorage<ActiveUdsTelemetryContext>();
	const signalAdmission = {
		logs: createSignalAdmissionState(),
		metrics: createSignalAdmissionState(),
		traces: createSignalAdmissionState(),
	} satisfies Record<GatewayRuntimeToolPortalTelemetrySignalKind, MutableSignalAdmissionState>;
	let admittedRecords = 0;
	let droppedOversizedRecords = 0;
	let providerOperationFailures = 0;
	let scheduledFlush: NodeJS.Timeout | undefined;
	let activeFlush: Promise<void> | undefined;
	let shutdownPromise: Promise<void> | undefined;
	let shutdownStarted = false;

	const getDiagnostics = (): GatewayRuntimeToolPortalTelemetryDiagnostics => ({
		admittedRecords,
		derivedMaxAdmittedPayloadBytesPerSignal:
			config.admissionLimits.maxQueuedRecordsPerSignal * config.admissionLimits.maxRecordBytes,
		droppedOversizedRecords,
		providerOperationFailures,
		signals: {
			logs: snapshotSignalAdmission(signalAdmission.logs),
			metrics: snapshotSignalAdmission(signalAdmission.metrics),
			traces: snapshotSignalAdmission(signalAdmission.traces),
		},
	});

	const flushAdmittedSignals = (): Promise<void> => {
		if (activeFlush !== undefined) return activeFlush;
		if (scheduledFlush !== undefined) {
			clearTimeout(scheduledFlush);
			scheduledFlush = undefined;
		}
		const admissionSnapshot = {
			logs: snapshotSignalAdmission(signalAdmission.logs),
			metrics: snapshotSignalAdmission(signalAdmission.metrics),
			traces: snapshotSignalAdmission(signalAdmission.traces),
		};
		const flush = Promise.all(
			(['logs', 'metrics', 'traces'] as const).map(async (signalKind) => {
				try {
					await provider.forceFlush(signalKind);
					const signalState = signalAdmission[signalKind];
					const flushedState = admissionSnapshot[signalKind];
					signalState.currentPayloadBytes = Math.max(
						0,
						signalState.currentPayloadBytes - flushedState.currentPayloadBytes,
					);
					signalState.currentRecords = Math.max(
						0,
						signalState.currentRecords - flushedState.currentRecords,
					);
				} catch {
					providerOperationFailures += 1;
				}
			}),
		).then(() => undefined);
		activeFlush = flush;
		void flush.finally(() => {
			if (activeFlush === flush) activeFlush = undefined;
			if (
				!shutdownStarted &&
				Object.values(signalAdmission).some((signalState) => signalState.currentRecords > 0)
			) {
				scheduleFlush();
			}
		});
		return flush;
	};

	const scheduleFlush = (): void => {
		if (shutdownStarted || scheduledFlush !== undefined || activeFlush !== undefined) return;
		scheduledFlush = setTimeout(() => {
			scheduledFlush = undefined;
			void flushAdmittedSignals();
		}, config.flushIntervalMs);
		scheduledFlush.unref?.();
	};

	const admitRecord = (
		signalKind: GatewayRuntimeToolPortalTelemetrySignalKind,
		record: unknown,
	): boolean => {
		let recordBytes: number;
		try {
			recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
		} catch {
			droppedOversizedRecords += 1;
			return false;
		}
		if (recordBytes > config.admissionLimits.maxRecordBytes) {
			droppedOversizedRecords += 1;
			return false;
		}
		const state = signalAdmission[signalKind];
		const maximumPayloadBytes =
			config.admissionLimits.maxQueuedRecordsPerSignal * config.admissionLimits.maxRecordBytes;
		if (
			state.currentRecords >= config.admissionLimits.maxQueuedRecordsPerSignal ||
			state.currentPayloadBytes + recordBytes > maximumPayloadBytes
		) {
			state.saturationDroppedRecords += 1;
			return false;
		}
		admittedRecords += 1;
		state.currentPayloadBytes += recordBytes;
		state.currentRecords += 1;
		state.highWaterPayloadBytes = Math.max(state.highWaterPayloadBytes, state.currentPayloadBytes);
		state.highWaterRecords = Math.max(state.highWaterRecords, state.currentRecords);
		scheduleFlush();
		return true;
	};

	const emitLog = (record: GatewayRuntimeToolPortalTelemetryLogRecord): void => {
		if (!config.logs || !admitRecord('logs', record)) return;
		try {
			provider.emitLog(record);
		} catch {
			providerOperationFailures += 1;
		}
	};
	const emitMetric = (record: GatewayRuntimeToolPortalTelemetryMetricRecord): void => {
		if (!config.metrics || !admitRecord('metrics', record)) return;
		try {
			provider.emitMetric(record);
		} catch {
			providerOperationFailures += 1;
		}
	};
	const startSpan = (options: {
		readonly backendKind: GatewayRuntimeToolPortalTelemetryBackendKind;
		readonly kind: SpanKind;
		readonly name: string;
		readonly operationGroup: string;
		readonly parentContext: Context | undefined;
		readonly surface: 'backend' | 'uds';
		readonly startTimeMs: number;
	}): Span | undefined => {
		const attributes = boundedAttributes({
			backendKind: options.backendKind,
			operationGroup: options.operationGroup,
		});
		if (
			!config.traces ||
			!admitRecord('traces', {
				attributes,
				kind: options.kind,
				name: options.name,
				observedAtMs: options.startTimeMs,
			})
		) {
			return undefined;
		}
		try {
			return provider.tracer.startSpan(
				options.name,
				{
					attributes: attributes satisfies Attributes,
					kind: options.kind,
					startTime: options.startTimeMs,
				},
				options.parentContext ?? ROOT_CONTEXT,
			);
		} catch {
			providerOperationFailures += 1;
			return undefined;
		}
	};

	const emitCompletionSignals = (options: CompletionSignalOptions): void => {
		const attributes = boundedAttributes({
			backendKind: options.backendKind,
			operationGroup: options.operationGroup,
			resultClass: options.resultClass,
		});
		const observedAtMs = now();
		emitLog({
			attributes,
			name: telemetryLogNames[options.surface],
			observedAtMs,
		});
		emitMetric({
			attributes,
			name: 'agent_vm.tool_portal.operations_total',
			observedAtMs,
			value: 1,
		});
		emitMetric({
			attributes,
			name: 'agent_vm.tool_portal.operation.duration_ms',
			observedAtMs,
			value: Math.max(0, options.durationMs),
		});
	};

	const traceDispatch = async <TResult>(options: {
		readonly backendKind: GatewayRuntimeToolPortalTelemetryBackendKind;
		readonly dispatch: () => Promise<TResult>;
		readonly kind: SpanKind;
		readonly operationGroup: string;
		readonly parentContext: Context | undefined;
		readonly surface: 'backend' | 'uds';
	}): Promise<TResult> => {
		const startedAtMs = now();
		const span = startSpan({
			backendKind: options.backendKind,
			kind: options.kind,
			name: telemetrySpanNames[options.surface],
			operationGroup: options.operationGroup,
			parentContext: options.parentContext,
			startTimeMs: startedAtMs,
			surface: options.surface,
		});
		let resultClass: GatewayRuntimeToolPortalTelemetryResultClass = 'success';
		try {
			return await options.dispatch();
		} catch (error: unknown) {
			resultClass = 'failure';
			throw error;
		} finally {
			const finishedAtMs = now();
			if (span !== undefined) {
				try {
					span.setAttribute('agent_vm.result_class', resultClass);
					span.setStatus({
						code: resultClass === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
					});
					span.end(finishedAtMs);
				} catch {
					providerOperationFailures += 1;
				}
			}
			emitCompletionSignals({
				backendKind: options.backendKind,
				durationMs: finishedAtMs - startedAtMs,
				operationGroup: options.operationGroup,
				resultClass,
				surface: options.surface,
			});
		}
	};

	const traceBackendDispatch = async <TResult>(
		backendKind: ToolPortalBackendKind,
		dispatch: () => Promise<TResult>,
	): Promise<TResult> => {
		const udsContext = activeUdsContext.getStore();
		return await traceDispatch({
			backendKind,
			dispatch,
			kind: SpanKind.INTERNAL,
			operationGroup: udsContext?.operationGroup ?? 'portal',
			parentContext: udsContext?.spanContext,
			surface: 'backend',
		});
	};

	const traceContextDispatch: GatewayRuntimeTraceContextDispatch = async (options, dispatch) => {
		const operationGroup = resolveGatewayRuntimeOperationGroup(options.method) ?? 'unknown';
		const parentContext = remoteParentContext(options.traceContext);
		const startedAtMs = now();
		const span = startSpan({
			backendKind: 'none',
			kind: SpanKind.SERVER,
			name: telemetrySpanNames.uds,
			operationGroup,
			parentContext,
			startTimeMs: startedAtMs,
			surface: 'uds',
		});
		const udsSpanContext =
			span === undefined ? (parentContext ?? ROOT_CONTEXT) : trace.setSpan(ROOT_CONTEXT, span);
		let resultClass: GatewayRuntimeToolPortalTelemetryResultClass = 'success';
		try {
			return await activeUdsContext.run({ operationGroup, spanContext: udsSpanContext }, dispatch);
		} catch (error: unknown) {
			resultClass = 'failure';
			throw error;
		} finally {
			const finishedAtMs = now();
			if (span !== undefined) {
				try {
					span.setAttribute('agent_vm.result_class', resultClass);
					span.setStatus({
						code: resultClass === 'success' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
					});
					span.end(finishedAtMs);
				} catch {
					providerOperationFailures += 1;
				}
			}
			emitCompletionSignals({
				backendKind: 'none',
				durationMs: finishedAtMs - startedAtMs,
				operationGroup,
				resultClass,
				surface: 'uds',
			});
		}
	};

	const wrapBackendPort = <TBackendKind extends ToolPortalBackendKind>(
		backendPort: ToolPortalBackendPort<TBackendKind>,
	): ToolPortalBackendPort<TBackendKind> => ({
		backendKind: backendPort.backendKind,
		call: async (request, options) =>
			await traceBackendDispatch(
				backendPort.backendKind,
				async () => await backendPort.call(request, options),
			),
		describe: async (request, options) =>
			await traceBackendDispatch(
				backendPort.backendKind,
				async () => await backendPort.describe(request, options),
			),
		list: async (request, options) =>
			await traceBackendDispatch(
				backendPort.backendKind,
				async () => await backendPort.list(request, options),
			),
		search: async (request, options) =>
			await traceBackendDispatch(
				backendPort.backendKind,
				async () => await backendPort.search(request, options),
			),
	});

	emitLog({
		attributes: boundedAttributes({
			backendKind: 'none',
			operationGroup: 'lifecycle',
			resultClass: 'success',
		}),
		name: telemetryLogNames.lifecycleStarted,
		observedAtMs: now(),
	});

	return {
		getDiagnostics,
		shutdown: (): Promise<void> => {
			shutdownPromise ??= (async (): Promise<void> => {
				shutdownStarted = true;
				if (scheduledFlush !== undefined) {
					clearTimeout(scheduledFlush);
					scheduledFlush = undefined;
				}
				emitLog({
					attributes: boundedAttributes({
						backendKind: 'none',
						operationGroup: 'lifecycle',
						resultClass: 'success',
					}),
					name: telemetryLogNames.lifecycleStopped,
					observedAtMs: now(),
				});
				await flushAdmittedSignals();
				try {
					await provider.shutdown();
				} catch {
					providerOperationFailures += 1;
				}
			})();
			return shutdownPromise;
		},
		traceContextDispatch,
		wrapBackendPort,
		wrapSandboxDispatch: (dispatch) => async (request) =>
			await traceBackendDispatch('tool_vm_runner', async () => await dispatch(request)),
	};
}
