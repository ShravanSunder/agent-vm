import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { managedToolPortalConfigSchema, mcpConfigSchema } from '@agent-vm/config-contracts';
import { deriveGatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

interface ChildResult {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

type ProductionRootKind = 'agent-vm' | 'agent-vm-worker' | 'gateway-runtime' | 'mcp-portal';

interface ProductionRootChildDefinition {
	readonly category: readonly string[];
	readonly configuration: string;
	readonly adapterModulePath: string;
	readonly cliSupportModulePath?: string;
	readonly name: string;
	readonly packageRoot: string;
	readonly rootKind: ProductionRootKind;
	readonly rootModulePath: string;
	readonly systemConfigPath?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly gatewayConfigPath?: string;
	readonly mcpConfigDir?: string;
	readonly workerConfigPath?: string;
}

interface OtlpReceiver {
	readonly close: () => Promise<void>;
	readonly endpoint: string;
	readonly requests: Buffer[];
}

type OtlpAttributeValue =
	| { readonly kind: 'integer'; readonly value: number }
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'string-array'; readonly value: readonly string[] };

interface OtlpLogRecord {
	readonly attributes: ReadonlyMap<string, OtlpAttributeValue>;
	readonly body: string;
	readonly severityNumber: number;
	readonly severityText: string;
}

interface StructuredStderrAssertionOptions {
	readonly allowedPlainLinePattern?: RegExp;
}

const repositoryRoot = path.resolve(process.cwd());
const childCompletionMarker = 'structured-logging-host-proof-complete\n';

function packageDistPath(...segments: readonly string[]): string {
	return path.join(repositoryRoot, ...segments);
}

function createAgentVmObservabilityConfig(collectorHttpPort: number): string {
	return JSON.stringify({
		bindAddress: '127.0.0.1',
		controllerStartPolicy: 'off',
		enabled: true,
		ports: { collectorHttp: collectorHttpPort },
		prepareOnBuild: false,
		runtimeDir: '/tmp/agent-vm-structured-logging-proof',
		stackMode: 'external',
		startupCheckTimeoutMs: 1,
		waitOnBuild: false,
		zones: [],
	});
}

function createGatewayObservabilityConfig(endpoint: string): string {
	return JSON.stringify({
		admissionLimits: {
			maxExportBatchRecords: 64,
			maxQueuedRecordsPerSignal: 256,
			maxRecordBytes: 65_536,
		},
		endpoint,
		flushIntervalMs: 1,
		kind: 'otlp-http',
		logs: true,
		metrics: true,
		sampleRate: 1,
		serviceName: 'agent-vm-tool-portal',
		sourcePolicy: { admitBaggage: false, captureContent: false },
		traces: true,
	});
}

function createProductionRootChildCode(definition: ProductionRootChildDefinition): string {
	const category = JSON.stringify(definition.category);
	const rootKind = JSON.stringify(definition.rootKind);
	const mcpConfigDir = JSON.stringify(definition.mcpConfigDir);
	const cliSupportModulePath = JSON.stringify(definition.cliSupportModulePath);
	const systemConfigPath = JSON.stringify(definition.systemConfigPath);
	const workerConfigPath = JSON.stringify(definition.workerConfigPath);
	return `
const { getLogger } = await import('@logtape/logtape');
const adapter = await import(${JSON.stringify(definition.adapterModulePath)});
const root = await import(${JSON.stringify(definition.rootModulePath)});
const category = ${category};
const emitRecord = () => getLogger(category).warning('Structured logging host proof record.', {
\tevent: 'host-proof',
\tattempt: 1,
});
if (${rootKind} === 'agent-vm') {
\tconst { defaultCliDependencies } = await import(${cliSupportModulePath});
\tconst originalWrite = process.stdout.write.bind(process.stdout);
\tlet shutdownScheduled = false;
\tprocess.stdout.write = ((chunk, ...args) => {
\t\tconst result = originalWrite(chunk, ...args);
\t\tif (!shutdownScheduled && String(chunk).includes('"zoneId": "host-proof"')) {
\t\t\tshutdownScheduled = true;
\t\t\tvoid (async () => {
\t\t\t\tconst readiness = JSON.parse(String(chunk));
\t\t\t\tconst healthResponse = await fetch(
\t\t\t\t\t'http://127.0.0.1:' + String(readiness.controllerPort) + '/health',
\t\t\t\t\t{ signal: AbortSignal.timeout(2_000) },
\t\t\t\t);
\t\t\t\tif (!healthResponse.ok) {
\t\t\t\t\tthrow new Error('Controller health probe did not report readiness.');
\t\t\t\t}
\t\t\t\temitRecord();
\t\t\t\tsetImmediate(() => process.kill(process.pid, 'SIGTERM'));
\t\t\t})().catch((error) => {
\t\t\t\tprocess.stderr.write(
\t\t\t\t\t'Controller host-proof listener check failed: ' +
\t\t\t\t\t(error instanceof Error ? error.message : String(error)) +
\t\t\t\t\t'\\n',
\t\t\t\t);
\t\t\t\tprocess.exitCode = 1;
\t\t\t\tsetImmediate(() => process.kill(process.pid, 'SIGTERM'));
\t\t\t});
\t\t}
\t\treturn result;
\t});
\tawait root.runAgentVmCli(
\t\t['controller', 'start', '--config', ${systemConfigPath}, '--zone', 'host-proof'],
\t\t{ stderr: process.stderr, stdout: process.stdout },
\t\t{
\t\t\t...defaultCliDependencies,
\t\t\tisGatewayImageCached: async () => true,
\t\t},
\t\t{ processLoggingStderr: process.stderr, processRoot: true },
\t);
\tprocess.stdout.write = originalWrite;
\tprocess.stdout.write(${JSON.stringify(childCompletionMarker)});
} else if (${rootKind} === 'agent-vm-worker') {
\tconst originalWrite = process.stdout.write.bind(process.stdout);
\tlet shutdownScheduled = false;
\tprocess.stdout.write = ((chunk, ...args) => {
\t\tconst result = originalWrite(chunk, ...args);
\t\tif (!shutdownScheduled && String(chunk).includes('[agent-vm-worker] Server listening on')) {
\t\t\tshutdownScheduled = true;
\t\t\temitRecord();
\t\t\tsetImmediate(() => process.kill(process.pid, 'SIGTERM'));
\t\t}
\t\treturn result;
\t});
\tawait root.runWorkerProcess({
\t\targv: ['serve', '--config', ${workerConfigPath}, '--port', '0'],
\t\tio: { stderr: process.stderr, stdout: process.stdout },
\t});
\tprocess.stdout.write = originalWrite;
\tprocess.stdout.write(${JSON.stringify(childCompletionMarker)});
} else if (${rootKind} === 'gateway-runtime') {
\tawait root.runGatewayRuntimeStartLifecycle({
\t\tconfig: ${definition.configuration},
\t\tconfigureLogging: async (config) => await adapter.configureProcessLogging({ ...config, stderr: process.stderr }),
\t\tstartService: async () => { emitRecord(); return { readiness: { kind: 'host-proof-ready' }, retire: async () => ({ kind: 'host-proof-retired' }) }; },
\t\twaitForRetirementSignal: async () => ({ cleanup: () => undefined, signal: 'SIGTERM' }),
\t\twriteFatalEvidence: async () => undefined,
\t\twriteStderr: (text) => process.stderr.write(text),
\t\twriteStdout: (text) => process.stdout.write(text),
\t});
\tprocess.stdout.write(${JSON.stringify(childCompletionMarker)});
} else {
\tconst originalWrite = process.stdout.write.bind(process.stdout);
\tprocess.stdout.write = ((chunk, ...args) => {
\t\tconst result = originalWrite(chunk, ...args);
\t\tif (String(chunk).startsWith('listening port=')) {
\t\t\temitRecord();
\t\t\tsetImmediate(() => process.kill(process.pid, 'SIGTERM'));
\t\t}
\t\treturn result;
\t});
\tawait root.runMcpPortal(['mcp-proxy', 'serve', '--config-dir', ${mcpConfigDir}, '--port', '0'], { env: process.env });
\tprocess.stdout.write = originalWrite;
\tprocess.stdout.write(${JSON.stringify(childCompletionMarker)});
}
`;
}

function createGatewayHostProofPreload(definition: ProductionRootChildDefinition): string {
	const logtapeModulePath = pathToFileURL(
		path.join(definition.packageRoot, 'node_modules', '@logtape', 'logtape', 'dist', 'mod.js'),
	).href;
	const source = `
import { getLogger } from ${JSON.stringify(logtapeModulePath)};
const logger = getLogger(${JSON.stringify(definition.category)});
const originalWrite = process.stdout.write.bind(process.stdout);
let stdoutBuffer = '';
let hostProofEmitted = false;
process.stdout.write = ((chunk, ...args) => {
	const result = originalWrite(chunk, ...args);
	if (!hostProofEmitted) {
		stdoutBuffer += String(chunk);
		if (stdoutBuffer.includes('tool-portal-role-readiness')) {
			hostProofEmitted = true;
			logger.warning('Structured logging host proof record.', {
				event: 'host-proof',
				attempt: 1,
			});
		}
	}
	return result;
});
`;
	return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function runProductionRootChild(
	definition: ProductionRootChildDefinition,
): Promise<ChildResult> {
	const childArguments =
		definition.rootKind === 'gateway-runtime'
			? [definition.rootModulePath, '--config', definition.gatewayConfigPath ?? '']
			: ['--input-type=module', '--eval', createProductionRootChildCode(definition)];
	const gatewayHostProofImport =
		definition.rootKind === 'gateway-runtime'
			? `--import=${createGatewayHostProofPreload(definition)}`
			: undefined;
	const nodeOptions = [process.env.NODE_OPTIONS, gatewayHostProofImport]
		.filter((value): value is string => value !== undefined && value.length > 0)
		.join(' ');
	const child = spawn(process.execPath, childArguments, {
		cwd: definition.packageRoot,
		env: {
			...process.env,
			...(nodeOptions.length === 0 ? {} : { NODE_OPTIONS: nodeOptions }),
			OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: undefined,
			OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
			...definition.environment,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 20_000,
	});
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let gatewayRetirementRequested = false;
	child.stdout.on('data', (chunk: Buffer) => {
		stdoutChunks.push(chunk);
		if (
			definition.rootKind === 'gateway-runtime' &&
			!gatewayRetirementRequested &&
			Buffer.concat(stdoutChunks).includes('tool-portal-role-readiness')
		) {
			gatewayRetirementRequested = true;
			setImmediate(() => child.kill('SIGTERM'));
		}
	});
	child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
	const [exitCode] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
	return {
		exitCode,
		stderr: Buffer.concat(stderrChunks).toString('utf8'),
		stdout: Buffer.concat(stdoutChunks).toString('utf8'),
	};
}

async function createOtlpReceiver(): Promise<OtlpReceiver> {
	const requests: Buffer[] = [];
	const server = createServer((request, response): void => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', (): void => {
			requests.push(Buffer.concat(chunks));
			response.statusCode = 200;
			response.end();
		});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') {
		server.close();
		throw new Error('Structured logging OTLP receiver did not expose a TCP address.');
	}
	return {
		close: async (): Promise<void> => {
			server.close();
			await once(server, 'close');
		},
		endpoint: `http://127.0.0.1:${String(address.port)}/v1/logs`,
		requests,
	};
}

async function allocateTcpPort(): Promise<number> {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') {
		server.close();
		throw new Error('Structured logging host proof could not allocate a TCP port.');
	}
	const closePromise = once(server, 'close');
	server.close();
	await closePromise;
	return address.port;
}

function assertStructuredStderr(
	result: ChildResult,
	expectedLogger: string,
	options: StructuredStderrAssertionOptions = {},
): void {
	expect(result.exitCode, `${expectedLogger} stderr: ${result.stderr}`).toBe(0);
	expect(result.stdout, `${expectedLogger} stderr: ${result.stderr}`).toContain(
		childCompletionMarker,
	);
	const lines = result.stderr
		.trim()
		.split('\n')
		.filter((line) => line.length > 0);
	expect(
		lines.length,
		`${expectedLogger} stdout: ${result.stdout} stderr: ${result.stderr}`,
	).toBeGreaterThanOrEqual(1);
	const structuredLines = lines.filter((line) => line.startsWith('{'));
	const plainLines = lines.filter((line) => !line.startsWith('{'));
	if (options.allowedPlainLinePattern === undefined) {
		expect(plainLines).toEqual([]);
	} else {
		expect(
			plainLines.every((line) => options.allowedPlainLinePattern?.test(line)),
			`${expectedLogger} unexpected plain stderr: ${plainLines.join(' | ')}`,
		).toBe(true);
	}
	const records = structuredLines.map((line) => JSON.parse(line) as Record<string, unknown>);
	expect(records).toContainEqual(
		expect.objectContaining({
			level: 'WARN',
			logger: expectedLogger,
			message: 'Structured logging host proof record.',
			properties: { attempt: 1, event: 'host-proof' },
		}),
	);
}

function assertGatewayStartupFailure(result: ChildResult): void {
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe('');
	expect(result.stderr).toContain('Gateway runtime service failed.\n');
	const structuredLines = result.stderr
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
	expect(structuredLines).toContainEqual(
		expect.objectContaining({
			level: 'ERROR',
			logger: 'agent-vm.gateway-runtime.process',
			message: 'Gateway runtime service startup failed.',
			properties: { event: 'startup-failed', failureClass: 'startup' },
		}),
	);
}

function assertGatewayRuntimeSuccess(result: ChildResult): void {
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain('tool-portal-role-readiness');
	expect(result.stdout).toContain('"kind":"retired"');
	const structuredLines = result.stderr
		.trim()
		.split('\n')
		.filter((line) => line.length > 0);
	expect(structuredLines).toHaveLength(1);
	expect(JSON.parse(structuredLines[0] ?? '')).toEqual(
		expect.objectContaining({
			level: 'WARN',
			logger: 'agent-vm.gateway-runtime.process',
			message: 'Structured logging host proof record.',
			properties: { attempt: 1, event: 'host-proof' },
		}),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readOtlpAttributeValue(value: unknown): OtlpAttributeValue | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.stringValue === 'string') {
		return { kind: 'string', value: value.stringValue };
	}
	const integerValue = value.intValue;
	if (typeof integerValue === 'number' && Number.isInteger(integerValue)) {
		return { kind: 'integer', value: integerValue };
	}
	if (typeof integerValue === 'string' && integerValue.length > 0) {
		const parsedInteger = Number(integerValue);
		if (Number.isInteger(parsedInteger)) {
			return { kind: 'integer', value: parsedInteger };
		}
	}
	if (!isRecord(value.arrayValue) || !Array.isArray(value.arrayValue.values)) {
		return undefined;
	}
	const stringValues: string[] = [];
	for (const item of value.arrayValue.values) {
		if (!isRecord(item) || typeof item.stringValue !== 'string') {
			return undefined;
		}
		stringValues.push(item.stringValue);
	}
	return { kind: 'string-array', value: stringValues };
}

function readOtlpAttributes(value: unknown): ReadonlyMap<string, OtlpAttributeValue> {
	const attributes = new Map<string, OtlpAttributeValue>();
	if (!Array.isArray(value)) {
		return attributes;
	}
	for (const item of value) {
		if (!isRecord(item) || typeof item.key !== 'string') {
			continue;
		}
		const parsedValue = readOtlpAttributeValue(item.value);
		if (parsedValue !== undefined) {
			attributes.set(item.key, parsedValue);
		}
	}
	return attributes;
}

function readOtlpJsonLogRecords(request: Buffer): readonly OtlpLogRecord[] {
	let payload: unknown;
	try {
		payload = JSON.parse(request.toString('utf8')) as unknown;
	} catch {
		return [];
	}
	if (!isRecord(payload) || !Array.isArray(payload.resourceLogs)) {
		return [];
	}
	const records: OtlpLogRecord[] = [];
	for (const resourceLog of payload.resourceLogs) {
		if (!isRecord(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) {
			continue;
		}
		for (const scopeLog of resourceLog.scopeLogs) {
			if (!isRecord(scopeLog) || !Array.isArray(scopeLog.logRecords)) {
				continue;
			}
			for (const logRecord of scopeLog.logRecords) {
				if (!isRecord(logRecord) || !isRecord(logRecord.body)) {
					continue;
				}
				const severityNumber = logRecord.severityNumber;
				const severityText = logRecord.severityText;
				const body = logRecord.body.stringValue;
				if (
					typeof severityNumber !== 'number' ||
					!Number.isInteger(severityNumber) ||
					typeof severityText !== 'string' ||
					typeof body !== 'string'
				) {
					continue;
				}
				records.push({
					attributes: readOtlpAttributes(logRecord.attributes),
					body,
					severityNumber,
					severityText,
				});
			}
		}
	}
	return records;
}

function isExpectedOtlpHostProofRecord(
	record: OtlpLogRecord,
	category: readonly string[],
): boolean {
	const categoryAttribute = record.attributes.get('category');
	const eventAttribute = record.attributes.get('event');
	const attemptAttribute = record.attributes.get('attempt');
	return (
		record.body === 'Structured logging host proof record.' &&
		record.severityNumber === 13 &&
		record.severityText === 'warning' &&
		record.attributes.size === 3 &&
		categoryAttribute?.kind === 'string-array' &&
		categoryAttribute.value.join('.') === category.join('.') &&
		eventAttribute?.kind === 'string' &&
		eventAttribute.value === 'host-proof' &&
		attemptAttribute?.kind === 'integer' &&
		attemptAttribute.value === 1
	);
}

function assertOtlpHostProofRecord(
	requestWindow: readonly Buffer[],
	category: readonly string[],
): void {
	const records = requestWindow.flatMap((request) => readOtlpJsonLogRecords(request));
	expect(
		records.some((record) => isExpectedOtlpHostProofRecord(record, category)),
		`OTLP request window did not contain the expected ${category.join('.')} record`,
	).toBe(true);
}

async function createMcpPortalProofConfigDir(): Promise<string> {
	const configDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-logtape-mcp-proof-'));
	await writeFile(
		path.join(configDir, 'mcp.config.jsonc'),
		JSON.stringify({ providers: {}, schemaVersion: 1 }),
		'utf8',
	);
	await writeFile(
		path.join(configDir, 'mcp-portal.config.jsonc'),
		JSON.stringify({
			agents: { host: { profile: 'default' } },
			externalAuth: {
				masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
			},
			mcpProxy: {
				auth: { headerName: 'authorization' },
				server: { host: '127.0.0.1', port: 18_791 },
			},
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		}),
		'utf8',
	);
	return configDir;
}

interface AgentVmProofFixture {
	readonly configPath: string;
	readonly root: string;
}

async function createAgentVmProofFixture(collectorHttpPort: number): Promise<AgentVmProofFixture> {
	const root = await mkdtemp(path.join(tmpdir(), 'agent-vm-logtape-controller-proof-'));
	const controllerPort = await allocateTcpPort();
	const configDirectory = path.join(root, 'config');
	const storageDirectory = path.join(root, 'storage');
	await Promise.all([mkdir(configDirectory), mkdir(storageDirectory)]);
	const configPath = path.join(configDirectory, 'system.json');
	await writeFile(
		configPath,
		JSON.stringify({
			host: {
				controllerPort,
				observability: {
					controllerStartPolicy: 'off',
					enabled: true,
					ports: { collectorHttp: collectorHttpPort },
					stack: {
						mode: 'external',
						scrubbing: { responsibility: 'external-collector' },
					},
				},
				projectNamespace: 'structured-logging-proof',
			},
			imageProfiles: {
				gateways: {
					worker: {
						buildConfig: '../vm-images/worker/build-config.json',
						type: 'worker',
					},
				},
				toolVms: {},
			},
			schemaVersion: 2,
			storageRootDir: storageDirectory,
			tcpPool: { basePort: 19_000, size: 1 },
			toolVmProfiles: {},
			zones: [
				{
					egressHosts: [{ audience: 'gateway', host: 'example.com' }],
					gateway: {
						config: '../gateway/worker.json',
						cpus: 1,
						imageProfile: 'worker',
						memory: '1G',
						port: 18_791,
						type: 'worker',
					},
					id: 'host-proof',
					secrets: {},
				},
			],
		}),
		{ mode: 0o600 },
	);
	return { configPath, root };
}

interface WorkerProofFixture {
	readonly configPath: string;
	readonly root: string;
	readonly workDirectory: string;
}

interface GatewayRuntimeProofFixture {
	readonly configPath: string;
	readonly root: string;
	readonly runtimeRoot: string;
}

async function createGatewayRuntimeProofFixture(options: {
	readonly collectorEndpoint: string;
	readonly failStartup: boolean;
}): Promise<GatewayRuntimeProofFixture> {
	const root = await mkdtemp(path.join(tmpdir(), 'av-log-gw-'));
	const runtimeRoot = path.join(root, 'run');
	await mkdir(runtimeRoot, { mode: 0o700 });
	const mcpConfigPath = path.join(runtimeRoot, 'mcp.config.json');
	const mcpConfig = mcpConfigSchema.parse({ providers: {}, schemaVersion: 1 });
	const toolPortalConfig = managedToolPortalConfigSchema.parse({
		agents: {
			'agent-a': { profile: 'profile-a' },
			'agent-b': { profile: 'profile-b' },
		},
		mode: 'managed',
		profiles: {
			'profile-a': { namespaces: {} },
			'profile-b': { namespaces: {} },
		},
		schemaVersion: 1,
	});
	const semanticSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: [
			{
				agentId: 'agent-a',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
				toolPortalNamespaceNames: [],
				toolPortalProfileId: 'profile-a',
			},
			{
				agentId: 'agent-b',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-b-profile' },
				toolPortalNamespaceNames: [],
				toolPortalProfileId: 'profile-b',
			},
		],
		mcpConfig,
		surfaceEligibilityByProfile: { 'profile-a': {}, 'profile-b': {} },
		toolPortalConfig,
	});
	await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
	const { publicKey } = generateKeyPairSync('ed25519');
	const configPath = path.join(runtimeRoot, 'service.json');
	await writeFile(
		configPath,
		JSON.stringify({
			artifactLimits: {
				maximumArtifactBytes: 1_024,
				maximumArtifactCount: 8,
				maximumLifetimeMs: 60_000,
				maximumTotalBytes: 8_192,
			},
			attachment: {
				attachmentGeneration: 1,
				clientKind: 'hermes-managed-plugin',
				configuredAgentIds: ['agent-a', 'agent-b'],
				frameworkEpoch: 'framework-epoch-host-proof',
				gatewayEpoch: 'gateway-epoch-host-proof',
				projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
				runtimeEpoch: 'runtime-epoch-host-proof',
			},
			controlEndpoint: {
				authority: {
					callerContextAgentAuthorityKeys: {
						'agent-a': 'agent-a-authority-key',
						'agent-b': 'agent-b-authority-key',
					},
					callerContextProofKey: 'caller-context-proof-key',
					verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
				},
				identity: {
					bootId: 'boot-host-proof',
					controllerEpoch: 'controller-epoch-host-proof',
					generationId: 'generation-host-proof',
					peerId: 'peer-host-proof',
					processEpoch: 'process-epoch-host-proof',
					zoneId: 'zone-host-proof',
				},
				listen: { host: '127.0.0.1', port: 0 },
			},
			mcpConfigPath,
			observability: {
				admissionLimits: {
					maxExportBatchRecords: 64,
					maxQueuedRecordsPerSignal: 256,
					maxRecordBytes: 65_536,
				},
				endpoint: new URL(options.collectorEndpoint).origin,
				flushIntervalMs: 1,
				kind: 'otlp-http',
				logs: true,
				metrics: false,
				sampleRate: 1,
				serviceName: 'agent-vm-tool-portal',
				sourcePolicy: { admitBaggage: false, captureContent: false },
				traces: false,
			},
			runtimeRoot,
			schemaVersion: 1,
			semanticSnapshot,
			serviceIdentity: {
				processEpoch: 'process-epoch-host-proof',
				role: 'tool-portal',
				serviceId: 'tool-portal-host-proof',
			},
			toolPortalConfig,
		}),
		{ mode: 0o600 },
	);
	if (options.failStartup) {
		await mkdir(path.join(runtimeRoot, 'tool-portal.readiness.json'), { mode: 0o700 });
	}
	return { configPath, root, runtimeRoot };
}

async function createWorkerProofFixture(): Promise<WorkerProofFixture> {
	const root = await mkdtemp(path.join(tmpdir(), 'agent-vm-logtape-worker-proof-'));
	const stateDirectory = path.join(root, 'state');
	const workDirectory = path.join(root, 'work');
	await Promise.all([mkdir(stateDirectory), mkdir(workDirectory)]);
	const configPath = path.join(root, 'worker.json');
	await writeFile(
		configPath,
		JSON.stringify({
			commonAgentInstructions: null,
			phases: {
				plan: {
					agentInstructions: null,
					cycle: { kind: 'noReview' },
					reviewerInstructions: null,
				},
				work: {
					agentInstructions: null,
					cycle: { cycleCount: 1, kind: 'review' },
					reviewerInstructions: null,
				},
				wrapup: { instructions: null },
			},
			runtimeInstructions: 'Structured logging host proof runtime.',
			stateDir: stateDirectory,
		}),
		'utf8',
	);
	return { configPath, root, workDirectory };
}

describe('structured logging process roots', () => {
	it('keeps four built process children on JSONL stderr and protected stdout', async () => {
		const receiver = await createOtlpReceiver();
		const mcpConfigDir = await createMcpPortalProofConfigDir();
		const workerFixture = await createWorkerProofFixture();
		const controllerFixture = await createAgentVmProofFixture(
			Number(new URL(receiver.endpoint).port),
		);
		const gatewayFixture = await createGatewayRuntimeProofFixture({
			collectorEndpoint: receiver.endpoint,
			failStartup: false,
		});
		const failingGatewayFixture = await createGatewayRuntimeProofFixture({
			collectorEndpoint: receiver.endpoint,
			failStartup: true,
		});
		try {
			const collectorUrl = receiver.endpoint;
			const children = [
				{
					category: ['agent-vm', 'controller', 'runtime'],
					configuration: `{ observabilityConfig: ${createAgentVmObservabilityConfig(Number(new URL(collectorUrl).port))}, serviceName: 'agent-vm-host-proof', stderr: process.stderr }`,
					adapterModulePath: packageDistPath(
						'packages',
						'agent-vm',
						'dist',
						'observability',
						'process-logging.js',
					),
					cliSupportModulePath: packageDistPath(
						'packages',
						'agent-vm',
						'dist',
						'cli',
						'agent-vm-cli-support.js',
					),
					name: 'agent-vm',
					packageRoot: packageDistPath('packages', 'agent-vm'),
					rootKind: 'agent-vm',
					rootModulePath: packageDistPath(
						'packages',
						'agent-vm',
						'dist',
						'cli',
						'agent-vm-entrypoint.js',
					),
					systemConfigPath: controllerFixture.configPath,
				},
				{
					category: ['agent-vm', 'worker', 'server'],
					configuration: '{ stderr: process.stderr }',
					environment: {
						AGENT_VM_WORKER_CONTROL_BOOT_ID: undefined,
						AGENT_VM_WORKER_CONTROL_CONTROLLER_EPOCH: undefined,
						AGENT_VM_WORKER_CONTROL_GENERATION_ID: undefined,
						AGENT_VM_WORKER_CONTROL_PEER_ID: undefined,
						AGENT_VM_WORKER_CONTROL_PUBLIC_KEY_PEM: undefined,
						AGENT_VM_ZONE_ID: undefined,
						MCP_PORTAL_MASTER_KEY:
							'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
						OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collectorUrl,
						WORK_DIR: workerFixture.workDirectory,
					},
					adapterModulePath: packageDistPath(
						'packages',
						'agent-vm-worker',
						'dist',
						'shared',
						'process-logging.js',
					),
					name: 'agent-vm-worker',
					packageRoot: packageDistPath('packages', 'agent-vm-worker'),
					rootKind: 'agent-vm-worker',
					rootModulePath: packageDistPath('packages', 'agent-vm-worker', 'dist', 'main.js'),
					workerConfigPath: workerFixture.configPath,
				},
				{
					category: ['agent-vm', 'gateway-runtime', 'process'],
					configuration: `{ observability: ${createGatewayObservabilityConfig(collectorUrl)} }`,
					adapterModulePath: packageDistPath(
						'packages',
						'gateway-runtime',
						'dist',
						'production',
						'process-logging.js',
					),
					name: 'gateway-runtime',
					packageRoot: packageDistPath('packages', 'gateway-runtime'),
					rootKind: 'gateway-runtime',
					gatewayConfigPath: gatewayFixture.configPath,
					rootModulePath: packageDistPath(
						'packages',
						'gateway-runtime',
						'dist',
						'bin',
						'gateway-runtime.js',
					),
				},
				{
					category: ['agent-vm', 'mcp-portal', 'server'],
					configuration: '{ stderr: process.stderr }',
					environment: {
						MCP_PORTAL_MASTER_KEY:
							'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
						OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collectorUrl,
					},
					adapterModulePath: packageDistPath(
						'packages',
						'mcp-portal',
						'dist',
						'cli',
						'process-logging.js',
					),
					name: 'mcp-portal',
					packageRoot: packageDistPath('packages', 'mcp-portal'),
					rootKind: 'mcp-portal',
					rootModulePath: packageDistPath('packages', 'mcp-portal', 'dist', 'bin', 'mcp-portal.js'),
					mcpConfigDir,
				},
			] satisfies readonly ProductionRootChildDefinition[];

			let requestWindowStart = receiver.requests.length;
			for (const child of children) {
				// oxlint-disable-next-line no-await-in-loop -- each child owns the next causal OTLP request window.
				const result = await runProductionRootChild(child);
				if (child.rootKind === 'gateway-runtime') {
					assertGatewayRuntimeSuccess(result);
				} else {
					assertStructuredStderr(
						result,
						child.category.join('.'),
						child.rootKind === 'agent-vm'
							? {
									allowedPlainLinePattern:
										/^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time|\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)| {0,2}(?:Resolving 1Password secrets|Controller API on :\d+|Starting selected gateway zones)(?:\.\.\.| done)?)$/u,
								}
							: {},
					);
				}
				if (child.rootKind === 'agent-vm-worker') {
					expect(result.stdout).toContain('[agent-vm-worker] Server listening on');
				}
				if (child.rootKind === 'agent-vm') {
					expect(result.stdout).toContain('"ingress": null');
					expect(result.stdout).toContain('"vmId": null');
					expect(result.stdout).toContain('"zoneId": "host-proof"');
				}
				assertOtlpHostProofRecord(receiver.requests.slice(requestWindowStart), child.category);
				requestWindowStart = receiver.requests.length;
			}
			const failureRequestWindowStart = receiver.requests.length;
			const gatewayFailureResult = await runProductionRootChild({
				category: ['agent-vm', 'gateway-runtime', 'process'],
				configuration: '{}',
				adapterModulePath: packageDistPath(
					'packages',
					'gateway-runtime',
					'dist',
					'production',
					'process-logging.js',
				),
				gatewayConfigPath: failingGatewayFixture.configPath,
				name: 'gateway-runtime-startup-failure',
				packageRoot: packageDistPath('packages', 'gateway-runtime'),
				rootKind: 'gateway-runtime',
				rootModulePath: packageDistPath(
					'packages',
					'gateway-runtime',
					'dist',
					'bin',
					'gateway-runtime.js',
				),
			});
			assertGatewayStartupFailure(gatewayFailureResult);
			expect(receiver.requests.length).toBeGreaterThan(failureRequestWindowStart);
		} finally {
			await receiver.close();
			await Promise.all([
				rm(controllerFixture.root, { force: true, recursive: true }),
				rm(failingGatewayFixture.root, { force: true, recursive: true }),
				rm(gatewayFixture.root, { force: true, recursive: true }),
				rm(mcpConfigDir, { force: true, recursive: true }),
				rm(workerFixture.root, { force: true, recursive: true }),
			]);
		}
	});

	it('keeps product success when the OTLP receiver is unavailable', async () => {
		const receiver = await createOtlpReceiver();
		const unavailableEndpoint = receiver.endpoint;
		await receiver.close();
		const workerFixture = await createWorkerProofFixture();
		try {
			const result = await runProductionRootChild({
				category: ['agent-vm', 'worker', 'server'],
				configuration: '{ stderr: process.stderr }',
				environment: {
					OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: unavailableEndpoint,
					WORK_DIR: workerFixture.workDirectory,
				},
				adapterModulePath: packageDistPath(
					'packages',
					'agent-vm-worker',
					'dist',
					'shared',
					'process-logging.js',
				),
				name: 'agent-vm-worker-unavailable-collector',
				packageRoot: packageDistPath('packages', 'agent-vm-worker'),
				rootKind: 'agent-vm-worker',
				rootModulePath: packageDistPath('packages', 'agent-vm-worker', 'dist', 'main.js'),
				workerConfigPath: workerFixture.configPath,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(childCompletionMarker);
			expect(result.stderr).not.toContain('Failed to initialize OpenTelemetry logger');
		} finally {
			await rm(workerFixture.root, { force: true, recursive: true });
		}
	});

	it('keeps structured stderr when no OTLP endpoint is configured', async () => {
		const workerFixture = await createWorkerProofFixture();
		try {
			const result = await runProductionRootChild({
				category: ['agent-vm', 'worker', 'server'],
				configuration: '{ stderr: process.stderr }',
				environment: { WORK_DIR: workerFixture.workDirectory },
				adapterModulePath: packageDistPath(
					'packages',
					'agent-vm-worker',
					'dist',
					'shared',
					'process-logging.js',
				),
				name: 'agent-vm-worker-no-endpoint',
				packageRoot: packageDistPath('packages', 'agent-vm-worker'),
				rootKind: 'agent-vm-worker',
				rootModulePath: packageDistPath('packages', 'agent-vm-worker', 'dist', 'main.js'),
				workerConfigPath: workerFixture.configPath,
			});
			assertStructuredStderr(result, 'agent-vm.worker.server');
		} finally {
			await rm(workerFixture.root, { force: true, recursive: true });
		}
	});
});
