import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeCanonicalJson } from '../../../agent-portal-sdk/src/portable-contracts/index.js';

const repoRoot = process.cwd();
const sdkDirectory = path.join(repoRoot, 'packages', 'agent-portal-sdk');
const testAuthorization = 'test-only-opaque-tool-portal-authorization';
const testApprovalToken = 'test-only-opaque-tool-portal-approval';

const successfulListResult = {
	items: [
		{
			id: 'list-1',
			status: 'ok',
			value: { namespaces: ['fixture'], tools: [] },
		},
	],
	ok: true,
} as const;
const successfulEmptyToolsResult = {
	items: [{ id: 'empty-tools-1', status: 'ok', value: { tools: [] } }],
	ok: true,
} as const;
const successfulCallItem = {
	id: 'call-1',
	operationId: 'operation-1',
	outcome: {
		certainty: 'proven',
		completion: 'succeeded',
		kind: 'completed',
		retryClass: 'forbidden',
	},
	owningGeneration: 'tool-vm-generation-1',
	status: 'ok',
	value: { called: true },
} as const;
const mixedCallResult = {
	items: [
		successfulCallItem,
		{
			error: { code: 'capability_denied', message: 'Capability denied by policy.' },
			id: 'call-2',
			operationId: 'operation-2',
			outcome: {
				certainty: 'proven',
				kind: 'not-dispatched',
				retryClass: 'safe-before-dispatch',
			},
			owningGeneration: 'tool-vm-generation-1',
			status: 'error',
		},
	],
	ok: false,
} as const;
const operationFixtures = [
	{
		exitCode: 0,
		operation: 'list',
		request: { requests: [{ id: 'list-1' }] },
		result: successfulListResult,
		toolName: 'tool_portal_list',
	},
	{
		exitCode: 0,
		operation: 'search',
		request: { requests: [{ id: 'search-1', query: 'fixture' }] },
		result: successfulEmptyToolsResult,
		toolName: 'tool_portal_search',
	},
	{
		exitCode: 0,
		operation: 'describe',
		request: { requests: [{ id: 'describe-1', refs: ['fixture:tool'] }] },
		result: successfulEmptyToolsResult,
		toolName: 'tool_portal_describe',
	},
	{
		exitCode: 1,
		operation: 'call',
		request: {
			calls: [
				{ arguments: { title: 'fixture' }, id: 'call-1', name: 'tool', namespace: 'fixture' },
			],
		},
		result: mixedCallResult,
		toolName: 'tool_portal_call',
	},
] as const;

interface StartedHttpMcpServer {
	readonly close: () => Promise<void>;
	readonly endpoint: string;
	readonly requests: readonly {
		readonly authorization: string | undefined;
		readonly params: unknown;
	}[];
}

interface PackedCliFixture {
	readonly binPath: string | undefined;
	readonly packageManifest: Readonly<Record<string, unknown>>;
	readonly rootDirectory: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function writeJsonResponse(response: ServerResponse, statusCode: number, body?: unknown): void {
	response.writeHead(
		statusCode,
		body === undefined ? undefined : { 'content-type': 'application/json' },
	);
	response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function startHttpMcpServer(
	resultsByToolName: ReadonlyMap<string, unknown>,
): Promise<StartedHttpMcpServer> {
	const requests: Array<StartedHttpMcpServer['requests'][number]> = [];
	const server = createServer((request, response) => {
		void (async () => {
			if (request.method !== 'POST') {
				writeJsonResponse(response, request.method === 'DELETE' ? 204 : 405);
				return;
			}
			const message = await readRequestJson(request);
			if (!isObjectRecord(message) || typeof message['method'] !== 'string') {
				writeJsonResponse(response, 400);
				return;
			}
			if (message['method'] === 'initialize') {
				const params = isObjectRecord(message['params']) ? message['params'] : {};
				writeJsonResponse(response, 200, {
					id: message['id'],
					jsonrpc: '2.0',
					result: {
						capabilities: {
							resources: { listChanged: false, subscribe: false },
							tools: { listChanged: false },
						},
						protocolVersion: params['protocolVersion'],
						serverInfo: { name: 'tool-portal-cli-host-fixture', version: '1.0.0' },
					},
				});
				return;
			}
			if (message['method'] === 'tools/call') {
				const params = isObjectRecord(message['params']) ? message['params'] : {};
				const toolName = typeof params['name'] === 'string' ? params['name'] : '';
				requests.push({ authorization: request.headers.authorization, params });
				const structuredContent = resultsByToolName.get(toolName);
				writeJsonResponse(response, 200, {
					id: message['id'],
					jsonrpc: '2.0',
					result: {
						content: [{ text: 'untrusted MCP text must not enter CLI stdout', type: 'text' }],
						structuredContent,
					},
				});
				return;
			}
			writeJsonResponse(response, 202);
		})().catch((error: unknown) => writeJsonResponse(response, 500, { error: String(error) }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!isObjectRecord(address) || typeof address.port !== 'number') {
		throw new Error('Could not resolve fake Tool Portal MCP port.');
	}
	return {
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
			});
		},
		endpoint: `http://127.0.0.1:${String(address.port)}/agent-vm/tool-portal/mcp`,
		requests,
	};
}

async function preparePackedCliFixture(): Promise<PackedCliFixture> {
	const rootDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-tool-portal-cli-'));
	const packDirectory = path.join(rootDirectory, 'pack');
	const consumerDirectory = path.join(rootDirectory, 'consumer');
	await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);
	await writeFile(
		path.join(consumerDirectory, 'package.json'),
		JSON.stringify({ name: 'tool-portal-cli-host-fixture', private: true, type: 'module' }),
		'utf8',
	);
	await execa(
		'pnpm',
		[
			'--dir',
			sdkDirectory,
			'pack',
			'--pack-destination',
			packDirectory,
			'--config.ignore-scripts=true',
		],
		{ cwd: repoRoot, timeout: 60_000 },
	);
	const tarballNames = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'));
	if (tarballNames.length !== 1) {
		throw new Error(
			`Expected one packed Agent Portal SDK tarball; found ${String(tarballNames.length)}.`,
		);
	}
	await execa(
		'pnpm',
		[
			'--dir',
			consumerDirectory,
			'add',
			'--prefer-offline',
			'--config.ignore-scripts=true',
			path.join(packDirectory, tarballNames[0] ?? ''),
		],
		{ cwd: repoRoot, timeout: 60_000 },
	);
	const packageDirectory = path.join(
		consumerDirectory,
		'node_modules',
		'@agent-vm',
		'agent-portal-sdk',
	);
	const packageManifest = JSON.parse(
		await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
	) as unknown;
	if (!isObjectRecord(packageManifest)) {
		throw new Error('Packed Agent Portal SDK manifest must be an object.');
	}
	const manifestBin = packageManifest['bin'];
	const binRelativePath = isObjectRecord(manifestBin) ? manifestBin['tool-portal'] : manifestBin;
	return {
		binPath:
			typeof binRelativePath === 'string'
				? path.join(packageDirectory, binRelativePath)
				: undefined,
		packageManifest,
		rootDirectory,
	};
}

function requireCliPath(fixture: PackedCliFixture): string {
	expect(fixture.packageManifest['bin']).toEqual({ 'tool-portal': 'dist/cli/tool-portal.js' });
	if (fixture.binPath === undefined) {
		throw new Error('Packed Agent Portal SDK does not expose the tool-portal executable.');
	}
	return fixture.binPath;
}

function explicitHttpArgs(props: {
	readonly endpoint: string;
	readonly operation?: (typeof operationFixtures)[number]['operation'];
	readonly request?: Readonly<Record<string, unknown>>;
}): readonly string[] {
	return [
		props.operation ?? 'list',
		'--input-json',
		encodeCanonicalJson(props.request ?? operationFixtures[0]?.request),
		'--transport',
		'http',
		'--endpoint',
		props.endpoint,
		'--authorization-env',
		'TOOL_PORTAL_TEST_AUTHORIZATION',
	];
}

function cliEnvironment(homeDirectory: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		HOME: homeDirectory,
		PATH: path.dirname(process.execPath),
		TOOL_PORTAL_TEST_AUTHORIZATION: testAuthorization,
		...extra,
	};
}

function scopedStdioArgs(configPath: string): readonly string[] {
	return [
		'list',
		'--input-json',
		encodeCanonicalJson(operationFixtures[0]?.request),
		'--transport',
		'scoped-stdio',
		'--stdio-config',
		configPath,
	];
}

async function runCli(props: {
	readonly args: readonly string[];
	readonly cliPath: string;
	readonly env: NodeJS.ProcessEnv;
}): Promise<{
	readonly exitCode: number | undefined;
	readonly stderr: string;
	readonly stdout: string;
}> {
	const result = await execa(props.cliPath, props.args, {
		env: props.env,
		extendEnv: false,
		reject: false,
		stripFinalNewline: false,
		timeout: 15_000,
	});
	return {
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

async function writeExecutableTrap(
	directory: string,
	commandName: string,
	recordPath: string,
): Promise<void> {
	const executablePath = path.join(directory, commandName);
	await writeFile(
		executablePath,
		`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(commandName)} >> ${JSON.stringify(recordPath)}\nexit 97\n`,
		'utf8',
	);
	await chmod(executablePath, 0o755);
}

async function readNextTcpMarker(server: net.Server): Promise<string> {
	const [socket] = (await once(server, 'connection')) as [net.Socket];
	socket.setEncoding('utf8');
	let marker = '';
	for await (const chunk of socket) marker += chunk;
	return marker.trimEnd();
}

function renderStdioAdapterScript(): string {
	return `import { appendFile } from 'node:fs/promises';
import net from 'node:net';
import readline from 'node:readline';
const [markerTarget, mode, literalArgument] = process.argv.slice(2);
const result = ${JSON.stringify(successfulListResult)};
function respond(id, value) { process.stdout.write(JSON.stringify({ id, jsonrpc: '2.0', result: value }) + '\\n'); }
async function record(message) {
  if (mode === 'success') return await appendFile(markerTarget, message + '\\n');
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(markerTarget) });
    socket.once('error', reject);
    socket.once('connect', () => socket.end(message + '\\n', resolve));
  });
}
const input = readline.createInterface({ input: process.stdin });
let pendingCallId;
input.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    respond(message.id, { capabilities: { tools: {} }, protocolVersion: message.params.protocolVersion, serverInfo: { name: 'scoped-stdio-fixture', version: '1.0.0' } });
  } else if (message.method === 'tools/call') {
	pendingCallId = message.id;
	await record('call:' + literalArgument);
    if (mode === 'success') respond(message.id, { content: [], structuredContent: result });
  } else if (message.method === 'notifications/cancelled') {
	await record('cancel');
	if (mode === 'cancel-with-result' && pendingCallId !== undefined) {
		respond(pendingCallId, { content: [], structuredContent: result });
	}
  }
});
`;
}

async function writeStdioConfig(props: {
	readonly directory: string;
	readonly literalArgument: string;
	readonly markerTarget: string;
	readonly mode: 'cancel' | 'cancel-with-result' | 'success';
}): Promise<string> {
	const adapterPath = path.join(props.directory, `stdio-adapter-${props.mode}.mjs`);
	const configPath = path.join(props.directory, `stdio-config-${props.mode}.json`);
	await writeFile(adapterPath, renderStdioAdapterScript(), 'utf8');
	await writeFile(
		configPath,
		JSON.stringify({
			argv: [adapterPath, props.markerTarget, props.mode, props.literalArgument],
			executable: process.execPath,
			schemaVersion: 1,
		}),
		'utf8',
	);
	return configPath;
}

describe('packed Tool Portal CLI', () => {
	let fixture: PackedCliFixture;

	beforeAll(async () => {
		fixture = await preparePackedCliFixture();
	}, 120_000);

	afterAll(async () => {
		if (fixture?.rootDirectory !== undefined) {
			await rm(fixture.rootDirectory, { force: true, recursive: true });
		}
	});

	it.each(operationFixtures)(
		'maps $operation through explicit authenticated HTTP and emits only canonical JSON',
		async (operationFixture) => {
			const cliPath = requireCliPath(fixture);
			const server = await startHttpMcpServer(
				new Map([[operationFixture.toolName, operationFixture.result]]),
			);
			try {
				const result = await runCli({
					args: explicitHttpArgs({
						endpoint: server.endpoint,
						operation: operationFixture.operation,
						request: operationFixture.request,
					}),
					cliPath,
					env: cliEnvironment(fixture.rootDirectory),
				});

				expect(result.exitCode).toBe(operationFixture.exitCode);
				expect(result.stdout).toBe(`${encodeCanonicalJson(operationFixture.result)}\n`);
				expect(result.stdout).not.toContain('untrusted MCP text');
				if (operationFixture.exitCode === 0) expect(result.stderr).toBe('');
				else expect(result.stderr).not.toContain(encodeCanonicalJson(operationFixture.result));
				expect(server.requests).toEqual([
					expect.objectContaining({
						authorization: `Bearer ${testAuthorization}`,
						params: expect.objectContaining({ name: operationFixture.toolName }),
					}),
				]);
			} finally {
				await server.close();
			}
		},
	);

	it('uses exit class 2 for usage, auth, transport, and protocol failures', async () => {
		const cliPath = requireCliPath(fixture);
		const server = await startHttpMcpServer(new Map([['tool_portal_list', { invalid: true }]]));
		const missingAuthEnvironment = cliEnvironment(fixture.rootDirectory);
		delete missingAuthEnvironment['TOOL_PORTAL_TEST_AUTHORIZATION'];
		const cases = [
			['usage', [...explicitHttpArgs({ endpoint: server.endpoint }), '--unknown-option']],
			['auth', explicitHttpArgs({ endpoint: server.endpoint })],
			['transport', explicitHttpArgs({ endpoint: 'http://127.0.0.1:1/unreachable' })],
			['protocol', explicitHttpArgs({ endpoint: server.endpoint })],
		] as const;

		await Promise.all(
			cases.map(async ([failureClass, args]) => {
				const result = await runCli({
					args,
					cliPath,
					env:
						failureClass === 'auth'
							? missingAuthEnvironment
							: cliEnvironment(fixture.rootDirectory),
				});
				expect(result.exitCode, failureClass).toBe(2);
				expect(result.stdout, failureClass).toBe('');
				expect(result.stderr, failureClass).not.toContain(testAuthorization);
			}),
		);
		await server.close();
	});

	it('forwards one approval proof only from an explicit environment variable', async () => {
		const cliPath = requireCliPath(fixture);
		const server = await startHttpMcpServer(new Map([['tool_portal_call', mixedCallResult]]));
		const args = [
			...explicitHttpArgs({
				endpoint: server.endpoint,
				operation: 'call',
				request: operationFixtures[3].request,
			}),
			'--approval-token-env',
			'TOOL_PORTAL_TEST_APPROVAL',
		];
		try {
			const result = await runCli({
				args,
				cliPath,
				env: cliEnvironment(fixture.rootDirectory, {
					TOOL_PORTAL_TEST_APPROVAL: testApprovalToken,
				}),
			});

			expect(result.exitCode).toBe(1);
			expect(args).not.toContain(testApprovalToken);
			expect(result.stdout).not.toContain(testApprovalToken);
			expect(result.stderr).not.toContain(testApprovalToken);
			expect(server.requests[0]?.params).toMatchObject({
				_meta: { 'agent-vm/tool-portal-approval-token': testApprovalToken },
				name: 'tool_portal_call',
			});
		} finally {
			await server.close();
		}
	});

	it('does not discover endpoint or credentials implicitly and rejects unsafe argv', async () => {
		const cliPath = requireCliPath(fixture);
		const homeDirectory = path.join(fixture.rootDirectory, 'implicit-home');
		const trapDirectory = path.join(fixture.rootDirectory, 'trap-bin');
		const trapRecordPath = path.join(fixture.rootDirectory, 'trap-invocations.txt');
		await Promise.all([
			mkdir(path.join(homeDirectory, '.config', 'agent-vm'), { recursive: true }),
			mkdir(trapDirectory),
		]);
		await writeFile(
			path.join(homeDirectory, '.config', 'agent-vm', 'tool-portal.json'),
			JSON.stringify({ endpoint: 'http://127.0.0.1:1/implicit', token: 'implicit-token' }),
			'utf8',
		);
		await Promise.all(
			['op', 'security', 'ssh', 'tool_portal_call'].map(
				async (commandName) =>
					await writeExecutableTrap(trapDirectory, commandName, trapRecordPath),
			),
		);
		const implicitEnvironment = cliEnvironment(homeDirectory, {
			AGENT_VM_TOOL_PORTAL_ENDPOINT: 'http://127.0.0.1:1/implicit',
			AUTHORIZATION: 'implicit-token',
			PATH: `${path.dirname(process.execPath)}:${trapDirectory}`,
			TOOL_PORTAL_ENDPOINT: 'http://127.0.0.1:1/implicit',
			TOOL_PORTAL_TOKEN: 'implicit-token',
		});
		delete implicitEnvironment['TOOL_PORTAL_TEST_AUTHORIZATION'];
		const invalidArgv = [
			['list', '--input-json', '{"requests":[{"id":"list-1"}]}', '--transport', 'http'],
			[
				...explicitHttpArgs({ endpoint: 'http://127.0.0.1:1/mcp' }),
				'--authorization',
				'direct-token',
			],
			[...explicitHttpArgs({ endpoint: 'http://127.0.0.1:1/mcp' }), '@response-file'],
			[...explicitHttpArgs({ endpoint: 'http://127.0.0.1:1/mcp' }), '--shell', '/bin/sh'],
			[...explicitHttpArgs({ endpoint: 'http://127.0.0.1:1/mcp' }), 'extra-positional'],
		];
		await Promise.all(
			invalidArgv.map(async (args) => {
				const result = await runCli({ args, cliPath, env: implicitEnvironment });
				expect(result.exitCode).toBe(2);
				expect(result.stdout).toBe('');
				expect(result.stderr).not.toContain('implicit-token');
			}),
		);
		await expect(access(trapRecordPath)).rejects.toThrow(/ENOENT/u);
	});

	it('runs only the exact argv from an explicit protected scoped-stdio config', async () => {
		const cliPath = requireCliPath(fixture);
		const markerPath = path.join(fixture.rootDirectory, 'stdio-success-markers.txt');
		const shellSentinelPath = path.join(fixture.rootDirectory, 'must-not-exist');
		const literalArgument = `literal;$(touch ${shellSentinelPath})`;
		const configPath = await writeStdioConfig({
			directory: fixture.rootDirectory,
			literalArgument,
			markerTarget: markerPath,
			mode: 'success',
		});
		const result = await runCli({
			args: scopedStdioArgs(configPath),
			cliPath,
			env: cliEnvironment(fixture.rootDirectory),
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${encodeCanonicalJson(successfulListResult)}\n`);
		expect(await readFile(markerPath, 'utf8')).toContain(`call:${literalArgument}`);
		await expect(access(shellSentinelPath)).rejects.toThrow(/ENOENT/u);
	});

	it('maps SIGINT to MCP cancellation before reporting a pre-result exit', async () => {
		const cliPath = requireCliPath(fixture);
		const markerServer = net.createServer();
		markerServer.listen(0, '127.0.0.1');
		await once(markerServer, 'listening');
		const markerAddress = markerServer.address();
		if (!isObjectRecord(markerAddress) || typeof markerAddress.port !== 'number') {
			throw new Error('Could not resolve scoped-stdio marker server port.');
		}
		const configPath = await writeStdioConfig({
			directory: fixture.rootDirectory,
			literalArgument: 'interrupt-case',
			markerTarget: String(markerAddress.port),
			mode: 'cancel',
		});
		let child: ChildProcess | undefined;
		try {
			child = spawn(cliPath, scopedStdioArgs(configPath), {
				env: cliEnvironment(fixture.rootDirectory),
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			expect(await readNextTcpMarker(markerServer)).toBe('call:interrupt-case');
			const cancellationMarker = readNextTcpMarker(markerServer);
			child.kill('SIGINT');
			expect(await cancellationMarker).toBe('cancel');
			expect(child.exitCode).toBeNull();
			await once(child, 'exit');
			expect(child.exitCode).toBe(2);
		} finally {
			if (child !== undefined && child.exitCode === null) {
				child.kill('SIGKILL');
				await once(child, 'exit');
			}
			markerServer.close();
			await once(markerServer, 'close');
		}
	});

	it('prints a canonical result returned after SIGINT instead of forcing exit class 2', async () => {
		const cliPath = requireCliPath(fixture);
		const markerServer = net.createServer();
		markerServer.listen(0, '127.0.0.1');
		await once(markerServer, 'listening');
		const markerAddress = markerServer.address();
		if (!isObjectRecord(markerAddress) || typeof markerAddress.port !== 'number') {
			throw new Error('Could not resolve scoped-stdio marker server port.');
		}
		const configPath = await writeStdioConfig({
			directory: fixture.rootDirectory,
			literalArgument: 'interrupt-result-case',
			markerTarget: String(markerAddress.port),
			mode: 'cancel-with-result',
		});
		let child: ChildProcess | undefined;
		try {
			child = spawn(cliPath, scopedStdioArgs(configPath), {
				env: cliEnvironment(fixture.rootDirectory),
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const stdoutChunks: Buffer[] = [];
			child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
			expect(await readNextTcpMarker(markerServer)).toBe('call:interrupt-result-case');
			const cancellationMarker = readNextTcpMarker(markerServer);
			child.kill('SIGINT');
			expect(await cancellationMarker).toBe('cancel');
			await once(child, 'exit');

			expect(child.exitCode).toBe(0);
			expect(Buffer.concat(stdoutChunks).toString('utf8')).toBe(
				`${encodeCanonicalJson(successfulListResult)}\n`,
			);
		} finally {
			if (child !== undefined && child.exitCode === null) {
				child.kill('SIGKILL');
				await once(child, 'exit');
			}
			markerServer.close();
			await once(markerServer, 'close');
		}
	});
});
