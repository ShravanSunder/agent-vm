import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveAgentBearerToken } from '../portal-auth/agent-bearer-token.js';
import { hashCallArguments, signApprovalToken } from '../portal-auth/hmac-token.js';
import {
	startFakeUpstreamMcpServer,
	type StartedFakeUpstreamMcpServer,
} from '../testing/fake-upstream-mcp-server.js';

const agentId = 'shravan';
const namespace = 'upstream-mock';
const masterKey = Buffer.from('0123456789abcdef0123456789abcdef');
const masterKeyText = masterKey.toString('base64url');
const hmacKey = createHmac('sha256', masterKey)
	.update(`mcp-portal:approval-agent:${agentId}`)
	.digest();

type StartedUpstreamServer = StartedFakeUpstreamMcpServer;

interface ChildOutput {
	stderr: string;
	stdout: string;
}

type PortalChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface StartedPortalProcess {
	readonly child: PortalChildProcess;
	readonly output: ChildOutput;
}

interface PortalClientHandle {
	readonly client: Client;
	readonly close: () => Promise<void>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withTimeout<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
	message: string,
): Promise<TValue> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	});
}

function waitForOutputCondition(options: {
	readonly child: PortalChildProcess;
	readonly describeCondition: string;
	readonly isReady: () => boolean;
	readonly output: ChildOutput;
	readonly timeoutMs: number;
}): Promise<void> {
	if (options.isReady()) {
		return Promise.resolve();
	}
	if (options.child.exitCode !== null) {
		return Promise.reject(
			new Error(
				`${options.describeCondition} failed because the process exited:\n${options.output.stderr}`,
			),
		);
	}
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`${options.describeCondition} did not complete within ${String(
						options.timeoutMs,
					)}ms.\nstdout:\n${options.output.stdout}\nstderr:\n${options.output.stderr}`,
				),
			);
		}, options.timeoutMs);
		const cleanup = (): void => {
			clearTimeout(timeout);
			options.child.stdout.off('data', onData);
			options.child.off('exit', onExit);
		};
		const onData = (): void => {
			if (options.isReady()) {
				cleanup();
				resolve();
			}
		};
		const onExit = (): void => {
			cleanup();
			reject(
				new Error(
					`${options.describeCondition} failed because the process exited:\n${options.output.stderr}`,
				),
			);
		};
		options.child.stdout.on('data', onData);
		options.child.once('exit', onExit);
		onData();
	});
}

async function waitForPortalExit(
	child: PortalChildProcess,
	timeoutMs: number,
	describeExit: string,
): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await withTimeout(
		once(child, 'exit').then(() => undefined),
		timeoutMs,
		`${describeExit} did not exit within ${String(timeoutMs)}ms.`,
	);
}

async function findOpenPort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!isObjectRecord(address) || typeof address.port !== 'number') {
				server.close(() => reject(new Error('Could not resolve an open TCP port.')));
				return;
			}
			const port = address.port;
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			});
		});
	});
}

async function writeConfigFiles(props: {
	readonly configDir: string;
	readonly portalPort: number;
	readonly upstreamUrl: string;
}): Promise<void> {
	await writeFile(
		join(props.configDir, 'mcp.config.jsonc'),
		`${JSON.stringify(
			{
				providers: {
					upstreamMock: {
						discovery: { summary: 'Mock upstream MCP server' },
						kind: 'mcp',
						namespace,
						transport: {
							kind: 'streamable-http',
							url: props.upstreamUrl,
						},
					},
				},
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	await writeFile(
		join(props.configDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(
			{
				agents: {
					[agentId]: { profile: 'builder' },
				},
				profiles: {
					builder: {
						namespaces: {
							[namespace]: {
								calls: {
									requiresApproval: { allow: ['write_thing'] },
									withoutApproval: { allow: ['read_thing'] },
								},
								tools: { allow: ['read_thing', 'write_thing'] },
							},
						},
					},
				},
				externalAuth: {
					masterKey: { name: 'MCP_PORTAL_MASTER_KEY', source: 'environment' },
				},
				mcpProxy: {
					auth: { headerName: 'authorization' },
					server: {
						host: '127.0.0.1',
						port: props.portalPort,
					},
				},
				schemaVersion: 1,
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
}

async function waitForPortalHealth(props: {
	readonly child: PortalChildProcess;
	readonly output: ChildOutput;
	readonly port: number;
}): Promise<void> {
	await waitForOutputCondition({
		child: props.child,
		describeCondition: 'Portal readiness',
		isReady: () => props.output.stdout.includes(`listening port=${String(props.port)}`),
		output: props.output,
		timeoutMs: 30_000,
	});
	const response = await fetch(`http://127.0.0.1:${String(props.port)}/health`);
	if (!response.ok) {
		throw new Error(
			`Portal process reported listening but health returned HTTP ${String(response.status)}.`,
		);
	}
}

async function startPortalProcess(props: {
	readonly configDir: string;
	readonly port: number;
}): Promise<StartedPortalProcess> {
	const binPath = join(process.cwd(), 'node_modules/.bin/tsx');
	const sourcePath = join(process.cwd(), 'packages/mcp-portal/src/bin/mcp-portal.ts');
	await access(binPath);
	await access(sourcePath);
	const output: ChildOutput = { stderr: '', stdout: '' };
	const child = spawn(
		binPath,
		[sourcePath, 'mcp-proxy', 'serve', '--config-dir', props.configDir],
		{
			env: {
				...process.env,
				MCP_PORTAL_MASTER_KEY: masterKeyText,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		output.stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		output.stderr += chunk;
	});
	await waitForPortalHealth({ child, output, port: props.port });
	return { child, output };
}

async function stopPortalProcess(startedPortal: StartedPortalProcess | null): Promise<void> {
	if (startedPortal === null || startedPortal.child.exitCode !== null) {
		return;
	}
	startedPortal.child.kill('SIGTERM');
	try {
		await waitForPortalExit(startedPortal.child, 5_000, 'Portal SIGTERM shutdown');
	} catch (error) {
		if (startedPortal.child.exitCode === null) {
			startedPortal.child.kill('SIGKILL');
			await waitForPortalExit(startedPortal.child, 5_000, 'Portal SIGKILL shutdown');
		}
		throw error;
	}
}

function asClientTransport(transport: StreamableHTTPClientTransport): Transport {
	return transport as unknown as Transport;
}

async function createPortalClient(port: number): Promise<PortalClientHandle> {
	const transport = new StreamableHTTPClientTransport(
		new URL(`http://127.0.0.1:${String(port)}/agents/${agentId}/mcp`),
		{
			requestInit: {
				headers: {
					authorization: `Bearer ${deriveAgentBearerToken({ agentId, credentialVersion: 1, masterKey })}`,
				},
			},
		},
	);
	const client = new Client({ name: 'portal-proxy-integration', version: '1.0.0' });
	await client.connect(asClientTransport(transport));
	return {
		client,
		close: async () => {
			await client.close();
		},
	};
}

function firstTextContent(value: unknown): string {
	if (!isObjectRecord(value) || !Array.isArray(value.content)) {
		throw new Error('Expected MCP call result content.');
	}
	const firstContent = value.content[0];
	if (!isObjectRecord(firstContent) || firstContent.type !== 'text') {
		throw new Error('Expected first MCP call result content item to be text.');
	}
	const text = firstContent.text;
	if (typeof text !== 'string') {
		throw new Error('Expected MCP text content to be a string.');
	}
	return text;
}

function parsePortalJsonResult(value: unknown): unknown {
	const text = firstTextContent(value);
	if (!text.startsWith('{')) {
		throw new Error(`Expected JSON MCP Portal result, received: ${text}`);
	}
	const parsed: unknown = JSON.parse(text);
	return parsed;
}

describe('portal proxy CLI integration', () => {
	let configDir: string | null = null;
	let portalPort: number | null = null;
	let startedPortal: StartedPortalProcess | null = null;
	let upstreamServer: StartedUpstreamServer | null = null;

	beforeAll(async () => {
		configDir = await mkdtemp(join(tmpdir(), 'mcp-portal-proxy-'));
		upstreamServer = await startFakeUpstreamMcpServer({ emitProgress: true });
		portalPort = await findOpenPort();
		await writeConfigFiles({
			configDir,
			portalPort,
			upstreamUrl: upstreamServer.url,
		});
		startedPortal = await startPortalProcess({ configDir, port: portalPort });
	}, 30_000);

	afterAll(async () => {
		await stopPortalProcess(startedPortal);
		if (upstreamServer !== null) {
			await upstreamServer.close();
		}
		if (configDir !== null) {
			await rm(configDir, { force: true, recursive: true });
		}
	});

	async function expectWrongBearerRejected(port: number): Promise<void> {
		const response = await fetch(`http://127.0.0.1:${String(port)}/agents/${agentId}/mcp`, {
			body: '{}',
			headers: {
				authorization: 'Bearer not-the-agent-token',
				'content-type': 'application/json',
			},
			method: 'POST',
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: { kind: 'unauthorized' },
			ok: false,
		});
	}

	it('serves portal tools and proxies approval-gated upstream calls', async () => {
		if (portalPort === null || upstreamServer === null) {
			throw new Error('Expected portal integration fixture to be initialized.');
		}
		await expectWrongBearerRejected(portalPort);
		const portalClient = await createPortalClient(portalPort);
		try {
			const tools = await portalClient.client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toContain('mcp_portal_list');

			const listResult = parsePortalJsonResult(
				await portalClient.client.callTool({
					arguments: { requests: [{ id: 'list', limit: 10 }] },
					name: 'mcp_portal_list',
				}),
			);
			expect(listResult).toMatchObject({
				structuredContent: {
					ok: true,
					results: {
						list: {
							ok: true,
							output: {
								namespaces: [namespace],
								tools: [
									expect.objectContaining({ namespace, toolName: 'read_thing' }),
									expect.objectContaining({ namespace, toolName: 'write_thing' }),
								],
							},
						},
					},
				},
			});

			const readArguments = { title: 'Read safe thing' };
			const progressUpdates: unknown[] = [];
			const readResult = parsePortalJsonResult(
				await portalClient.client.callTool(
					{
						arguments: {
							calls: [
								{
									arguments: readArguments,
									id: 'read',
									namespace,
									toolName: 'read_thing',
								},
							],
						},
						name: 'mcp_portal_call',
					},
					undefined,
					{
						onprogress: (progress) => {
							progressUpdates.push(progress);
						},
					},
				),
			);
			expect(readResult).toMatchObject({
				items: [
					{
						requestId: 'read',
						status: 'success',
						structuredContent: {
							namespace,
							result: {
								content: [
									expect.objectContaining({
										text: expect.stringContaining('read_thing'),
										type: 'text',
									}),
								],
							},
							toolName: 'read_thing',
						},
					},
				],
			});
			expect(upstreamServer.calls).toContainEqual({
				argumentsValue: readArguments,
				name: 'read_thing',
			});
			expect(progressUpdates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						message: 'fake upstream half done',
						progress: 1,
						total: 2,
					}),
				]),
			);

			const writeArguments = { title: 'Write gated thing' };
			const unsignedWriteResult = parsePortalJsonResult(
				await portalClient.client.callTool({
					arguments: {
						calls: [
							{
								arguments: writeArguments,
								id: 'write-unsigned',
								namespace,
								toolName: 'write_thing',
							},
						],
					},
					name: 'mcp_portal_call',
				}),
			);
			expect(unsignedWriteResult).toMatchObject({
				items: [
					{
						error: {
							code: 'approval_token_missing',
							namespace,
							toolName: 'write_thing',
						},
						requestId: 'write-unsigned',
						status: 'failed',
					},
				],
			});
			expect(upstreamServer.calls).not.toContainEqual({
				argumentsValue: writeArguments,
				name: 'write_thing',
			});

			const portalApprovalToken = signApprovalToken({
				agentId,
				calls: [
					{
						argumentsHash: hashCallArguments(writeArguments),
						namespace,
						toolName: 'write_thing',
					},
				],
				expiresAtMs: Date.now() + 30_000,
				key: hmacKey,
			});
			const signedWriteResult = parsePortalJsonResult(
				await portalClient.client.callTool({
					arguments: {
						calls: [
							{
								arguments: writeArguments,
								id: 'write-signed',
								namespace,
								toolName: 'write_thing',
							},
						],
						portalApprovalToken,
					},
					name: 'mcp_portal_call',
				}),
			);
			expect(signedWriteResult).toMatchObject({
				items: [
					{
						requestId: 'write-signed',
						status: 'success',
						structuredContent: {
							namespace,
							toolName: 'write_thing',
						},
					},
				],
			});
			expect(upstreamServer.calls).toContainEqual({
				argumentsValue: writeArguments,
				name: 'write_thing',
			});
		} finally {
			await portalClient.close();
		}
	}, 30_000);
});
