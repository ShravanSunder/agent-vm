import { Writable } from 'node:stream';

import {
	configure,
	dispose,
	getJsonLinesFormatter,
	getStreamSink,
	type Sink,
} from '@logtape/logtape';
import { getOpenTelemetrySink, type OpenTelemetrySinkExporterOptions } from '@logtape/otel';
import { resourceFromAttributes } from '@opentelemetry/resources';

import type { TelemetryAttributes } from './health-event-telemetry.js';
import type {
	EnabledObservabilityRuntimeConfig,
	ObservabilityRuntimeConfig,
} from './observability-config.js';
import { formatHttpHost } from './observability-readiness.js';

const processLoggingCategory = ['agent-vm'] as const;
const logtapeMetaCategory = ['logtape', 'meta'] as const;
const otelDiagnosticsCategory = ['logtape', 'meta', 'otel'] as const;
const maxDiagnosticStringLength = 256;
const diagnosticIdentifierPattern = /^[a-z0-9][a-z0-9._:-]{0,255}$/iu;
const diagnosticIdentifierCredentialPattern =
	/^(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-|ya29\.|eyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+)/iu;
const diagnosticCredentialPattern =
	/https?:\/\/|op:\/\/|authorization|bearer\s+\S+|cookie|password|private\s+key|prompt|response|secret|token|(?:api[_-]?key|credential)\s*=|(?:^|[^a-z0-9])(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-|ya29\.)[a-z0-9._-]+|(?:^|[^a-z0-9])eyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+/iu;

type BoundedDiagnosticValue = boolean | number | string;

export interface ProcessLoggingHandle {
	readonly shutdown: () => Promise<void>;
}

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

function createNonClosingWritableProxy(destination: NodeJS.WritableStream): Writable {
	return new Writable({
		write: (chunk: Buffer | string, encoding, callback): void => {
			if (typeof chunk === 'string') destination.write(chunk, encoding, callback);
			else destination.write(chunk, callback);
		},
	});
}

export interface ProcessLoggingOptions {
	readonly observabilityConfig?: ObservabilityRuntimeConfig | undefined;
	readonly resourceAttributes?: TelemetryAttributes | undefined;
	readonly serviceName: string;
	readonly stderr: NodeJS.WritableStream;
}

export interface ProcessLoggingOtlpEndpointOptions {
	readonly bindAddress: EnabledObservabilityRuntimeConfig['bindAddress'];
	readonly collectorHttpPort: number;
}

export interface BoundedDiagnosticPropertiesInput {
	readonly attempt?: number | undefined;
	readonly autoSelectFamily?: boolean | string | undefined;
	readonly dnsResultOrder?: string | undefined;
	readonly durationMs?: number | undefined;
	readonly errorClass?: string | undefined;
	readonly errorCode?: string | undefined;
	readonly errorSummary?: string | undefined;
	readonly event?: string | undefined;
	readonly failureClass?: string | undefined;
	readonly leaseId?: string | undefined;
	readonly operation?: string | undefined;
	readonly outcome?: string | undefined;
	readonly reason?: string | undefined;
	readonly statusCode?: number | undefined;
	readonly unsafeError?: unknown;
	readonly unsafePayload?: unknown;
	readonly zoneId?: string | undefined;
}

export function resolveProcessLoggingOtlpEndpoint(
	options: ProcessLoggingOtlpEndpointOptions | undefined,
): string | undefined {
	if (options === undefined) {
		return undefined;
	}
	const host = formatHttpHost(options.bindAddress);
	return `http://${host}:${String(options.collectorHttpPort)}/v1/logs`;
}

export function createBoundedDiagnosticProperties(
	input: BoundedDiagnosticPropertiesInput,
): Readonly<Record<string, BoundedDiagnosticValue>> {
	const properties: Record<string, BoundedDiagnosticValue> = {};
	const addBoundedIdentifier = (key: string, value: string | undefined): void => {
		if (value === undefined) {
			return;
		}
		const normalized = value.replace(/[\r\n\t]/gu, ' ').trim();
		if (
			!diagnosticIdentifierPattern.test(normalized) ||
			diagnosticIdentifierCredentialPattern.test(normalized)
		) {
			return;
		}
		properties[key] = normalized;
	};
	const addBoundedString = (key: string, value: string | undefined): void => {
		if (value === undefined) {
			return;
		}
		const normalized = value.replace(/[\r\n\t]/gu, ' ').trim();
		if (
			normalized.length === 0 ||
			normalized.length > maxDiagnosticStringLength ||
			diagnosticCredentialPattern.test(normalized)
		) {
			return;
		}
		properties[key] = normalized;
	};
	const addBoundedNumber = (key: string, value: number | undefined): void => {
		if (value !== undefined && Number.isSafeInteger(value) && value >= 0) {
			properties[key] = value;
		}
	};
	const addBoundedBooleanOrIdentifier = (
		key: string,
		value: boolean | string | undefined,
	): void => {
		if (typeof value === 'boolean') {
			properties[key] = value;
			return;
		}
		addBoundedIdentifier(key, value);
	};

	addBoundedNumber('attempt', input.attempt);
	addBoundedBooleanOrIdentifier('autoSelectFamily', input.autoSelectFamily);
	addBoundedIdentifier('dnsResultOrder', input.dnsResultOrder);
	addBoundedNumber('durationMs', input.durationMs);
	addBoundedIdentifier('errorClass', input.errorClass);
	addBoundedIdentifier('errorCode', input.errorCode);
	addBoundedString('errorSummary', input.errorSummary);
	addBoundedIdentifier('event', input.event);
	addBoundedIdentifier('failureClass', input.failureClass);
	addBoundedIdentifier('leaseId', input.leaseId);
	addBoundedIdentifier('operation', input.operation);
	addBoundedIdentifier('outcome', input.outcome);
	addBoundedIdentifier('reason', input.reason);
	addBoundedNumber('statusCode', input.statusCode);
	addBoundedIdentifier('zoneId', input.zoneId);
	return properties;
}

export function createProcessLoggingOtelSinkOptions(
	options: ProcessLoggingOptions,
): OpenTelemetrySinkExporterOptions {
	const endpoint = resolveProcessLoggingOtlpEndpoint(
		options.observabilityConfig?.enabled !== true
			? undefined
			: {
					bindAddress: options.observabilityConfig.bindAddress,
					collectorHttpPort: options.observabilityConfig.ports.collectorHttp,
				},
	);
	return {
		...(options.resourceAttributes === undefined
			? {}
			: { additionalResource: resourceFromAttributes(options.resourceAttributes) }),
		...(endpoint === undefined ? {} : { otlpExporterConfig: { url: endpoint } }),
		diagnostics: false,
		exceptionAttributes: false,
		objectRenderer: 'json',
		serviceName: options.serviceName,
	};
}

function createOtlpSink(options: ProcessLoggingOptions): ReturnType<typeof getOpenTelemetrySink> {
	return getOpenTelemetrySink(createProcessLoggingOtelSinkOptions(options));
}

async function disposeSink(sink: Sink & AsyncDisposable): Promise<void> {
	await sink[Symbol.asyncDispose]();
}

async function configureLogTapeSinks(
	stderrSink: Sink & AsyncDisposable,
	otelSink: ReturnType<typeof getOpenTelemetrySink> | undefined,
): Promise<void> {
	if (otelSink === undefined) {
		await configure({
			reset: false,
			loggers: [
				{
					category: [...logtapeMetaCategory],
					lowestLevel: 'warning',
					parentSinks: 'override',
					sinks: ['stderr'],
				},
				{
					category: [...processLoggingCategory],
					lowestLevel: 'trace',
					sinks: ['stderr'],
				},
				{
					category: [...otelDiagnosticsCategory],
					lowestLevel: 'warning',
					parentSinks: 'override',
					sinks: ['stderr'],
				},
			],
			sinks: { stderr: stderrSink },
		});
		return;
	}

	await configure({
		reset: false,
		loggers: [
			{
				category: [...logtapeMetaCategory],
				lowestLevel: 'warning',
				parentSinks: 'override',
				sinks: ['stderr'],
			},
			{
				category: [...processLoggingCategory],
				lowestLevel: 'trace',
				sinks: ['stderr', 'otel'],
			},
			{
				category: [...otelDiagnosticsCategory],
				lowestLevel: 'warning',
				parentSinks: 'override',
				sinks: ['stderr'],
			},
		],
		sinks: { otel: otelSink, stderr: stderrSink },
	});
}

export async function configureProcessLogging(
	options: ProcessLoggingOptions,
): Promise<ProcessLoggingHandle> {
	const stderrSink = ignoreRecordsAfterDisposal(
		getStreamSink(Writable.toWeb(createNonClosingWritableProxy(options.stderr)), {
			formatter: getJsonLinesFormatter({
				categorySeparator: '.',
				message: 'rendered',
				properties: 'nest:properties',
			}),
		}),
	);
	let otelSink: ReturnType<typeof getOpenTelemetrySink> | undefined;
	try {
		otelSink = options.observabilityConfig?.enabled === false ? undefined : createOtlpSink(options);
		await configureLogTapeSinks(stderrSink, otelSink);
	} catch (error: unknown) {
		await Promise.allSettled([
			disposeSink(stderrSink),
			...(otelSink === undefined ? [] : [disposeSink(otelSink)]),
		]);
		throw error;
	}

	let shutdownPromise: Promise<void> | undefined;
	return {
		shutdown: (): Promise<void> => {
			shutdownPromise ??= dispose();
			return shutdownPromise;
		},
	};
}
