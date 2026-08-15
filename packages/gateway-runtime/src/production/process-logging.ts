import { Writable } from 'node:stream';

import {
	configure,
	dispose,
	getJsonLinesFormatter,
	getStreamSink,
	type Config,
	type Sink,
	type StreamSinkOptions,
} from '@logtape/logtape';
import {
	getOpenTelemetrySink,
	type OpenTelemetrySink,
	type OpenTelemetrySinkOptions,
} from '@logtape/otel';
import type { Logger, LoggerProvider } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';

import type { GatewayRuntimeToolPortalObservabilityConfig } from './gateway-runtime-service-config.js';

const disabledLogger: Logger = {
	enabled: (): boolean => false,
	emit: (): void => undefined,
};

function ignoreRecordsAfterDisposal(sink: Sink & AsyncDisposable): Sink & AsyncDisposable {
	let disposed = false;
	const guardedSink: Sink & AsyncDisposable = (record): void => {
		if (!disposed) sink(record);
	};
	guardedSink[Symbol.asyncDispose] = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		await sink[Symbol.asyncDispose]();
	};
	return guardedSink;
}

const disabledLoggerProvider: LoggerProvider = {
	getLogger: (): Logger => disabledLogger,
};

type GatewayRuntimeProcessLoggingConfig = Config<'stderr' | 'otel', never>;

export interface ProcessLoggingHandle {
	readonly shutdown: () => Promise<void>;
}

function createNonClosingWritableProxy(destination: Writable): Writable {
	return new Writable({
		write: (chunk: Buffer | string, encoding, callback): void => {
			destination.write(chunk, encoding, callback);
		},
	});
}

export interface ProcessLoggingDependencies {
	readonly configure?: (config: GatewayRuntimeProcessLoggingConfig) => Promise<void>;
	readonly dispose?: () => Promise<void>;
	readonly getOpenTelemetrySink?: (options: OpenTelemetrySinkOptions) => OpenTelemetrySink;
	readonly getStreamSink?: (
		stream: WritableStream,
		options?: StreamSinkOptions,
	) => Sink & AsyncDisposable;
}

export interface ConfigureProcessLoggingProps {
	readonly dependencies?: ProcessLoggingDependencies;
	readonly observability: GatewayRuntimeToolPortalObservabilityConfig;
	readonly resourceAttributes?: Readonly<Record<string, string>>;
	readonly stderr: Writable;
}

function appendLogsPath(endpoint: string): string {
	const normalizedEndpoint = endpoint.replace(/\/+$/u, '');
	return normalizedEndpoint.endsWith('/v1/logs')
		? normalizedEndpoint
		: `${normalizedEndpoint}/v1/logs`;
}

function createOpenTelemetrySinkOptions(
	observability: GatewayRuntimeToolPortalObservabilityConfig,
	resourceAttributes: Readonly<Record<string, string>> | undefined,
): OpenTelemetrySinkOptions {
	if (observability.kind === 'disabled' || !observability.logs) {
		return {
			diagnostics: false,
			exceptionAttributes: false,
			loggerProvider: disabledLoggerProvider,
			objectRenderer: 'json',
		};
	}
	const resource =
		resourceAttributes === undefined ? undefined : resourceFromAttributes(resourceAttributes);
	return {
		...(resource === undefined ? {} : { additionalResource: resource }),
		diagnostics: false,
		exceptionAttributes: false,
		objectRenderer: 'json',
		otlpExporterConfig: { url: appendLogsPath(observability.endpoint) },
		serviceName: observability.serviceName,
	};
}

function createGatewayRuntimeProcessLoggingConfig(
	stderrSink: Sink & AsyncDisposable,
	otelSink: OpenTelemetrySink,
): GatewayRuntimeProcessLoggingConfig {
	return {
		loggers: [
			{
				category: ['logtape', 'meta'],
				lowestLevel: 'warning',
				parentSinks: 'override',
				sinks: ['stderr'],
			},
			{
				category: ['agent-vm'],
				lowestLevel: 'trace',
				sinks: ['stderr', 'otel'],
			},
			{
				category: ['logtape', 'meta', 'otel'],
				lowestLevel: 'trace',
				parentSinks: 'override',
				sinks: ['stderr'],
			},
		],
		reset: false,
		sinks: {
			stderr: stderrSink,
			otel: otelSink,
		},
	};
}

export async function configureProcessLogging(
	props: ConfigureProcessLoggingProps,
): Promise<ProcessLoggingHandle> {
	const configureImpl = props.dependencies?.configure ?? configure;
	const disposeImpl = props.dependencies?.dispose ?? dispose;
	const createStreamSink = props.dependencies?.getStreamSink ?? getStreamSink;
	const createOpenTelemetrySink = props.dependencies?.getOpenTelemetrySink ?? getOpenTelemetrySink;
	const stderrSink = ignoreRecordsAfterDisposal(
		createStreamSink(Writable.toWeb(createNonClosingWritableProxy(props.stderr)), {
			formatter: getJsonLinesFormatter(),
		}),
	);
	let otelSink: OpenTelemetrySink | undefined;
	try {
		otelSink = createOpenTelemetrySink(
			createOpenTelemetrySinkOptions(props.observability, props.resourceAttributes),
		);
		await configureImpl(createGatewayRuntimeProcessLoggingConfig(stderrSink, otelSink));
	} catch (error: unknown) {
		await Promise.allSettled([
			stderrSink[Symbol.asyncDispose](),
			...(otelSink === undefined ? [] : [otelSink[Symbol.asyncDispose]()]),
		]);
		throw error;
	}

	let shutdownPromise: Promise<void> | undefined;
	return {
		shutdown: (): Promise<void> => {
			shutdownPromise ??= Promise.resolve().then(disposeImpl);
			return shutdownPromise;
		},
	};
}
