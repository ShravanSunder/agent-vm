import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
	createGatewayTelemetryProducerSafetyContract,
	gatewayFrameworkTelemetryServiceNames,
	gatewayToolPortalTelemetryServiceName,
} from '@agent-vm/gateway-lifecycle';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { startControllerTelemetry } from '../observability/controller-telemetry.js';
import type { ManagedObservabilityRuntimeConfig } from '../observability/observability-config.js';
import { prepareObservabilityStack } from '../observability/observability-lifecycle.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';

const temporaryDirectories: string[] = [];
const storageCanaryStartupCheckTimeoutMs = process.env.GITHUB_ACTIONS === 'true' ? 90_000 : 30_000;
const ciStorageCanaryPorts = [24_317, 24_318, 24_133, 24_428, 24_928, 25_428] as const;

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectory) => {
			await fs.rm(temporaryDirectory, { force: true, recursive: true });
		}),
	);
});

async function reserveLoopbackPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Expected a loopback TCP port.');
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
	return address.port;
}

async function reserveLoopbackPorts(): Promise<
	readonly [number, number, number, number, number, number]
> {
	if (process.env.GITHUB_ACTIONS === 'true') {
		return ciStorageCanaryPorts;
	}
	const ports = await Promise.all(
		Array.from({ length: 6 }, async () => await reserveLoopbackPort()),
	);
	const [collectorGrpc, collectorHttp, collectorHealth, metrics, logs, traces] = ports;
	if (
		collectorGrpc === undefined ||
		collectorHttp === undefined ||
		collectorHealth === undefined ||
		metrics === undefined ||
		logs === undefined ||
		traces === undefined
	) {
		throw new Error('Expected six reserved observability ports.');
	}
	return [collectorGrpc, collectorHttp, collectorHealth, metrics, logs, traces];
}

async function createRuntimeConfig(): Promise<ManagedObservabilityRuntimeConfig> {
	const temporaryDirectory = await fs.mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-observability-storage-'),
	);
	temporaryDirectories.push(temporaryDirectory);
	const [collectorGrpc, collectorHttp, collectorHealth, metrics, logs, traces] =
		await reserveLoopbackPorts();
	return {
		enabled: true,
		stackMode: 'managed',
		projectName: `agent-vm-observability-storage-${Date.now().toString(36)}`,
		runtimeDir: path.join(temporaryDirectory, 'runtime'),
		dataDir: path.join(temporaryDirectory, 'data'),
		bindAddress: '127.0.0.1',
		ports: {
			collectorGrpc,
			collectorHttp,
			collectorHealth,
			metrics,
			logs,
			traces,
		},
		retention: {
			metrics: { period: '1d', minFreeDiskSpaceBytes: '1MiB' },
			logs: { period: '1d', maxDiskSpaceUsageBytes: '128MiB' },
			traces: { period: '1d', maxDiskSpaceUsageBytes: '128MiB' },
		},
		prepareOnBuild: true,
		waitOnBuild: true,
		controllerStartPolicy: 'degraded',
		startupCheckTimeoutMs: storageCanaryStartupCheckTimeoutMs,
		zones: [
			{
				framework: {
					...createGatewayTelemetryProducerSafetyContract(),
					serviceName: gatewayFrameworkTelemetryServiceNames.hermes,
					traces: true,
					metrics: true,
					logs: true,
					sampleRate: 1,
					flushIntervalMs: 1_000,
				},
				toolPortal: {
					...createGatewayTelemetryProducerSafetyContract(),
					serviceName: gatewayToolPortalTelemetryServiceName,
					traces: true,
					metrics: true,
					logs: true,
					sampleRate: 1,
					flushIntervalMs: 1_000,
				},
				zoneId: 'sunfam',
			},
		],
	};
}

async function dockerComposeDown(config: ManagedObservabilityRuntimeConfig): Promise<void> {
	const composePath = path.join(config.runtimeDir, 'docker-compose.observability.yml');
	await execa(
		'docker',
		['compose', '--project-name', config.projectName, '--file', composePath, 'down', '--volumes'],
		{ reject: false, timeout: 30_000 },
	);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function runDiagnosticCommand(options: {
	readonly args: readonly string[];
	readonly command: string;
}): Promise<string> {
	const result = await execa(options.command, [...options.args], {
		reject: false,
		timeout: 10_000,
	});
	const output = [result.stdout, result.stderr].filter((value) => value.length > 0).join('\n');
	return [
		`$ ${[options.command, ...options.args].join(' ')}`,
		`exitCode=${String(result.exitCode)}`,
		output.length === 0 ? '(no output)' : output,
	].join('\n');
}

async function collectObservabilityDockerDiagnostics(
	config: ManagedObservabilityRuntimeConfig,
): Promise<string> {
	const composePath = path.join(config.runtimeDir, 'docker-compose.observability.yml');
	const composeArgs = ['compose', '--project-name', config.projectName, '--file', composePath];
	const diagnostics = await Promise.all([
		runDiagnosticCommand({
			command: 'docker',
			args: [...composeArgs, 'ps'],
		}),
		runDiagnosticCommand({
			command: 'docker',
			args: [...composeArgs, 'port', 'otel-collector', '4318'],
		}),
		runDiagnosticCommand({
			command: 'docker',
			args: [...composeArgs, 'port', 'otel-collector', '13133'],
		}),
		runDiagnosticCommand({
			command: 'docker',
			args: [
				'ps',
				'--filter',
				`label=com.docker.compose.project=${config.projectName}`,
				'--format',
				'{{.Names}} {{.Ports}}',
			],
		}),
		runDiagnosticCommand({
			command: 'docker',
			args: [...composeArgs, 'logs', '--no-color', '--tail', '80', 'otel-collector'],
		}),
		runDiagnosticCommand({
			command: 'ss',
			args: ['-ltn'],
		}),
	]);
	return diagnostics.join('\n\n');
}

async function prepareObservabilityStackWithDiagnostics(
	config: ManagedObservabilityRuntimeConfig,
): Promise<void> {
	try {
		await prepareObservabilityStack({ config, wait: true });
	} catch (error) {
		const diagnostics = await collectObservabilityDockerDiagnostics(config);
		throw new Error(
			`prepareObservabilityStack failed: ${formatUnknownError(error)}\n\n${diagnostics}`,
			{ cause: error },
		);
	}
}

function encodeVarint(value: bigint): Buffer {
	const bytes: number[] = [];
	let remaining = value;
	for (;;) {
		const byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining === 0n) {
			bytes.push(byte);
			break;
		}
		bytes.push(byte | 0x80);
	}
	return Buffer.from(bytes);
}

function encodeFieldKey(fieldNumber: number, wireType: number): Buffer {
	return encodeVarint(BigInt((fieldNumber << 3) | wireType));
}

function encodeLengthDelimitedField(fieldNumber: number, value: Buffer): Buffer {
	return Buffer.concat([encodeFieldKey(fieldNumber, 2), encodeVarint(BigInt(value.length)), value]);
}

function encodeStringField(fieldNumber: number, value: string): Buffer {
	return encodeLengthDelimitedField(fieldNumber, Buffer.from(value));
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
	return Buffer.concat([encodeFieldKey(fieldNumber, 0), encodeVarint(BigInt(value))]);
}

function encodeFixed64Field(fieldNumber: number, value: bigint): Buffer {
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64LE(value);
	return Buffer.concat([encodeFieldKey(fieldNumber, 1), buffer]);
}

function encodeDoubleField(fieldNumber: number, value: number): Buffer {
	const buffer = Buffer.alloc(8);
	buffer.writeDoubleLE(value);
	return Buffer.concat([encodeFieldKey(fieldNumber, 1), buffer]);
}

function encodeAnyStringValue(value: string): Buffer {
	return encodeStringField(1, value);
}

function encodeKeyValue(key: string, value: string): Buffer {
	return Buffer.concat([
		encodeStringField(1, key),
		encodeLengthDelimitedField(2, encodeAnyStringValue(value)),
	]);
}

function encodeOtlpLogsRequest(options: {
	readonly sensitiveBodyCanary: string;
	readonly safeMarker: string;
	readonly sensitiveCanaries: readonly [string, string, string, string];
}): Buffer {
	const [authorizationCanary, tokenCanary, payloadCanary, urlCanary] = options.sensitiveCanaries;
	const resource = encodeLengthDelimitedField(
		1,
		encodeKeyValue('service.name', 'agent-vm-storage-canary'),
	);
	const scope = encodeStringField(1, 'agent-vm-storage-canary');
	const logRecord = Buffer.concat([
		encodeFixed64Field(1, BigInt(Date.now()) * 1_000_000n),
		encodeVarintField(2, 9),
		encodeStringField(3, 'INFO'),
		encodeLengthDelimitedField(5, encodeAnyStringValue(options.sensitiveBodyCanary)),
		encodeLengthDelimitedField(6, encodeKeyValue('safe_marker', options.safeMarker)),
		encodeLengthDelimitedField(6, encodeKeyValue('authorization', authorizationCanary)),
		encodeLengthDelimitedField(6, encodeKeyValue('token', tokenCanary)),
		encodeLengthDelimitedField(6, encodeKeyValue('payload', payloadCanary)),
		encodeLengthDelimitedField(6, encodeKeyValue('url.full', urlCanary)),
	]);
	const scopeLogs = Buffer.concat([
		encodeLengthDelimitedField(1, scope),
		encodeLengthDelimitedField(2, logRecord),
	]);
	const resourceLogs = Buffer.concat([
		encodeLengthDelimitedField(1, resource),
		encodeLengthDelimitedField(2, scopeLogs),
	]);
	return encodeLengthDelimitedField(1, resourceLogs);
}

function encodeResource(attributes: readonly Buffer[]): Buffer {
	return Buffer.concat(attributes.map((attribute) => encodeLengthDelimitedField(1, attribute)));
}

function encodeInstrumentationScope(name: string): Buffer {
	return encodeStringField(1, name);
}

function encodeOtlpMetricsRequest(options: {
	readonly metricName: string;
	readonly safeMarker: string;
	readonly sensitiveCanaries: readonly [string, string, string, string];
}): Buffer {
	const [authorizationCanary, apiKeyCanary, clientSecretCanary, statementCanary] =
		options.sensitiveCanaries;
	const nowUnixNano = BigInt(Date.now()) * 1_000_000n;
	const resource = encodeResource([
		encodeKeyValue('service.name', 'agent-vm-storage-canary'),
		encodeKeyValue('safe_marker', options.safeMarker),
		encodeKeyValue('authorization', authorizationCanary),
		encodeKeyValue('x-api-key', apiKeyCanary),
	]);
	const dataPoint = Buffer.concat([
		encodeFixed64Field(2, nowUnixNano),
		encodeFixed64Field(3, nowUnixNano),
		encodeDoubleField(4, 42),
		encodeLengthDelimitedField(7, encodeKeyValue('safe_marker', options.safeMarker)),
		encodeLengthDelimitedField(7, encodeKeyValue('client_secret', clientSecretCanary)),
		encodeLengthDelimitedField(7, encodeKeyValue('db.statement', statementCanary)),
	]);
	const gauge = encodeLengthDelimitedField(1, dataPoint);
	const metric = Buffer.concat([
		encodeStringField(1, options.metricName),
		encodeStringField(2, 'agent-vm storage canary gauge'),
		encodeStringField(3, '1'),
		encodeLengthDelimitedField(5, gauge),
	]);
	const scopeMetrics = Buffer.concat([
		encodeLengthDelimitedField(1, encodeInstrumentationScope('agent-vm-storage-canary')),
		encodeLengthDelimitedField(2, metric),
	]);
	const resourceMetrics = Buffer.concat([
		encodeLengthDelimitedField(1, resource),
		encodeLengthDelimitedField(2, scopeMetrics),
	]);
	return encodeLengthDelimitedField(1, resourceMetrics);
}

function encodeOtlpTracesRequest(options: {
	readonly spanName: string;
	readonly safeMarker: string;
	readonly traceIdHex: string;
	readonly sensitiveCanaries: readonly [string, string, string, string];
}): Buffer {
	const [tokenCanary, queryCanary, payloadCanary, cookieCanary] = options.sensitiveCanaries;
	const nowUnixNano = BigInt(Date.now()) * 1_000_000n;
	const traceId = Buffer.from(options.traceIdHex, 'hex');
	const spanId = Buffer.from('0102030405060708', 'hex');
	const resource = encodeResource([
		encodeKeyValue('service.name', 'agent-vm-storage-canary'),
		encodeKeyValue('safe_marker', options.safeMarker),
		encodeKeyValue('token', tokenCanary),
		encodeKeyValue('url.query', queryCanary),
	]);
	const span = Buffer.concat([
		encodeLengthDelimitedField(1, traceId),
		encodeLengthDelimitedField(2, spanId),
		encodeStringField(5, options.spanName),
		encodeVarintField(6, 1),
		encodeFixed64Field(7, nowUnixNano),
		encodeFixed64Field(8, nowUnixNano + 1_000_000n),
		encodeLengthDelimitedField(9, encodeKeyValue('safe_marker', options.safeMarker)),
		encodeLengthDelimitedField(9, encodeKeyValue('payload', payloadCanary)),
		encodeLengthDelimitedField(9, encodeKeyValue('http.response.header.set_cookie', cookieCanary)),
	]);
	const scopeSpans = Buffer.concat([
		encodeLengthDelimitedField(1, encodeInstrumentationScope('agent-vm-storage-canary')),
		encodeLengthDelimitedField(2, span),
	]);
	const resourceSpans = Buffer.concat([
		encodeLengthDelimitedField(1, resource),
		encodeLengthDelimitedField(2, scopeSpans),
	]);
	return encodeLengthDelimitedField(1, resourceSpans);
}

async function postOtlpLog(options: {
	readonly collectorHttpPort: number;
	readonly sensitiveBodyCanary: string;
	readonly safeMarker: string;
	readonly sensitiveCanaries: readonly [string, string, string, string];
}): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${String(options.collectorHttpPort)}/v1/logs`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-protobuf' },
		body: encodeOtlpLogsRequest(options),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(
			`OTLP log export failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
}

async function postOtlpMetric(options: {
	readonly collectorHttpPort: number;
	readonly metricName: string;
	readonly safeMarker: string;
	readonly sensitiveCanaries: readonly [string, string, string, string];
}): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${String(options.collectorHttpPort)}/v1/metrics`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-protobuf' },
		body: encodeOtlpMetricsRequest(options),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(
			`OTLP metric export failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
}

async function postOtlpTrace(options: {
	readonly collectorHttpPort: number;
	readonly spanName: string;
	readonly safeMarker: string;
	readonly traceIdHex: string;
	readonly sensitiveCanaries: readonly [string, string, string, string];
}): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${String(options.collectorHttpPort)}/v1/traces`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-protobuf' },
		body: encodeOtlpTracesRequest(options),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(
			`OTLP trace export failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
}

async function waitForOtlpLogExport(options: {
	readonly collectorHttpPort: number;
	readonly sensitiveBodyCanary: string;
	readonly safeMarker: string;
	readonly sensitiveCanaries: readonly [string, string, string, string];
}): Promise<void> {
	const deadlineMs = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadlineMs) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- poll external collector until published port accepts data
			await postOtlpLog(options);
			return;
		} catch (error) {
			lastError = error;
			// oxlint-disable-next-line no-await-in-loop -- bounded external collector startup poll
			await waitForProtocolRetryInterval(500);
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Timed out waiting for OTLP log export: ${message}`);
}

async function queryVictoriaMetrics(options: {
	readonly metricsPort: number;
	readonly query: string;
}): Promise<string> {
	const queryParams = new URLSearchParams({ query: options.query }).toString();
	const response = await fetch(
		`http://127.0.0.1:${String(options.metricsPort)}/api/v1/query?${queryParams}`,
		{ signal: AbortSignal.timeout(10_000) },
	);
	if (!response.ok) {
		throw new Error(
			`VictoriaMetrics query failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
	return await response.text();
}

async function waitForVictoriaMetrics(options: {
	readonly metricsPort: number;
	readonly query: string;
	readonly expected: string;
}): Promise<string> {
	const deadlineMs = Date.now() + 30_000;
	let lastResponse = '';
	while (Date.now() < deadlineMs) {
		// oxlint-disable-next-line no-await-in-loop -- poll external storage until ingestion is visible
		lastResponse = await queryVictoriaMetrics(options);
		if (lastResponse.includes(options.expected)) {
			return lastResponse;
		}
		// oxlint-disable-next-line no-await-in-loop -- bounded external ingestion poll
		await waitForProtocolRetryInterval(500);
	}
	throw new Error(
		`Timed out waiting for VictoriaMetrics query '${options.query}'. Last response: ${lastResponse}`,
	);
}

async function queryVictoriaLogs(options: {
	readonly logsPort: number;
	readonly query: string;
}): Promise<string> {
	const body = new URLSearchParams({ query: options.query });
	const response = await fetch(`http://127.0.0.1:${String(options.logsPort)}/select/logsql/query`, {
		method: 'POST',
		body,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(
			`VictoriaLogs query failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
	return await response.text();
}

async function waitForVictoriaLogs(options: {
	readonly logsPort: number;
	readonly query: string;
}): Promise<string> {
	const deadlineMs = Date.now() + 30_000;
	let lastResponse = '';
	while (Date.now() < deadlineMs) {
		// oxlint-disable-next-line no-await-in-loop -- poll external storage until ingestion is visible
		lastResponse = await queryVictoriaLogs(options);
		if (lastResponse.trim().length > 0) {
			return lastResponse;
		}
		// oxlint-disable-next-line no-await-in-loop -- bounded external ingestion poll
		await waitForProtocolRetryInterval(500);
	}
	const sampleResponse = await queryVictoriaLogs({
		logsPort: options.logsPort,
		query: '*',
	});
	throw new Error(
		`Timed out waiting for VictoriaLogs query '${options.query}'. Last response: ${lastResponse}. Sample response: ${sampleResponse}`,
	);
}

async function queryVictoriaTraces(options: {
	readonly tracesPort: number;
	readonly query: string;
}): Promise<string> {
	const body = new URLSearchParams({ query: options.query });
	const response = await fetch(
		`http://127.0.0.1:${String(options.tracesPort)}/select/logsql/query`,
		{
			method: 'POST',
			body,
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`VictoriaTraces query failed with HTTP ${String(response.status)}: ${await response.text()}`,
		);
	}
	return await response.text();
}

async function waitForVictoriaTraces(options: {
	readonly tracesPort: number;
	readonly query: string;
	readonly expected: string;
}): Promise<string> {
	const deadlineMs = Date.now() + 30_000;
	let lastResponse = '';
	while (Date.now() < deadlineMs) {
		// oxlint-disable-next-line no-await-in-loop -- poll external storage until ingestion is visible
		lastResponse = await queryVictoriaTraces(options);
		if (lastResponse.includes(options.expected)) {
			return lastResponse;
		}
		// oxlint-disable-next-line no-await-in-loop -- bounded external ingestion poll
		await waitForProtocolRetryInterval(500);
	}
	throw new Error(
		`Timed out waiting for VictoriaTraces query '${options.query}'. Last response: ${lastResponse}`,
	);
}

function quoteVictoriaLogsPhrase(value: string): string {
	return JSON.stringify(value);
}

describe('smoke: observability Victoria storage canaries', () => {
	it('stores safe OpenTelemetry signals while dropping sensitive log canary attributes', async () => {
		const config = await createRuntimeConfig();
		const safeMarker = `agent-vm-safe-storage-marker-${Date.now()}`;
		const metricName = 'agent_vm_storage_canary_metric';
		const spanName = `agent-vm-storage-canary-span-${Date.now()}`;
		const traceIdHex = Date.now().toString(16).padStart(32, '0').slice(-32);
		const sensitiveBodyCanary = `agent-vm-sensitive-log-body-${Date.now()}`;
		const sensitiveCanaries = [
			`agent-vm-sensitive-authorization-${Date.now()}`,
			`agent-vm-sensitive-token-${Date.now()}`,
			`agent-vm-sensitive-payload-${Date.now()}`,
			`https://agent-vm-sensitive-user:${Date.now()}@example.com/path`,
		] as const;
		try {
			await prepareObservabilityStackWithDiagnostics(config);

			await waitForOtlpLogExport({
				collectorHttpPort: config.ports.collectorHttp,
				sensitiveBodyCanary,
				safeMarker,
				sensitiveCanaries,
			});
			await postOtlpMetric({
				collectorHttpPort: config.ports.collectorHttp,
				metricName,
				safeMarker,
				sensitiveCanaries,
			});
			await postOtlpTrace({
				collectorHttpPort: config.ports.collectorHttp,
				safeMarker,
				spanName,
				traceIdHex,
				sensitiveCanaries,
			});

			const safeQueryResult = await waitForVictoriaLogs({
				logsPort: config.ports.logs,
				query: `safe_marker:=${JSON.stringify(safeMarker)}`,
			});
			expect(safeQueryResult).toContain(safeMarker);
			const metricsQueryResult = await waitForVictoriaMetrics({
				metricsPort: config.ports.metrics,
				query: `${metricName}{safe_marker="${safeMarker}"}`,
				expected: metricName,
			});
			expect(metricsQueryResult).toContain(safeMarker);
			for (const sensitiveCanary of sensitiveCanaries) {
				expect(metricsQueryResult).not.toContain(sensitiveCanary);
			}
			const tracesQueryResult = await waitForVictoriaTraces({
				tracesPort: config.ports.traces,
				query: `{name="${spanName}"}`,
				expected: spanName,
			});
			expect(tracesQueryResult).toContain(traceIdHex);
			for (const sensitiveCanary of sensitiveCanaries) {
				expect(tracesQueryResult).not.toContain(sensitiveCanary);
			}
			const canaryQueryResults = await Promise.all(
				sensitiveCanaries.map(async (canary) => ({
					canary,
					result: await queryVictoriaLogs({
						logsPort: config.ports.logs,
						query: quoteVictoriaLogsPhrase(canary),
					}),
				})),
			);
			for (const { canary, result } of [
				...canaryQueryResults,
				{
					canary: sensitiveBodyCanary,
					result: await queryVictoriaLogs({
						logsPort: config.ports.logs,
						query: quoteVictoriaLogsPhrase(sensitiveBodyCanary),
					}),
				},
			]) {
				expect(result).not.toContain(canary);
			}
		} finally {
			await dockerComposeDown(config);
		}
	});

	it('stores controller telemetry from the real producer facade', async () => {
		const config = await createRuntimeConfig();
		const safeMarker = `agent-vm-controller-storage-marker-${Date.now()}`;
		const sensitiveCanaries = [
			`agent-vm-sensitive-token-${Date.now()}`,
			`agent-vm-sensitive-password-${Date.now()}`,
			`agent-vm-sensitive-payload-${Date.now()}`,
		] as const;
		try {
			await prepareObservabilityStackWithDiagnostics(config);

			const telemetry = startControllerTelemetry({
				identity: {
					branchName: 'feat/observability-producers',
					repositoryIdentity: 'agent-vm-observability-storage-canary-repo',
					runtimeFlavor: 'agent-vm',
					serviceVersion: '0.0.0-test',
					worktreeIdentity: 'agent-vm-observability-storage-canary-worktree',
				},
				observabilityConfig: config,
				projectNamespace: config.projectName,
				proof: {
					marker: safeMarker,
					startedAt: new Date().toISOString(),
					stateFile: path.join(config.runtimeDir, 'controller-telemetry-state.json'),
				},
			});
			if (telemetry === undefined) {
				throw new Error('Expected controller telemetry to start for enabled managed config.');
			}

			telemetry.recordControllerLifecycleEvent({
				eventName: 'storage-canary-started',
				observedAtMs: Date.now(),
			});
			telemetry.healthEventSink.record({
				agentId: sensitiveCanaries[0],
				elapsedMs: 12,
				errorCode: sensitiveCanaries[1],
				kind: 'tool-vm-ssh',
				leaseId: sensitiveCanaries[2],
				observedAtMs: Date.now(),
				operation: 'probe',
				result: 'timeout',
				zoneId: 'storage-canary',
			});
			await telemetry.forceFlush();
			await telemetry.shutdown();

			const logsQueryResult = await waitForVictoriaLogs({
				logsPort: config.ports.logs,
				query: `agent.proof.marker:=${JSON.stringify(safeMarker)}`,
			});
			expect(logsQueryResult).toContain('agent-vm-controller');
			expect(logsQueryResult).toContain('agent_vm.health_event');
			expect(logsQueryResult).toContain('agent_vm.log.name');
			expect(logsQueryResult).toContain(safeMarker);
			const metricsQueryResult = await waitForVictoriaMetrics({
				metricsPort: config.ports.metrics,
				query: 'agent_vm_health_events_total',
				expected: 'agent_vm_health_events_total',
			});
			expect(metricsQueryResult).toContain('agent_vm_health_events_total');
			expect(metricsQueryResult).toContain('storage-canary');
			const tracesQueryResult = await waitForVictoriaTraces({
				tracesPort: config.ports.traces,
				query: '"resource_attr:service.name":"agent-vm-controller"',
				expected: 'agent_vm.health.tool-vm-ssh',
			});
			expect(tracesQueryResult).toContain('agent_vm.health.tool-vm-ssh');
			expect(tracesQueryResult).toContain('agent-vm-controller');
			for (const sensitiveCanary of sensitiveCanaries) {
				expect(logsQueryResult).not.toContain(sensitiveCanary);
				expect(metricsQueryResult).not.toContain(sensitiveCanary);
				expect(tracesQueryResult).not.toContain(sensitiveCanary);
			}
		} finally {
			await dockerComposeDown(config);
		}
	});
});
