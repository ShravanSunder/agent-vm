import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/agent-portal-sdk';
import { SpanKind, trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeToolPortalObservabilityConfig } from './gateway-runtime-service-config.js';
import {
	createGatewayRuntimeToolPortalTelemetryResource,
	createGatewayRuntimeToolPortalTelemetryRuntime,
	type GatewayRuntimeToolPortalTelemetryLogRecord,
	type GatewayRuntimeToolPortalTelemetryMetricRecord,
	type GatewayRuntimeToolPortalTelemetryProvider,
	type GatewayRuntimeToolPortalTelemetryProviderFactory,
} from './gateway-runtime-tool-portal-telemetry.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

const enabledObservability = {
	admissionLimits: {
		maxExportBatchRecords: 64,
		maxQueuedRecordsPerSignal: 256,
		maxRecordBytes: 65_536,
	},
	endpoint: 'http://otel-collector.observability.vm.host:4318',
	flushIntervalMs: 60_000,
	kind: 'otlp-http',
	logs: true,
	metrics: true,
	sampleRate: 1,
	serviceName: 'agent-vm-tool-portal',
	sourcePolicy: { admitBaggage: false, captureContent: false },
	traces: true,
} as const satisfies GatewayRuntimeToolPortalObservabilityConfig;

const trustedContext = {
	principal: {
		agentId: 'sensitive-agent-id',
		frameworkIdentity: { agentId: 'sensitive-agent-id', kind: 'openclaw' },
		profileAssignmentRevision: 'sensitive-profile-revision',
		toolPortalProfileId: 'sensitive-tool-portal-profile',
	},
	requester: { authenticatedSubjectId: 'sensitive-subject' },
} satisfies GatewayRuntimeTrustedInvocationContext;

interface RecordingTelemetryProviderFixture {
	readonly logs: GatewayRuntimeToolPortalTelemetryLogRecord[];
	readonly metrics: GatewayRuntimeToolPortalTelemetryMetricRecord[];
	readonly provider: GatewayRuntimeToolPortalTelemetryProvider;
	readonly spanExporter: InMemorySpanExporter;
}

function createRecordingTelemetryProviderFixture(): RecordingTelemetryProviderFixture {
	const spanExporter = new InMemorySpanExporter();
	const tracerProvider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(spanExporter)],
	});
	const logs: GatewayRuntimeToolPortalTelemetryLogRecord[] = [];
	const metrics: GatewayRuntimeToolPortalTelemetryMetricRecord[] = [];
	return {
		logs,
		metrics,
		provider: {
			emitLog: (record): void => {
				logs.push(record);
			},
			emitMetric: (record): void => {
				metrics.push(record);
			},
			forceFlush: async (): Promise<void> => {
				await tracerProvider.forceFlush();
			},
			shutdown: async (): Promise<void> => {
				await tracerProvider.shutdown();
			},
			tracer: tracerProvider.getTracer('tool-portal-telemetry-test'),
		},
		spanExporter,
	};
}

describe('Gateway Runtime Tool Portal telemetry', () => {
	it('merges standard environment resource attributes without allowing service identity override', () => {
		// Arrange
		vi.stubEnv(
			'OTEL_RESOURCE_ATTRIBUTES',
			'dev.repo.hash=0123456789abcdef,dev.worktree.hash=fedcba9876543210,service.name=untrusted-service',
		);

		// Act
		const resource = createGatewayRuntimeToolPortalTelemetryResource(enabledObservability);

		// Assert
		expect(resource.attributes).toMatchObject({
			'dev.repo.hash': '0123456789abcdef',
			'dev.worktree.hash': 'fedcba9876543210',
			'service.name': 'agent-vm-tool-portal',
		});
	});

	it('keeps disabled telemetry as a no-op around backend execution', async () => {
		// Arrange
		const providerFactory = vi.fn<GatewayRuntimeToolPortalTelemetryProviderFactory>();
		const runtime = createGatewayRuntimeToolPortalTelemetryRuntime({
			config: { kind: 'disabled' },
			providerFactory,
		});
		const backendResult = { kind: 'sensitive-result' };

		// Act
		const result = await runtime.traceContextDispatch(
			{
				connectionId: 'sensitive-connection-id',
				method: 'sandbox.exec.start',
				traceContext: undefined,
			},
			async () => backendResult,
		);
		await runtime.shutdown();

		// Assert
		expect(result).toBe(backendResult);
		expect(providerFactory).not.toHaveBeenCalled();
		expect(runtime.getDiagnostics()).toMatchObject({ providerOperationFailures: 0 });
	});

	it('creates a UDS SERVER span and Tool VM backend child without recording private content', async () => {
		// Arrange
		const fixture = createRecordingTelemetryProviderFixture();
		let nowMs = 1_000;
		const runtime = createGatewayRuntimeToolPortalTelemetryRuntime({
			config: enabledObservability,
			now: () => nowMs++,
			providerFactory: () => fixture.provider,
		});
		const privateResult = { content: 'sensitive-result-content' };
		const sandboxDispatch = runtime.wrapSandboxDispatch(async () => privateResult);

		// Act
		const result = await runtime.traceContextDispatch(
			{
				connectionId: 'sensitive-connection-id',
				method: 'sandbox.exec.start',
				traceContext: {
					traceparent: `00-${'11'.repeat(16)}-${'22'.repeat(8)}-01`,
					tracestate: 'vendor=value',
				},
			},
			async () =>
				await sandboxDispatch({
					connectionId: 'sensitive-connection-id',
					method: 'sandbox.exec.start',
					publicRequest: { command: 'sensitive-shell-command' },
					signal: new AbortController().signal,
					trustedContext,
				}),
		);

		// Assert
		expect(result).toBe(privateResult);
		const spans = fixture.spanExporter.getFinishedSpans();
		expect(spans).toHaveLength(2);
		const udsSpan = spans.find((span) => span.name === 'gateway_runtime.uds.request');
		const backendSpan = spans.find((span) => span.name === 'gateway_runtime.backend.request');
		expect(udsSpan?.kind).toBe(SpanKind.SERVER);
		expect(udsSpan?.parentSpanContext).toMatchObject({
			isRemote: true,
			spanId: '22'.repeat(8),
			traceId: '11'.repeat(16),
		});
		expect(backendSpan?.parentSpanContext?.spanId).toBe(udsSpan?.spanContext().spanId);
		expect(backendSpan?.attributes['agent_vm.backend_kind']).toBe('tool_vm_runner');

		const serializedTelemetry = JSON.stringify({
			logs: fixture.logs,
			metrics: fixture.metrics,
			spans: spans.map((span) => ({ attributes: span.attributes, name: span.name })),
		});
		for (const forbiddenValue of [
			'sensitive-agent-id',
			'sensitive-connection-id',
			'sensitive-profile-revision',
			'sensitive-result-content',
			'sensitive-shell-command',
			'sensitive-subject',
			'sensitive-tool-portal-profile',
		]) {
			expect(serializedTelemetry).not.toContain(forbiddenValue);
		}
		expect(fixture.logs).toHaveLength(3);
		expect(fixture.metrics).toHaveLength(4);
		for (const metric of fixture.metrics) {
			expect(Object.keys(metric.attributes).toSorted()).toEqual([
				'agent_vm.backend_kind',
				'agent_vm.operation_group',
				'agent_vm.result_class',
			]);
		}
		await runtime.shutdown();
	});

	it('respects unsampled remote parents and creates a safe root when context is omitted', async () => {
		// Arrange
		const fixture = createRecordingTelemetryProviderFixture();
		const runtime = createGatewayRuntimeToolPortalTelemetryRuntime({
			config: enabledObservability,
			providerFactory: () => fixture.provider,
		});

		// Act
		await runtime.traceContextDispatch(
			{
				connectionId: 'connection-a',
				method: 'portal.list',
				traceContext: {
					traceparent: `00-${'33'.repeat(16)}-${'44'.repeat(8)}-00`,
				},
			},
			async () => undefined,
		);
		await runtime.traceContextDispatch(
			{
				connectionId: 'connection-b',
				method: 'portal.list',
				traceContext: undefined,
			},
			async () => undefined,
		);

		// Assert
		const spans = fixture.spanExporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.parentSpanContext).toBeUndefined();
		await runtime.shutdown();
	});

	it('bounds every signal independently and preserves backend outcomes during provider failures', async () => {
		// Arrange
		const providerFactory = vi.fn<GatewayRuntimeToolPortalTelemetryProviderFactory>(() => ({
			emitLog: (): never => {
				throw new Error('provider log failure');
			},
			emitMetric: (): never => {
				throw new Error('provider metric failure');
			},
			forceFlush: async (): Promise<void> => {
				throw new Error('provider flush failure');
			},
			shutdown: async (): Promise<void> => {
				throw new Error('provider shutdown failure');
			},
			tracer: trace.getTracer('tool-portal-provider-failure-test'),
		}));
		const runtime = createGatewayRuntimeToolPortalTelemetryRuntime({
			config: enabledObservability,
			providerFactory,
		});
		const expectedResult = { kind: 'backend-result' };

		// Act
		const results = await Promise.all(
			Array.from(
				{ length: 300 },
				async (_, index) =>
					await runtime.traceContextDispatch(
						{
							connectionId: `connection-${String(index)}`,
							method: 'portal.list',
							traceContext: undefined,
						},
						async () => expectedResult,
					),
			),
		);
		await expect(runtime.shutdown()).resolves.toBeUndefined();

		// Assert
		expect(providerFactory).toHaveBeenCalledWith(
			expect.objectContaining({
				admissionLimits: {
					maxExportBatchRecords: 64,
					maxQueuedRecordsPerSignal: 256,
					maxRecordBytes: 65_536,
				},
			}),
		);
		expect(results.every((result) => result === expectedResult)).toBe(true);
		const diagnostics = runtime.getDiagnostics();
		expect(diagnostics.signals.traces.highWaterRecords).toBeLessThanOrEqual(256);
		expect(diagnostics.signals.logs.highWaterRecords).toBeLessThanOrEqual(256);
		expect(diagnostics.signals.metrics.highWaterRecords).toBeLessThanOrEqual(256);
		expect(diagnostics.signals.traces.saturationDroppedRecords).toBeGreaterThan(0);
		expect(diagnostics.signals.logs.saturationDroppedRecords).toBeGreaterThan(0);
		expect(diagnostics.signals.metrics.saturationDroppedRecords).toBeGreaterThan(0);
		expect(diagnostics.derivedMaxAdmittedPayloadBytesPerSignal).toBe(256 * 65_536);
		expect(diagnostics.providerOperationFailures).toBeGreaterThan(0);
	});

	it('preserves the original backend failure and records no raw error text', async () => {
		// Arrange
		const fixture = createRecordingTelemetryProviderFixture();
		const runtime = createGatewayRuntimeToolPortalTelemetryRuntime({
			config: enabledObservability,
			providerFactory: () => fixture.provider,
		});
		const backendFailure = new Error('sensitive backend failure detail');

		// Act / Assert
		await expect(
			runtime.traceContextDispatch(
				{
					connectionId: 'sensitive-connection-id',
					method: 'portal.call',
					traceContext: undefined,
				},
				async (): Promise<never> => {
					throw backendFailure;
				},
			),
		).rejects.toBe(backendFailure);
		expect(JSON.stringify(fixture.logs)).not.toContain(backendFailure.message);
		expect(JSON.stringify(fixture.metrics)).not.toContain(backendFailure.message);
		await runtime.shutdown();
	});

	it('makes shutdown idempotent', async () => {
		// Arrange
		const shutdown = vi.fn(async (): Promise<void> => undefined);
		const provider: GatewayRuntimeToolPortalTelemetryProvider = {
			emitLog: (): void => undefined,
			emitMetric: (): void => undefined,
			forceFlush: async (): Promise<void> => undefined,
			shutdown,
			tracer: trace.getTracer('tool-portal-noop-test'),
		};
		const runtime = createGatewayRuntimeToolPortalTelemetryRuntime({
			config: enabledObservability,
			providerFactory: () => provider,
		});

		// Act
		await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.shutdown()]);

		// Assert
		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});
