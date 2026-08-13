import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import { getConfig, getLogger, reset } from '@logtape/logtape';
import { afterEach, describe, expect, it } from 'vitest';

import {
	configureProcessLogging,
	toSafeWorkerLogProperties,
	type ProcessLoggingHandle,
} from './process-logging.js';

describe.sequential('worker process logging', () => {
	let logging: ProcessLoggingHandle | undefined;

	function createCaptureStderr(): { readonly chunks: string[]; readonly stderr: Writable } {
		const chunks: string[] = [];
		const stderr = new Writable({
			write: (chunk: Uint8Array, _encoding, callback): void => {
				chunks.push(Buffer.from(chunk).toString('utf8'));
				callback();
			},
		});
		return { chunks, stderr };
	}

	async function configureForTest(): Promise<{
		readonly chunks: string[];
		readonly stderr: Writable;
	}> {
		const capture = createCaptureStderr();
		logging = await configureProcessLogging({ stderr: capture.stderr });
		return capture;
	}

	async function disposeTestLogging(): Promise<void> {
		if (logging !== undefined) {
			await logging.shutdown();
			logging = undefined;
		}
	}

	afterEach(async () => {
		await disposeTestLogging();
		if (getConfig() !== null) await reset();
	});

	it('configures JSONL stderr and routes LogTape OTEL diagnostics to stderr only', async () => {
		const capture = await configureForTest();

		const config = getConfig();
		expect(config).not.toBeNull();
		expect(config?.loggers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					category: ['agent-vm', 'worker'],
					sinks: ['stderr', 'otel'],
				}),
				expect.objectContaining({
					category: ['logtape', 'meta', 'otel'],
					sinks: ['stderr'],
				}),
				expect.objectContaining({
					category: ['logtape', 'meta'],
					sinks: ['stderr'],
				}),
			]),
		);

		getLogger(['agent-vm', 'worker', 'server']).info('worker listening', {
			port: 18_789,
		});
		await disposeTestLogging();

		const records = capture.chunks
			.join('')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records).toHaveLength(1);
		expect(records?.[0]).toMatchObject({
			level: 'INFO',
			logger: 'agent-vm.worker.server',
			message: 'worker listening',
			properties: { port: 18_789 },
		});
	});

	it('flushes multiple rapid records before shutdown completes', async () => {
		const chunks: string[] = [];
		const stderr = new Writable({
			write: (chunk: Uint8Array, _encoding, callback): void => {
				chunks.push(Buffer.from(chunk).toString('utf8'));
				setImmediate(callback);
			},
		});
		logging = await configureProcessLogging({ stderr });

		const logger = getLogger(['agent-vm', 'worker', 'rapid-records']);
		for (const message of ['first record', 'second record', 'third record', 'fourth record']) {
			logger.info(message);
		}

		await logging.shutdown();

		const records = chunks
			.join('')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records.map((record) => record.message)).toEqual([
			'first record',
			'second record',
			'third record',
			'fourth record',
		]);
	});

	it('throws on duplicate process setup instead of replacing the active sink', async () => {
		await configureForTest();

		await expect(configureProcessLogging({ stderr: new Writable() })).rejects.toThrow();
		await disposeTestLogging();
	});

	it('uses the LogTape OTEL no-endpoint path without changing stderr setup', async () => {
		const previousLogsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
		const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		try {
			const capture = await configureForTest();
			getLogger(['agent-vm', 'worker', 'coordinator']).warning('collector absent');
			await disposeTestLogging();
			expect(capture.chunks.join('')).toContain('collector absent');
		} finally {
			if (previousLogsEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
			else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = previousLogsEndpoint;
			if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
			else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
		}
	});

	it('disposes the configured writer exactly once through an idempotent shutdown handle', async () => {
		const capture = await configureForTest();

		const firstShutdown = logging?.shutdown();
		const secondShutdown = logging?.shutdown();
		expect(secondShutdown).toBe(firstShutdown);
		await firstShutdown;
		expect(capture.stderr.writableEnded).toBe(false);
		expect(getConfig()).not.toBeNull();
		logging = undefined;
	});

	it('keeps only bounded safe worker context', () => {
		const properties = toSafeWorkerLogProperties({
			event: 'task-failed',
			failureClass: 'executor-error',
			correlationId: 'worker-operation-1',
			attempt: 2,
			durationMs: 42,
			error: new Error('raw command stdout must not be logged'),
		});

		expect(properties).toEqual({
			event: 'task-failed',
			failureClass: 'executor-error',
			correlationId: 'worker-operation-1',
			attempt: 2,
			durationMs: 42,
			errorClass: 'Error',
		});
	});

	it('preserves safe JavaScript Error class names', () => {
		expect(toSafeWorkerLogProperties({ error: new TypeError('raw command output') })).toEqual({
			errorClass: 'TypeError',
		});
	});

	it('ignores records emitted after shutdown without an unhandled rejection', async () => {
		const capture = await configureForTest();
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			unhandledRejections.push(reason);
		};
		process.on('unhandledRejection', onUnhandledRejection);
		try {
			await disposeTestLogging();
			expect(() =>
				getLogger(['agent-vm', 'worker', 'late-record']).warning('late record'),
			).not.toThrow();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandledRejections).toEqual([]);
			expect(capture.chunks.join('')).toBe('');
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
		}
	});

	it('omits unsafe event, failure, and correlation values', () => {
		const unsafeValues = [
			'https://example.invalid/path?token=secret',
			'op://vault/item/password',
			'token=secret-value',
			'password=secret-value',
			'prompt text from the model',
			'response text from the model',
			'command output from the child process',
		];

		for (const unsafeValue of unsafeValues) {
			const properties = toSafeWorkerLogProperties({
				event: unsafeValue,
				failureClass: unsafeValue,
				correlationId: unsafeValue,
			});

			expect(properties).not.toHaveProperty('event');
			expect(properties).not.toHaveProperty('failureClass');
			expect(properties).not.toHaveProperty('correlationId');
		}
	});

	it('keeps Worker diagnostic owners off the direct stderr helper', async () => {
		const ownerFiles = [
			'../coordinator/coordinator.ts',
			'../coordinator/coordinator-helpers.ts',
			'../coordinator/task-runner.ts',
			'../git/git-operations.ts',
			'../prompt/prompt-assembler.ts',
			'../server.ts',
			'../state/event-log.ts',
			'../state/task-state.ts',
			'../validation-runner/verification-runner.ts',
			'../work-executor/codex-executor.ts',
			'../work-phase/work-cycle.ts',
		] as const;
		const contents = await Promise.all(
			ownerFiles.map((ownerFile) => readFile(new URL(ownerFile, import.meta.url), 'utf8')),
		);

		expect(contents.every((content) => !content.includes('writeStderr'))).toBe(true);
	});
});
