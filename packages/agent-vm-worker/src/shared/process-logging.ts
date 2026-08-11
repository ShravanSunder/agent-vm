import { Writable } from 'node:stream';

import {
	configure,
	dispose,
	getJsonLinesFormatter,
	getStreamSink,
	type Sink,
} from '@logtape/logtape';
import { getOpenTelemetrySink } from '@logtape/otel';

const workerLogCategory = ['agent-vm', 'worker'] as const;
const maximumSafeStringLength = 128;
export const workerProcessLoggingShutdownFailureMessage =
	'Worker process logging shutdown failed.\n';

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

export interface ProcessLoggingOptions {
	readonly stderr: Writable;
}

export interface WorkerLogContext {
	readonly event?: string | undefined;
	readonly failureClass?: string | undefined;
	readonly correlationId?: string | undefined;
	readonly attempt?: number | undefined;
	readonly durationMs?: number | undefined;
	readonly error?: unknown;
	readonly stdout?: string | undefined;
	readonly stderr?: string | undefined;
}

function boundSafeString(value: string): string | undefined {
	let sanitizedValue = '';
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		sanitizedValue += codePoint < 32 || codePoint === 127 ? ' ' : character;
	}
	const boundedValue = sanitizedValue.trim().slice(0, maximumSafeStringLength);
	return boundedValue.length === 0 ? undefined : boundedValue;
}

function boundSafeClassification(value: string): string | undefined {
	const boundedValue = boundSafeString(value);
	if (
		boundedValue === undefined ||
		!/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u.test(boundedValue) ||
		/(?:auth|command|content|cookie|password|payload|private|prompt|response|secret|stderr|stdout|token)/u.test(
			boundedValue,
		)
	) {
		return undefined;
	}
	return boundedValue;
}

function boundSafeCorrelationId(value: string): string | undefined {
	const boundedValue = boundSafeString(value);
	if (
		boundedValue === undefined ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(boundedValue) ||
		boundedValue.includes('://') ||
		boundedValue.startsWith('op:') ||
		/(?:auth|command|content|cookie|password|payload|private|prompt|response|secret|stderr|stdout|token)/iu.test(
			boundedValue,
		)
	) {
		return undefined;
	}
	return boundedValue;
}

function boundedFiniteNumber(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
		return undefined;
	}
	return value;
}

export function toSafeWorkerLogProperties(
	context: WorkerLogContext,
): Readonly<Record<string, string | number>> {
	const properties: Record<string, string | number> = {};
	const event = context.event === undefined ? undefined : boundSafeClassification(context.event);
	const failureClass =
		context.failureClass === undefined ? undefined : boundSafeClassification(context.failureClass);
	const correlationId =
		context.correlationId === undefined ? undefined : boundSafeCorrelationId(context.correlationId);
	const attempt = context.attempt === undefined ? undefined : boundedFiniteNumber(context.attempt);
	const durationMs =
		context.durationMs === undefined ? undefined : boundedFiniteNumber(context.durationMs);
	if (event !== undefined) properties.event = event;
	if (failureClass !== undefined) properties.failureClass = failureClass;
	if (correlationId !== undefined) properties.correlationId = correlationId;
	if (attempt !== undefined) properties.attempt = attempt;
	if (durationMs !== undefined) properties.durationMs = durationMs;
	if (context.error !== undefined) {
		properties.errorClass =
			context.error instanceof Error
				? (boundSafeClassification(context.error.name) ?? 'Error')
				: 'UnknownError';
	}
	return properties;
}

async function disposeSink(sink: Sink & AsyncDisposable): Promise<void> {
	await sink[Symbol.asyncDispose]();
}

export async function configureProcessLogging(
	options: ProcessLoggingOptions,
): Promise<ProcessLoggingHandle> {
	const stderrSink = getStreamSink(Writable.toWeb(createNonClosingWritableProxy(options.stderr)), {
		formatter: getJsonLinesFormatter({ properties: 'nest:properties' }),
	});
	const otelSink = getOpenTelemetrySink({
		diagnostics: false,
		serviceName: 'agent-vm-worker',
	});
	try {
		await configure({
			reset: false,
			sinks: { stderr: stderrSink, otel: otelSink },
			loggers: [
				{
					category: [...workerLogCategory],
					sinks: ['stderr', 'otel'],
					lowestLevel: 'debug',
				},
				{
					category: ['logtape', 'meta', 'otel'],
					sinks: ['stderr'],
					lowestLevel: 'warning',
				},
				{
					category: ['logtape', 'meta'],
					sinks: ['stderr'],
					lowestLevel: 'warning',
				},
			],
		});
	} catch (error: unknown) {
		await Promise.allSettled([disposeSink(stderrSink), disposeSink(otelSink)]);
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
