import { Writable } from 'node:stream';

import { dispose, getConfig, getLogger, reset } from '@logtape/logtape';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	configureProcessLogging,
	createBoundedDiagnosticProperties,
	resolveProcessLoggingOtlpEndpoint,
} from './process-logging.js';

function createCapturingWritable(): {
	readonly chunks: string[];
	readonly stream: Writable;
	readonly getFinalizationCount: () => number;
} {
	const chunks: string[] = [];
	let finalizationCount = 0;
	const stream = new Writable({
		final: (callback) => {
			finalizationCount += 1;
			callback();
		},
		write: (chunk: Buffer | string, _encoding, callback) => {
			chunks.push(chunk.toString());
			callback();
		},
	});
	return {
		chunks,
		stream,
		getFinalizationCount: () => finalizationCount,
	};
}

afterEach(async () => {
	await dispose().catch(() => {});
	await reset();
});

describe('configureProcessLogging', () => {
	it('writes one bounded JSONL record to the supplied stderr stream', async () => {
		const stderr = createCapturingWritable();
		const logging = await configureProcessLogging({
			serviceName: 'agent-vm-controller',
			stderr: stderr.stream,
		});

		getLogger(['agent-vm', 'controller', 'runtime']).warn('Controller startup degraded', {
			...createBoundedDiagnosticProperties({
				attempt: 2,
				failureClass: 'transport',
				unsafeError: new Error('secret=do-not-log'),
				unsafePayload: { prompt: 'do-not-log' },
			}),
		});

		await logging.shutdown();

		expect(stderr.chunks).toHaveLength(1);
		const record = JSON.parse(stderr.chunks[0] ?? '{}') as Record<string, unknown>;
		expect(record).toMatchObject({
			level: 'WARN',
			logger: 'agent-vm.controller.runtime',
			message: 'Controller startup degraded',
		});
		expect(record.properties).toEqual({ attempt: 2, failureClass: 'transport' });
		expect(stderr.getFinalizationCount()).toBe(1);
	});

	it('fails on duplicate process configuration without replacing the active sink', async () => {
		const firstStderr = createCapturingWritable();
		const secondStderr = createCapturingWritable();
		const firstLogging = await configureProcessLogging({
			serviceName: 'agent-vm-controller',
			stderr: firstStderr.stream,
		});

		await expect(
			configureProcessLogging({
				serviceName: 'agent-vm-controller',
				stderr: secondStderr.stream,
			}),
		).rejects.toThrow();

		getLogger(['agent-vm', 'controller', 'runtime']).info('first sink remains active');
		await firstLogging.shutdown();

		const records = firstStderr.chunks
			.map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
			.filter((record) => record.logger === 'agent-vm.controller.runtime');
		expect(records).toHaveLength(1);
		expect(secondStderr.chunks).toHaveLength(0);
		expect(secondStderr.getFinalizationCount()).toBe(1);
	});

	it('appends the controller collector logs path exactly once', () => {
		expect(
			resolveProcessLoggingOtlpEndpoint({
				bindAddress: '127.0.0.1',
				collectorHttpPort: 4318,
			}),
		).toBe('http://127.0.0.1:4318/v1/logs');
		expect(
			resolveProcessLoggingOtlpEndpoint({
				bindAddress: '::1',
				collectorHttpPort: 4318,
			}),
		).toBe('http://[::1]:4318/v1/logs');
		expect(resolveProcessLoggingOtlpEndpoint(undefined)).toBeUndefined();
	});

	it('routes OpenTelemetry diagnostics to stderr and does not route them to OTLP', async () => {
		const stderr = createCapturingWritable();
		const logging = await configureProcessLogging({
			serviceName: 'agent-vm-controller',
			stderr: stderr.stream,
		});

		const config = getConfig();
		expect(config).not.toBeNull();
		expect(config?.loggers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					category: ['logtape', 'meta', 'otel'],
					parentSinks: 'override',
					sinks: ['stderr'],
				}),
			]),
		);

		await logging.shutdown();
	});

	it('does not leak a failed OTLP exporter initialization through console.error', async () => {
		const stderr = createCapturingWritable();
		const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
		const previousGeneralEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'not-a-valid-url';
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		try {
			const logging = await configureProcessLogging({
				serviceName: 'agent-vm-controller',
				stderr: stderr.stream,
			});
			getLogger(['agent-vm', 'controller', 'runtime']).warn('Exporter failure probe');
			await new Promise<void>((resolve) => setImmediate(resolve));
			await logging.shutdown();

			expect(consoleError).not.toHaveBeenCalled();
			expect(stderr.chunks.join('')).not.toContain('Failed to initialize OpenTelemetry logger');
		} finally {
			consoleError.mockRestore();
			if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
			else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = previousEndpoint;
			if (previousGeneralEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
			else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousGeneralEndpoint;
		}
	});

	it('shares an idempotent shutdown promise', async () => {
		const stderr = createCapturingWritable();
		const logging = await configureProcessLogging({
			serviceName: 'agent-vm-controller',
			stderr: stderr.stream,
		});

		const firstShutdown = logging.shutdown();
		const secondShutdown = logging.shutdown();

		expect(secondShutdown).toBe(firstShutdown);
		await Promise.all([firstShutdown, secondShutdown]);
		expect(stderr.getFinalizationCount()).toBe(1);
	});
});
