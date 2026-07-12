import { Buffer } from 'node:buffer';

import type { Attributes } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

import type {
	ControllerTelemetryDriver,
	ControllerTelemetryDriverDiagnostics,
	ControllerTelemetryDriverOptions,
	ControllerTelemetryLogRecord,
	ControllerTelemetryMetricRecord,
	ControllerTelemetrySignalAdmissionDiagnostics,
	ControllerTelemetrySignalKind,
	ControllerTelemetrySpanRecord,
} from './controller-telemetry.js';
import type { TelemetryAttributes } from './health-event-telemetry.js';

interface OtelLoggerLike {
	readonly emit: (record: ControllerTelemetryLogRecord) => void;
}

interface OtelLoggerProviderLike {
	readonly forceFlush: () => Promise<void>;
	readonly getLogger: (name: string, version: string) => OtelLoggerLike;
	readonly shutdown: () => Promise<void>;
}

interface OtelCounterLike {
	readonly add: (value: number, attributes: TelemetryAttributes) => void;
}

interface OtelHistogramLike {
	readonly record: (value: number, attributes: TelemetryAttributes) => void;
}

interface OtelMeterLike {
	readonly createCounter: (name: string) => OtelCounterLike;
	readonly createHistogram: (name: string) => OtelHistogramLike;
}

interface OtelMeterProviderLike {
	readonly forceFlush: () => Promise<void>;
	readonly getMeter: (name: string, version: string) => OtelMeterLike;
	readonly shutdown: () => Promise<void>;
}

interface OtelSpanLike {
	readonly end: (endTime: number) => void;
}

interface OtelTracerLike {
	readonly startSpan: (
		name: string,
		options: { readonly attributes: TelemetryAttributes; readonly startTime: number },
	) => OtelSpanLike;
}

interface OtelTracerProviderLike {
	readonly forceFlush: () => Promise<void>;
	readonly getTracer: (name: string, version: string) => OtelTracerLike;
	readonly shutdown: () => Promise<void>;
}

export interface OtelControllerTelemetryProviderFactoryOptions {
	readonly admissionLimits: OtelControllerTelemetryAdmissionLimits;
	readonly logsUrl: string;
	readonly metricsUrl: string;
	readonly resourceAttributes: TelemetryAttributes;
	readonly tracesUrl: string;
}

export interface OtelControllerTelemetryAdmissionLimits {
	readonly maxExportBatchRecords: number;
	readonly maxQueuedRecordsPerSignal: number;
	readonly maxRecordBytes: number;
}

export const defaultOtelControllerTelemetryAdmissionLimits = {
	maxExportBatchRecords: 64,
	maxQueuedRecordsPerSignal: 256,
	maxRecordBytes: 64 * 1_024,
} as const satisfies OtelControllerTelemetryAdmissionLimits;

const controllerTelemetryAdmissionFlushIntervalMs = 1_000;

interface MutableSignalAdmissionState {
	currentPayloadBytes: number;
	currentRecords: number;
	highWaterPayloadBytes: number;
	highWaterRecords: number;
	saturationDroppedRecords: number;
}

export type OtelControllerTelemetryProviderFactory = (
	options: OtelControllerTelemetryProviderFactoryOptions,
) => {
	readonly loggerProvider: OtelLoggerProviderLike;
	readonly meterProvider: OtelMeterProviderLike;
	readonly tracerProvider: OtelTracerProviderLike;
};

const instrumentationName = 'agent-vm-controller';

export function createOtelControllerTelemetryDriver(
	options: ControllerTelemetryDriverOptions,
	providerFactory: OtelControllerTelemetryProviderFactory = createDefaultOtelProviders,
	admissionOverrides?: Partial<OtelControllerTelemetryAdmissionLimits>,
): ControllerTelemetryDriver {
	const admissionLimits = resolveOtelAdmissionLimits(admissionOverrides);
	const serviceVersion =
		typeof options.resourceAttributes['service.version'] === 'string'
			? options.resourceAttributes['service.version']
			: '0.0.0';
	const providers = providerFactory({
		admissionLimits,
		logsUrl: joinEndpointPath(options.endpoint, '/v1/logs'),
		metricsUrl: joinEndpointPath(options.endpoint, '/v1/metrics'),
		resourceAttributes: options.resourceAttributes,
		tracesUrl: joinEndpointPath(options.endpoint, '/v1/traces'),
	});
	const logger = providers.loggerProvider.getLogger(instrumentationName, serviceVersion);
	const meter = providers.meterProvider.getMeter(instrumentationName, serviceVersion);
	const tracer = providers.tracerProvider.getTracer(instrumentationName, serviceVersion);
	const counters = new Map<string, OtelCounterLike>();
	const histograms = new Map<string, OtelHistogramLike>();
	let admittedRecords = 0;
	let droppedOversizedRecords = 0;
	let providerOperationFailures = 0;
	const signalAdmission = {
		logs: createSignalAdmissionState(),
		metrics: createSignalAdmissionState(),
		traces: createSignalAdmissionState(),
	} satisfies Record<ControllerTelemetrySignalKind, MutableSignalAdmissionState>;
	let scheduledAdmissionFlush: ReturnType<typeof setTimeout> | undefined;
	let activeAdmissionFlush: Promise<void> | undefined;
	let shutdownStarted = false;
	const admitRecord = (
		signalKind: ControllerTelemetrySignalKind,
		record:
			| ControllerTelemetryLogRecord
			| ControllerTelemetryMetricRecord
			| ControllerTelemetrySpanRecord,
	): boolean => {
		let recordBytes: number;
		try {
			recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
		} catch {
			droppedOversizedRecords += 1;
			return false;
		}
		if (recordBytes > admissionLimits.maxRecordBytes) {
			droppedOversizedRecords += 1;
			return false;
		}
		const signalState = signalAdmission[signalKind];
		const maxSignalPayloadBytes =
			admissionLimits.maxQueuedRecordsPerSignal * admissionLimits.maxRecordBytes;
		if (
			signalState.currentRecords >= admissionLimits.maxQueuedRecordsPerSignal ||
			signalState.currentPayloadBytes + recordBytes > maxSignalPayloadBytes
		) {
			signalState.saturationDroppedRecords += 1;
			return false;
		}
		admittedRecords += 1;
		signalState.currentPayloadBytes += recordBytes;
		signalState.currentRecords += 1;
		signalState.highWaterPayloadBytes = Math.max(
			signalState.highWaterPayloadBytes,
			signalState.currentPayloadBytes,
		);
		signalState.highWaterRecords = Math.max(
			signalState.highWaterRecords,
			signalState.currentRecords,
		);
		return true;
	};
	const getDiagnostics = (): ControllerTelemetryDriverDiagnostics => ({
		admittedRecords,
		derivedMaxAdmittedPayloadBytesPerSignal:
			admissionLimits.maxQueuedRecordsPerSignal * admissionLimits.maxRecordBytes,
		droppedOversizedRecords,
		maxQueuedRecordsPerSignal: admissionLimits.maxQueuedRecordsPerSignal,
		maxRecordBytes: admissionLimits.maxRecordBytes,
		providerOperationFailures,
		signals: {
			logs: snapshotSignalAdmission(signalAdmission.logs),
			metrics: snapshotSignalAdmission(signalAdmission.metrics),
			traces: snapshotSignalAdmission(signalAdmission.traces),
		},
	});
	const scheduleAdmissionFlush = (): void => {
		if (
			shutdownStarted ||
			scheduledAdmissionFlush !== undefined ||
			activeAdmissionFlush !== undefined
		) {
			return;
		}
		scheduledAdmissionFlush = setTimeout(() => {
			scheduledAdmissionFlush = undefined;
			void flushAdmittedSignals();
		}, controllerTelemetryAdmissionFlushIntervalMs);
		scheduledAdmissionFlush.unref?.();
	};
	const flushAdmittedSignals = (): Promise<void> => {
		if (activeAdmissionFlush !== undefined) {
			return activeAdmissionFlush;
		}
		if (scheduledAdmissionFlush !== undefined) {
			clearTimeout(scheduledAdmissionFlush);
			scheduledAdmissionFlush = undefined;
		}
		const admissionSnapshot = snapshotAllSignalAdmission(signalAdmission);
		const flush = settleTelemetryProviderOperations([
			{ operation: () => providers.loggerProvider.forceFlush(), signalKind: 'logs' },
			{ operation: () => providers.meterProvider.forceFlush(), signalKind: 'metrics' },
			{ operation: () => providers.tracerProvider.forceFlush(), signalKind: 'traces' },
		]).then((results) => {
			for (const result of results) {
				if (result.status === 'fulfilled') {
					releaseFlushedAdmission(
						signalAdmission[result.signalKind],
						admissionSnapshot[result.signalKind],
					);
				} else {
					providerOperationFailures += 1;
				}
			}
		});
		activeAdmissionFlush = flush;
		void flush.finally(() => {
			if (activeAdmissionFlush === flush) {
				activeAdmissionFlush = undefined;
			}
			if (hasPendingSignalAdmission(signalAdmission)) {
				scheduleAdmissionFlush();
			}
		});
		return flush;
	};

	return {
		emitLog: (record) => {
			if (!admitRecord('logs', record)) {
				return;
			}
			scheduleAdmissionFlush();
			logger.emit(record);
		},
		emitMetric: (record) => {
			if (!admitRecord('metrics', record)) {
				return;
			}
			scheduleAdmissionFlush();
			if (record.name.endsWith('_total')) {
				getOrCreateCounter(counters, meter, record.name).add(record.value, record.attributes);
				return;
			}
			getOrCreateHistogram(histograms, meter, record.name).record(record.value, record.attributes);
		},
		emitSpan: (record) => {
			if (!admitRecord('traces', record)) {
				return;
			}
			scheduleAdmissionFlush();
			const span = tracer.startSpan(record.name, {
				attributes: record.attributes,
				startTime: record.observedAtMs,
			});
			span.end(record.observedAtMs);
		},
		forceFlush: async () => {
			await flushAdmittedSignals();
		},
		getDiagnostics,
		shutdown: async () => {
			shutdownStarted = true;
			if (scheduledAdmissionFlush !== undefined) {
				clearTimeout(scheduledAdmissionFlush);
				scheduledAdmissionFlush = undefined;
			}
			providerOperationFailures += await countFailedTelemetryProviderOperations([
				() => providers.loggerProvider.shutdown(),
				() => providers.meterProvider.shutdown(),
				() => providers.tracerProvider.shutdown(),
			]);
		},
	};
}

interface TelemetryProviderOperation {
	readonly operation: () => Promise<void>;
	readonly signalKind: ControllerTelemetrySignalKind;
}

type TelemetryProviderOperationResult =
	| { readonly signalKind: ControllerTelemetrySignalKind; readonly status: 'fulfilled' }
	| { readonly signalKind: ControllerTelemetrySignalKind; readonly status: 'rejected' };

async function settleTelemetryProviderOperations(
	operations: readonly TelemetryProviderOperation[],
): Promise<readonly TelemetryProviderOperationResult[]> {
	return await Promise.all(
		operations.map(async ({ operation, signalKind }) => {
			try {
				await operation();
				return { signalKind, status: 'fulfilled' } as const;
			} catch {
				return { signalKind, status: 'rejected' } as const;
			}
		}),
	);
}

async function countFailedTelemetryProviderOperations(
	operations: readonly (() => Promise<void>)[],
): Promise<number> {
	const results = await Promise.allSettled(operations.map(async (operation) => await operation()));
	return results.filter((result) => result.status === 'rejected').length;
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
): ControllerTelemetrySignalAdmissionDiagnostics {
	return { ...state };
}

function snapshotAllSignalAdmission(
	states: Record<ControllerTelemetrySignalKind, MutableSignalAdmissionState>,
): Record<ControllerTelemetrySignalKind, ControllerTelemetrySignalAdmissionDiagnostics> {
	return {
		logs: snapshotSignalAdmission(states.logs),
		metrics: snapshotSignalAdmission(states.metrics),
		traces: snapshotSignalAdmission(states.traces),
	};
}

function releaseFlushedAdmission(
	state: MutableSignalAdmissionState,
	flushed: ControllerTelemetrySignalAdmissionDiagnostics,
): void {
	state.currentPayloadBytes = Math.max(0, state.currentPayloadBytes - flushed.currentPayloadBytes);
	state.currentRecords = Math.max(0, state.currentRecords - flushed.currentRecords);
}

function hasPendingSignalAdmission(
	states: Record<ControllerTelemetrySignalKind, MutableSignalAdmissionState>,
): boolean {
	return Object.values(states).some((state) => state.currentRecords > 0);
}

function createDefaultOtelProviders(
	options: OtelControllerTelemetryProviderFactoryOptions,
): ReturnType<OtelControllerTelemetryProviderFactory> {
	const resource = resourceFromAttributes(toOtelAttributes(options.resourceAttributes));
	const loggerProvider = new LoggerProvider({
		processors: [
			new BatchLogRecordProcessor(new OTLPLogExporter({ url: options.logsUrl }), {
				exportTimeoutMillis: 5_000,
				maxExportBatchSize: options.admissionLimits.maxExportBatchRecords,
				maxQueueSize: options.admissionLimits.maxQueuedRecordsPerSignal,
				scheduledDelayMillis: 1_000,
			}),
		],
		resource,
	});
	const metricReader = new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter({ url: options.metricsUrl }),
		exportIntervalMillis: 5_000,
		exportTimeoutMillis: 5_000,
	});
	const meterProvider = new MeterProvider({
		readers: [metricReader],
		resource,
	});
	const tracerProvider = new BasicTracerProvider({
		resource,
		spanProcessors: [
			new BatchSpanProcessor(new OTLPTraceExporter({ url: options.tracesUrl }), {
				exportTimeoutMillis: 5_000,
				maxExportBatchSize: options.admissionLimits.maxExportBatchRecords,
				maxQueueSize: options.admissionLimits.maxQueuedRecordsPerSignal,
				scheduledDelayMillis: 1_000,
			}),
		],
	});

	return {
		loggerProvider: {
			forceFlush: async () => {
				await loggerProvider.forceFlush();
			},
			getLogger: (name, version) => {
				const logger = loggerProvider.getLogger(name, version);
				return {
					emit: (record) => {
						logger.emit({
							attributes: toOtelAttributes(record.attributes),
							body: record.body,
							eventName: record.name,
							observedTimestamp: record.observedAtMs,
							severityNumber: SeverityNumber.INFO,
							severityText: 'INFO',
						});
					},
				};
			},
			shutdown: async () => {
				await loggerProvider.shutdown();
			},
		},
		meterProvider: {
			forceFlush: async () => {
				await meterProvider.forceFlush();
			},
			getMeter: (name, version) => {
				const meter = meterProvider.getMeter(name, version);
				return {
					createCounter: (metricName) => {
						const counter = meter.createCounter(metricName);
						return {
							add: (value, attributes) => {
								counter.add(value, toOtelAttributes(attributes));
							},
						};
					},
					createHistogram: (metricName) => {
						const histogram = meter.createHistogram(metricName);
						return {
							record: (value, attributes) => {
								histogram.record(value, toOtelAttributes(attributes));
							},
						};
					},
				};
			},
			shutdown: async () => {
				await meterProvider.shutdown();
			},
		},
		tracerProvider: {
			forceFlush: async () => {
				await tracerProvider.forceFlush();
			},
			getTracer: (tracerName, tracerVersion) => {
				const tracer = tracerProvider.getTracer(tracerName, tracerVersion);
				return {
					startSpan: (spanName, spanOptions) =>
						tracer.startSpan(spanName, {
							attributes: toOtelAttributes(spanOptions.attributes),
							startTime: spanOptions.startTime,
						}),
				};
			},
			shutdown: async () => {
				await tracerProvider.shutdown();
			},
		},
	};
}

function resolveOtelAdmissionLimits(
	overrides: Partial<OtelControllerTelemetryAdmissionLimits> | undefined,
): OtelControllerTelemetryAdmissionLimits {
	const limits = { ...defaultOtelControllerTelemetryAdmissionLimits, ...overrides };
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`Controller OTLP admission ${name} must be a positive safe integer.`);
		}
	}
	if (limits.maxExportBatchRecords > limits.maxQueuedRecordsPerSignal) {
		throw new Error('Controller OTLP export batch cannot exceed its signal queue capacity.');
	}
	return limits;
}

function getOrCreateCounter(
	counters: Map<string, OtelCounterLike>,
	meter: OtelMeterLike,
	name: string,
): OtelCounterLike {
	const existingCounter = counters.get(name);
	if (existingCounter) {
		return existingCounter;
	}
	const counter = meter.createCounter(name);
	counters.set(name, counter);
	return counter;
}

function getOrCreateHistogram(
	histograms: Map<string, OtelHistogramLike>,
	meter: OtelMeterLike,
	name: string,
): OtelHistogramLike {
	const existingHistogram = histograms.get(name);
	if (existingHistogram) {
		return existingHistogram;
	}
	const histogram = meter.createHistogram(name);
	histograms.set(name, histogram);
	return histogram;
}

function joinEndpointPath(endpoint: string, path: string): string {
	return `${endpoint.replace(/\/+$/u, '')}${path}`;
}

function toOtelAttributes(attributes: TelemetryAttributes): Attributes {
	const otelAttributes: Attributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		otelAttributes[key] = value;
	}
	return otelAttributes;
}
