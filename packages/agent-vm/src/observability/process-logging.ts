import { Writable } from 'node:stream';

import {
	configure,
	dispose,
	getJsonLinesFormatter,
	getStreamSink,
	type Sink,
} from '@logtape/logtape';
import { getOpenTelemetrySink } from '@logtape/otel';

import type {
	EnabledObservabilityRuntimeConfig,
	ObservabilityRuntimeConfig,
} from './observability-config.js';

const processLoggingCategory = ['agent-vm'] as const;
const logtapeMetaCategory = ['logtape', 'meta'] as const;
const otelDiagnosticsCategory = ['logtape', 'meta', 'otel'] as const;
const maxDiagnosticStringLength = 256;
const diagnosticCredentialPattern =
	/https?:\/\/|op:\/\/|authorization|bearer\s+\S+|cookie|password|private\s+key|prompt|response|secret|token|(?:api[_-]?key|credential)\s*=|(?:^|[^a-z0-9])(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-|ya29\.)[a-z0-9._-]+|(?:^|[^a-z0-9])eyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+/iu;

type BoundedDiagnosticValue = boolean | number | string;

export interface ProcessLoggingHandle {
	readonly shutdown: () => Promise<void>;
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
	readonly serviceName: string;
	readonly stderr: NodeJS.WritableStream;
}

export interface ProcessLoggingOtlpEndpointOptions {
	readonly bindAddress: EnabledObservabilityRuntimeConfig['bindAddress'];
	readonly collectorHttpPort: number;
}

export interface BoundedDiagnosticPropertiesInput {
	readonly attempt?: number | undefined;
	readonly durationMs?: number | undefined;
	readonly errorClass?: string | undefined;
	readonly errorCode?: string | undefined;
	readonly errorSummary?: string | undefined;
	readonly event?: string | undefined;
	readonly failureClass?: string | undefined;
	readonly leaseId?: string | undefined;
	readonly operation?: string | undefined;
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
	const host = options.bindAddress === '::1' ? '[::1]' : options.bindAddress;
	return `http://${host}:${String(options.collectorHttpPort)}/v1/logs`;
}

export function createBoundedDiagnosticProperties(
	input: BoundedDiagnosticPropertiesInput,
): Readonly<Record<string, BoundedDiagnosticValue>> {
	const properties: Record<string, BoundedDiagnosticValue> = {};
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

	addBoundedNumber('attempt', input.attempt);
	addBoundedNumber('durationMs', input.durationMs);
	addBoundedString('errorClass', input.errorClass);
	addBoundedString('errorCode', input.errorCode);
	addBoundedString('errorSummary', input.errorSummary);
	addBoundedString('event', input.event);
	addBoundedString('failureClass', input.failureClass);
	addBoundedString('leaseId', input.leaseId);
	addBoundedString('operation', input.operation);
	addBoundedNumber('statusCode', input.statusCode);
	addBoundedString('zoneId', input.zoneId);
	return properties;
}

function createOtlpSink(options: ProcessLoggingOptions): ReturnType<typeof getOpenTelemetrySink> {
	const endpoint = resolveProcessLoggingOtlpEndpoint(
		options.observabilityConfig?.enabled !== true
			? undefined
			: {
					bindAddress: options.observabilityConfig.bindAddress,
					collectorHttpPort: options.observabilityConfig.ports.collectorHttp,
				},
	);
	return getOpenTelemetrySink({
		...(endpoint === undefined ? {} : { otlpExporterConfig: { url: endpoint } }),
		diagnostics: false,
		exceptionAttributes: false,
		objectRenderer: 'json',
		serviceName: options.serviceName,
	});
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
	const stderrSink = getStreamSink(Writable.toWeb(createNonClosingWritableProxy(options.stderr)), {
		formatter: getJsonLinesFormatter({
			categorySeparator: '.',
			message: 'rendered',
			properties: 'nest:properties',
		}),
		nonBlocking: true,
	});
	const otelSink =
		options.observabilityConfig?.enabled === false ? undefined : createOtlpSink(options);
	try {
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
