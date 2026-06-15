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
	ControllerTelemetryDriverOptions,
	ControllerTelemetryLogRecord,
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
	readonly logsUrl: string;
	readonly metricsUrl: string;
	readonly resourceAttributes: TelemetryAttributes;
	readonly tracesUrl: string;
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
): ControllerTelemetryDriver {
	const serviceVersion =
		typeof options.resourceAttributes['service.version'] === 'string'
			? options.resourceAttributes['service.version']
			: '0.0.0';
	const providers = providerFactory({
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

	return {
		emitLog: (record) => {
			logger.emit(record);
		},
		emitMetric: (record) => {
			if (record.name.endsWith('_total')) {
				getOrCreateCounter(counters, meter, record.name).add(record.value, record.attributes);
				return;
			}
			getOrCreateHistogram(histograms, meter, record.name).record(record.value, record.attributes);
		},
		emitSpan: (record) => {
			const span = tracer.startSpan(record.name, {
				attributes: record.attributes,
				startTime: record.observedAtMs,
			});
			span.end(record.observedAtMs);
		},
		forceFlush: async () => {
			await settleTelemetryProviderOperations([
				() => providers.loggerProvider.forceFlush(),
				() => providers.meterProvider.forceFlush(),
				() => providers.tracerProvider.forceFlush(),
			]);
		},
		shutdown: async () => {
			await settleTelemetryProviderOperations([
				() => providers.loggerProvider.shutdown(),
				() => providers.meterProvider.shutdown(),
				() => providers.tracerProvider.shutdown(),
			]);
		},
	};
}

async function settleTelemetryProviderOperations(
	operations: readonly (() => Promise<void>)[],
): Promise<void> {
	await Promise.allSettled(operations.map(async (operation) => await operation()));
}

function createDefaultOtelProviders(
	options: OtelControllerTelemetryProviderFactoryOptions,
): ReturnType<OtelControllerTelemetryProviderFactory> {
	const resource = resourceFromAttributes(toOtelAttributes(options.resourceAttributes));
	const loggerProvider = new LoggerProvider({
		processors: [
			new BatchLogRecordProcessor(new OTLPLogExporter({ url: options.logsUrl }), {
				exportTimeoutMillis: 5_000,
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
