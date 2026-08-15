import { Writable } from 'node:stream';

import { getConfig, getLogger, reset, type Config, type Sink } from '@logtape/logtape';
import type { OpenTelemetrySink, OpenTelemetrySinkOptions } from '@logtape/otel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeToolPortalObservabilityConfig } from './gateway-runtime-service-config.js';
import { configureProcessLogging, type ProcessLoggingDependencies } from './process-logging.js';

interface CapturedWritable {
	readonly stream: Writable;
	readonly text: () => string;
	readonly ended: () => boolean;
}

function createCapturedWritable(): CapturedWritable {
	const chunks: string[] = [];
	let ended = false;
	const stream = new Writable({
		final: (callback): void => {
			ended = true;
			callback();
		},
		write: (chunk: Buffer | string, _encoding, callback): void => {
			chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			callback();
		},
	});
	return {
		ended: (): boolean => ended,
		stream,
		text: (): string => chunks.join(''),
	};
}

function disabledObservability(): GatewayRuntimeToolPortalObservabilityConfig {
	return { kind: 'disabled' };
}

function otlpHttpObservability(): GatewayRuntimeToolPortalObservabilityConfig {
	return {
		admissionLimits: {
			maxExportBatchRecords: 64,
			maxQueuedRecordsPerSignal: 256,
			maxRecordBytes: 65_536,
		},
		endpoint: 'http://collector.example.test/',
		flushIntervalMs: 1_000,
		kind: 'otlp-http',
		logs: true,
		metrics: false,
		sampleRate: 1,
		serviceName: 'agent-vm-tool-portal',
		sourcePolicy: { admitBaggage: false, captureContent: false },
		traces: false,
	};
}

function otlpHttpObservabilityWithLogsDisabled(): GatewayRuntimeToolPortalObservabilityConfig {
	const observability = otlpHttpObservability();
	if (observability.kind !== 'otlp-http') {
		throw new Error('Expected OTLP HTTP observability test fixture.');
	}
	return { ...observability, logs: false };
}

function createTestDependencies(options: {
	readonly configure: NonNullable<ProcessLoggingDependencies['configure']>;
	readonly dispose: NonNullable<ProcessLoggingDependencies['dispose']>;
	readonly getOpenTelemetrySink: NonNullable<ProcessLoggingDependencies['getOpenTelemetrySink']>;
	readonly getStreamSink: NonNullable<ProcessLoggingDependencies['getStreamSink']>;
}): ProcessLoggingDependencies {
	return options;
}

function createAsyncDisposableSink(): Sink & AsyncDisposable {
	return Object.assign((_record: Parameters<Sink>[0]): void => undefined, {
		[Symbol.asyncDispose]: async (): Promise<void> => undefined,
	});
}

afterEach(async () => {
	await reset().catch(() => undefined);
});

describe('Gateway Runtime process logging', () => {
	it('creates JSONL stderr without closing the caller-owned writer', async () => {
		const captured = createCapturedWritable();

		const logging = await configureProcessLogging({
			stderr: captured.stream,
			observability: disabledObservability(),
		});
		const messages = [
			'Gateway runtime started',
			'Gateway runtime is ready',
			'Gateway runtime is serving',
		];
		for (const message of messages) {
			getLogger(['agent-vm', 'gateway-runtime', 'process']).warning(message, { attempt: 1 });
		}

		await logging.shutdown();

		const records = captured
			.text()
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
		expect(records).toHaveLength(messages.length);
		expect(
			records.map((record) => ({
				level: record.level,
				logger: record.logger,
				message: record.message,
				properties: record.properties,
			})),
		).toEqual(
			messages.map((message) => ({
				level: 'WARN',
				logger: 'agent-vm.gateway-runtime.process',
				message,
				properties: { attempt: 1 },
			})),
		);
		expect(captured.ended()).toBe(false);
	});

	it('appends the OTLP logs path exactly once and keeps the typed provider out', async () => {
		const configure = vi.fn(async (_config: Config<string, string>): Promise<void> => undefined);
		const disposeImpl = vi.fn(async (): Promise<void> => undefined);
		const getStreamSink = vi.fn(() => createAsyncDisposableSink());
		const getOpenTelemetrySink = vi.fn(
			(_options: OpenTelemetrySinkOptions): OpenTelemetrySink =>
				createAsyncDisposableSink() as OpenTelemetrySink,
		);

		await configureProcessLogging({
			dependencies: createTestDependencies({
				configure,
				dispose: disposeImpl,
				getOpenTelemetrySink,
				getStreamSink,
			}),
			stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
			observability: otlpHttpObservability(),
		});

		expect(getStreamSink).toHaveBeenCalledWith(
			expect.anything(),
			expect.not.objectContaining({ nonBlocking: true }),
		);
		expect(getOpenTelemetrySink).toHaveBeenCalledTimes(1);
		expect(getOpenTelemetrySink).toHaveBeenCalledWith(
			expect.objectContaining({
				diagnostics: false,
				otlpExporterConfig: { url: 'http://collector.example.test/v1/logs' },
				serviceName: 'agent-vm-tool-portal',
			}),
		);
		const otelOptions = getOpenTelemetrySink.mock.calls[0]?.[0];
		expect(otelOptions).not.toHaveProperty('loggerProvider');
		expect(configure).toHaveBeenCalledWith(
			expect.objectContaining({
				reset: false,
				loggers: expect.arrayContaining([
					expect.objectContaining({
						category: ['logtape', 'meta', 'otel'],
						parentSinks: 'override',
						sinks: ['stderr'],
					}),
				]),
			}),
		);
	});

	it('uses the OTLP no-endpoint path when observability is disabled', async () => {
		const configure = vi.fn(async (_config: Config<string, string>): Promise<void> => undefined);
		const disposeImpl = vi.fn(async (): Promise<void> => undefined);
		const getStreamSink = vi.fn(() => createAsyncDisposableSink());
		const getOpenTelemetrySink = vi.fn((options: OpenTelemetrySinkOptions): OpenTelemetrySink => {
			expect(options).not.toHaveProperty('otlpExporterConfig');
			expect(options).toMatchObject({ diagnostics: false });
			expect(options).not.toHaveProperty('additionalResource');
			return createAsyncDisposableSink() as OpenTelemetrySink;
		});

		await configureProcessLogging({
			dependencies: createTestDependencies({
				configure,
				dispose: disposeImpl,
				getOpenTelemetrySink,
				getStreamSink,
			}),
			stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
			observability: disabledObservability(),
			resourceAttributes: { 'agent_vm.zone.id': 'disabled-zone' },
		});

		expect(getOpenTelemetrySink).toHaveBeenCalledTimes(1);
	});

	it('does not export disabled logs through an ambient OTLP endpoint', async () => {
		const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://ambient-collector.example.test';
		const configure = vi.fn(async (_config: Config<string, string>): Promise<void> => undefined);
		const disposeImpl = vi.fn(async (): Promise<void> => undefined);
		const getStreamSink = vi.fn(() => createAsyncDisposableSink());
		const getOpenTelemetrySink = vi.fn((options: OpenTelemetrySinkOptions): OpenTelemetrySink => {
			expect(options).not.toHaveProperty('otlpExporterConfig');
			expect(options.loggerProvider).toBeDefined();
			return createAsyncDisposableSink() as OpenTelemetrySink;
		});

		try {
			await configureProcessLogging({
				dependencies: createTestDependencies({
					configure,
					dispose: disposeImpl,
					getOpenTelemetrySink,
					getStreamSink,
				}),
				stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
				observability: disabledObservability(),
			});
		} finally {
			if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
			else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
		}

		expect(getOpenTelemetrySink).toHaveBeenCalledTimes(1);
	});

	it('does not export logs when the typed observability provider disables them', async () => {
		const configure = vi.fn(async (_config: Config<string, string>): Promise<void> => undefined);
		const sink = createAsyncDisposableSink();
		const getOpenTelemetrySink = vi.fn((options: OpenTelemetrySinkOptions): OpenTelemetrySink => {
			expect(options).not.toHaveProperty('otlpExporterConfig');
			expect(options.loggerProvider).toBeDefined();
			expect(options).not.toHaveProperty('additionalResource');
			return sink as OpenTelemetrySink;
		});

		await configureProcessLogging({
			dependencies: createTestDependencies({
				configure,
				dispose: async (): Promise<void> => undefined,
				getOpenTelemetrySink,
				getStreamSink: () => sink,
			}),
			observability: otlpHttpObservabilityWithLogsDisabled(),
			resourceAttributes: { 'agent_vm.zone.id': 'disabled-logs-zone' },
			stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
		});

		expect(getOpenTelemetrySink).toHaveBeenCalledTimes(1);
	});

	it('routes OTLP diagnostics to stderr only', async () => {
		const capturedConfigs: Config<string, string>[] = [];
		const configure = vi.fn(async (config: Config<string, string>): Promise<void> => {
			capturedConfigs.push(config);
		});
		const disposeImpl = vi.fn(async (): Promise<void> => undefined);
		const sink = createAsyncDisposableSink();
		const dependencies = createTestDependencies({
			configure,
			dispose: disposeImpl,
			getOpenTelemetrySink: vi.fn(() => sink as OpenTelemetrySink),
			getStreamSink: vi.fn(() => sink),
		});

		await configureProcessLogging({
			dependencies,
			stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
			observability: disabledObservability(),
		});

		const config = capturedConfigs[0];
		expect(config).toBeDefined();
		expect(config?.loggers).toContainEqual(
			expect.objectContaining({
				category: ['logtape', 'meta', 'otel'],
				parentSinks: 'override',
				sinks: ['stderr'],
			}),
		);
	});

	it('disposes LogTape once when shutdown is repeated', async () => {
		const configure = vi.fn(async (_config: Config<string, string>): Promise<void> => undefined);
		const disposeImpl = vi.fn(async (): Promise<void> => undefined);
		const sink = createAsyncDisposableSink();
		const logging = await configureProcessLogging({
			dependencies: createTestDependencies({
				configure,
				dispose: disposeImpl,
				getOpenTelemetrySink: vi.fn(() => sink as OpenTelemetrySink),
				getStreamSink: vi.fn(() => sink),
			}),
			stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
			observability: disabledObservability(),
		});

		await Promise.all([logging.shutdown(), logging.shutdown(), logging.shutdown()]);

		expect(disposeImpl).toHaveBeenCalledTimes(1);
	});

	it('does not replace an active root configuration', async () => {
		const first = await configureProcessLogging({
			stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
			observability: disabledObservability(),
		});

		await expect(
			configureProcessLogging({
				stderr: new Writable({ write: (_chunk, _encoding, callback): void => callback() }),
				observability: disabledObservability(),
			}),
		).rejects.toThrow(/already configured/iu);
		expect(getConfig()).not.toBeNull();
		await first.shutdown();
	});
});
