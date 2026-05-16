import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { portalHmacKeyEnvName } from '../auth/hmac-env.js';
import { hashCallArguments, signApprovalToken } from '../auth/hmac-token.js';
import {
	startFakeUpstreamMcpServer,
	type StartedFakeUpstreamMcpServer,
} from '../testing/fake-upstream-mcp-server.js';

const agentId = 'shravan';
const namespace = 'upstream-mock';
const portalAccessHeaderName = 'x-agent-vm-mcp-portal-secret';
const portalAccessSecret = 'portal-server-secret';
const hmacKey = Buffer.from('a'.repeat(64), 'hex');

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
						approval: {
							allowWithoutApprovalTools: [{ namespace, toolName: 'read_thing' }],
							alwaysAskTools: [{ namespace, toolName: 'write_thing' }],
							annotationPolicy: 'destructive-requires-approval',
							trustedAnnotationNamespaces: [],
							writeTools: [],
						},
						enabledNamespaces: [namespace],
						enabledToolsByNamespace: {
							[namespace]: ['read_thing', 'write_thing'],
						},
						hiddenToolsByNamespace: {},
					},
				},
				schemaVersion: 1,
				server: {
					accessHeader: {
						name: portalAccessHeaderName,
						secret: { name: 'MCP_PORTAL_SERVER_SECRET', source: 'environment' },
					},
					host: '127.0.0.1',
					port: props.portalPort,
				},
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
	await waitForPortalHealthAttempt({
		...props,
		startedAt: Date.now(),
	});
}

async function waitForPortalHealthAttempt(props: {
	readonly child: PortalChildProcess;
	readonly output: ChildOutput;
	readonly port: number;
	readonly startedAt: number;
}): Promise<void> {
	if (props.child.exitCode !== null) {
		throw new Error(`Portal process exited early: ${props.output.stderr}`);
	}
	if (Date.now() - props.startedAt >= 10_000) {
		throw new Error(
			`Timed out waiting for portal health. stdout=${props.output.stdout} stderr=${props.output.stderr}`,
		);
	}
	try {
		const response = await fetch(`http://127.0.0.1:${String(props.port)}/health`);
		if (response.ok) {
			return;
		}
	} catch {
		// The subprocess may still be starting; keep polling until the bounded timeout.
	}
	await delay(50);
	return waitForPortalHealthAttempt(props);
}

async function startPortalProcess(props: {
	readonly configDir: string;
	readonly port: number;
}): Promise<StartedPortalProcess> {
	const binPath = join(process.cwd(), 'packages/mcp-portal/dist/bin/portal-server.js');
	await access(binPath);
	const output: ChildOutput = { stderr: '', stdout: '' };
	const child = spawn(process.execPath, [binPath, '--config-dir', props.configDir], {
		env: {
			...process.env,
			MCP_PORTAL_SERVER_SECRET: portalAccessSecret,
			[portalHmacKeyEnvName(agentId)]: hmacKey.toString('hex'),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
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
	await Promise.race([
		new Promise<void>((resolve) => {
			startedPortal.child.once('exit', () => resolve());
		}),
		delay(5_000).then(() => {
			if (startedPortal.child.exitCode === null) {
				startedPortal.child.kill('SIGKILL');
			}
		}),
	]);
}

function asClientTransport(transport: StreamableHTTPClientTransport): Transport {
	return transport as unknown as Transport;
}

async function createPortalClient(port: number): Promise<PortalClientHandle> {
	const transport = new StreamableHTTPClientTransport(
		new URL(`http://127.0.0.1:${String(port)}/agents/${agentId}/mcp`),
		{ requestInit: { headers: { [portalAccessHeaderName]: portalAccessSecret } } },
	);
	const client = new Client({ name: 'portal-subprocess-integration', version: '1.0.0' });
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
	const parsed: unknown = JSON.parse(firstTextContent(value));
	return parsed;
}

describe('portal server subprocess integration', () => {
	let configDir: string | null = null;
	let portalPort: number | null = null;
	let startedPortal: StartedPortalProcess | null = null;
	let upstreamServer: StartedUpstreamServer | null = null;

	beforeAll(async () => {
		configDir = await mkdtemp(join(tmpdir(), 'agent-vm-mcp-portal-subprocess-'));
		upstreamServer = await startFakeUpstreamMcpServer();
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

	it('serves portal tools and proxies approval-gated upstream calls', async () => {
		if (portalPort === null || upstreamServer === null) {
			throw new Error('Expected portal integration fixture to be initialized.');
		}
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
			});

			const readArguments = { title: 'Read safe thing' };
			const readResult = parsePortalJsonResult(
				await portalClient.client.callTool({
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
				}),
			);
			expect(readResult).toMatchObject({
				ok: true,
				results: {
					read: {
						ok: true,
						output: {
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
				},
			});
			expect(upstreamServer.calls).toContainEqual({
				argumentsValue: readArguments,
				name: 'read_thing',
			});

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
				ok: false,
				results: {
					'write-unsigned': {
						error: { kind: 'approval_token_missing', namespace, toolName: 'write_thing' },
						ok: false,
					},
				},
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
				ok: true,
				results: {
					'write-signed': {
						ok: true,
						output: {
							namespace,
							toolName: 'write_thing',
						},
					},
				},
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
