import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
	readonly name: string;
	readonly packageRoot: string;
	readonly rootKind: ProductionRootKind;
	readonly rootModulePath: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly mcpConfigDir?: string;
}

interface OtlpReceiver {
	readonly close: () => Promise<void>;
	readonly endpoint: string;
	readonly requests: string[];
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
\tawait root.runControllerStartLifecycle({
\t\tio: { stderr: process.stderr, stdout: process.stdout },
\t\tlogging: await adapter.configureProcessLogging(${definition.configuration}),
\t\truntime: { controllerPort: 18800, zones: [], close: async () => undefined },
\t\tselectedZoneId: 'host-proof',
\t\twaitForShutdownSignal: async () => { emitRecord(); process.stdout.write(${JSON.stringify(childCompletionMarker)}); },
\t});
} else if (${rootKind} === 'agent-vm-worker') {
\tawait root.runWorkerProcess({
\t\targv: ['serve'],
\t\tio: { stderr: process.stderr, stdout: process.stdout },
\t\toperations: {
\t\t\trunHealth: async () => undefined,
\t\t\trunServe: async () => { emitRecord(); process.stdout.write(${JSON.stringify(childCompletionMarker)}); },
\t\t},
\t});
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
\t\t\tsetTimeout(() => process.kill(process.pid, 'SIGTERM'), 1000);
\t\t}
\t\treturn result;
\t});
\tawait root.runMcpPortal(['mcp-proxy', 'serve', '--config-dir', ${mcpConfigDir}, '--port', '0'], { env: process.env });
\tprocess.stdout.write = originalWrite;
\tprocess.stdout.write(${JSON.stringify(childCompletionMarker)});
}
`;
}

async function runProductionRootChild(
	definition: ProductionRootChildDefinition,
): Promise<ChildResult> {
	const child = spawn(
		process.execPath,
		['--input-type=module', '--eval', createProductionRootChildCode(definition)],
		{
			cwd: definition.packageRoot,
			env: {
				...process.env,
				OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
				OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: undefined,
				...definition.environment,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 20_000,
		},
	);
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
	child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
	const [exitCode] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
	return {
		exitCode,
		stderr: Buffer.concat(stderrChunks).toString('utf8'),
		stdout: Buffer.concat(stdoutChunks).toString('utf8'),
	};
}

async function createOtlpReceiver(): Promise<OtlpReceiver> {
	const requests: string[] = [];
	const server = createServer((request, response): void => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', (): void => {
			requests.push(Buffer.concat(chunks).toString('utf8'));
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

function assertStructuredStderr(result: ChildResult, expectedLogger: string): void {
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
	const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
	expect(records).toContainEqual(
		expect.objectContaining({
			level: 'WARN',
			logger: expectedLogger,
			message: 'Structured logging host proof record.',
			properties: { attempt: 1, event: 'host-proof' },
		}),
	);
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOtlpCategories(request: string): readonly (readonly string[])[] {
	const parsed: unknown = JSON.parse(request);
	if (!isObjectRecord(parsed) || !Array.isArray(parsed.resourceLogs)) {
		return [];
	}
	const categories: (readonly string[])[] = [];
	for (const resourceLog of parsed.resourceLogs) {
		if (!isObjectRecord(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) continue;
		for (const scopeLog of resourceLog.scopeLogs) {
			if (!isObjectRecord(scopeLog) || !Array.isArray(scopeLog.logRecords)) continue;
			for (const logRecord of scopeLog.logRecords) {
				if (!isObjectRecord(logRecord) || !Array.isArray(logRecord.attributes)) continue;
				for (const attribute of logRecord.attributes) {
					if (!isObjectRecord(attribute) || attribute.key !== 'category') continue;
					if (!isObjectRecord(attribute.value) || !isObjectRecord(attribute.value.arrayValue)) {
						continue;
					}
					const values = attribute.value.arrayValue.values;
					if (!Array.isArray(values)) continue;
					const category = values.flatMap((value): readonly string[] => {
						if (!isObjectRecord(value) || typeof value.stringValue !== 'string') return [];
						return [value.stringValue];
					});
					if (category.length === values.length) categories.push(category);
				}
			}
		}
	}
	return categories;
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

describe('structured logging process roots', () => {
	it('keeps four built process children on JSONL stderr and protected stdout', async () => {
		const receiver = await createOtlpReceiver();
		const mcpConfigDir = await createMcpPortalProofConfigDir();
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
					name: 'agent-vm',
					packageRoot: packageDistPath('packages', 'agent-vm'),
					rootKind: 'agent-vm',
					rootModulePath: packageDistPath(
						'packages',
						'agent-vm',
						'dist',
						'cli',
						'commands',
						'controller-definition.js',
					),
				},
				{
					category: ['agent-vm', 'worker', 'server'],
					configuration: '{ stderr: process.stderr }',
					environment: {
						MCP_PORTAL_MASTER_KEY:
							'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
						OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collectorUrl,
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

			await Promise.all(
				children.map(async (child): Promise<void> => {
					const result = await runProductionRootChild(child);
					assertStructuredStderr(result, child.category.join('.'));
				}),
			);
			expect(receiver.requests.length).toBeGreaterThanOrEqual(children.length);
			const observedCategories = receiver.requests.flatMap(readOtlpCategories);
			for (const child of children) {
				expect(observedCategories).toContainEqual(child.category);
			}
		} finally {
			await receiver.close();
			await rm(mcpConfigDir, { force: true, recursive: true });
		}
	});

	it('keeps product success when the OTLP receiver is unavailable', async () => {
		const receiver = await createOtlpReceiver();
		const unavailableEndpoint = receiver.endpoint;
		await receiver.close();
		const result = await runProductionRootChild({
			category: ['agent-vm', 'worker', 'server'],
			configuration: '{ stderr: process.stderr }',
			environment: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: unavailableEndpoint },
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
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(childCompletionMarker);
		expect(result.stderr).not.toContain('Failed to initialize OpenTelemetry logger');
	});

	it('keeps structured stderr when no OTLP endpoint is configured', async () => {
		const result = await runProductionRootChild({
			category: ['agent-vm', 'worker', 'server'],
			configuration: '{ stderr: process.stderr }',
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
		});
		assertStructuredStderr(result, 'agent-vm.worker.server');
	});
});
