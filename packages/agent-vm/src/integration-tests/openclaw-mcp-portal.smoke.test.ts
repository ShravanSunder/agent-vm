/* oxlint-disable eslint/no-await-in-loop -- smoke test steps must be sequential against live VMs */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
	type StartedFakeUpstreamMcpServer,
} from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import {
	createGatewayApiClient,
	type GatewayApiClient,
} from '../gateway-api-client/gateway-api-client.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	canRunGondolinSmoke,
	currentSmokeArchitecture,
	rebuildWorkspacePackages,
	scaffoldOpenClawSmokeProject,
	startSmokeControllerRuntime,
	type SmokeHarnessRuntime,
	useLocalOpenClawGatewayImagePackages,
	writeOpenClawMcpPortalSmokeConfigs,
} from './smoke-harness.js';

const architecture = currentSmokeArchitecture();
const runOpenClawMcpPortalSmoke =
	process.env.AGENT_VM_OPENCLAW_SMOKE === '1' && (await canRunGondolinSmoke({ architecture }));
const describeOpenClawMcpPortalSmoke = runOpenClawMcpPortalSmoke ? describe : describe.skip;
const agentId = 'smoke';
const portalAccessHeaderName = 'x-agent-vm-mcp-portal-secret';
const portalAccessSecret = 'portal-server-secret';
const gatewayToken = 'mcp-portal-smoke-gateway-token';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstTextContent(value: unknown): string {
	if (!isObjectRecord(value) || !Array.isArray(value.content)) {
		throw new Error('Expected MCP result with content.');
	}
	const firstContent = value.content[0];
	if (!isObjectRecord(firstContent) || firstContent.type !== 'text') {
		throw new Error('Expected first MCP content item to be text.');
	}
	const text = firstContent.text;
	if (typeof text !== 'string') {
		throw new Error('Expected first MCP content item text to be a string.');
	}
	return text;
}

function parsePortalJsonResult(value: unknown): unknown {
	return JSON.parse(firstTextContent(value)) as unknown;
}

function parseGatewayPortalResult(value: unknown): unknown {
	if (!isObjectRecord(value) || !('result' in value)) {
		return parsePortalJsonResult(value);
	}
	return parsePortalJsonResult(value.result);
}

function parseJsonText(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return {};
	}
	if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
		const parsed: unknown = JSON.parse(trimmed);
		return parsed;
	}
	const dataLines = trimmed
		.split(/\r?\n/u)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice('data:'.length).trim());
	if (dataLines.length === 0) {
		throw new Error(`Expected MCP event-stream response to contain data lines: ${trimmed}`);
	}
	const parsed: unknown = JSON.parse(dataLines.join('\n'));
	return parsed;
}

function readJsonRpcResult(value: unknown): unknown {
	if (!isObjectRecord(value)) {
		throw new Error('Expected MCP JSON-RPC response object.');
	}
	if ('error' in value) {
		throw new Error(`MCP JSON-RPC error: ${JSON.stringify(value.error)}`);
	}
	if (!('result' in value)) {
		throw new Error(`Expected MCP JSON-RPC response result: ${JSON.stringify(value)}`);
	}
	return value.result;
}

function readMcpSessionId(response: Response): string {
	const sessionId = response.headers.get('mcp-session-id');
	if (sessionId === null || sessionId.length === 0) {
		throw new Error('Expected MCP initialize response to include mcp-session-id.');
	}
	return sessionId;
}

async function readMcpResponseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	return parseJsonText(text);
}

function createPortalMcpClient(options: {
	readonly accessHeaderName: string;
	readonly accessSecret: string;
	readonly endpoint: string;
}): {
	readonly callTool: (props: {
		readonly args: Record<string, unknown>;
		readonly tool: string;
	}) => Promise<unknown>;
	readonly listTools: () => Promise<readonly string[]>;
} {
	let nextId = 1;
	let sessionId: string | undefined;

	async function postJsonRpc(method: string, params?: unknown): Promise<unknown> {
		const headers: Record<string, string> = {
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json',
			[options.accessHeaderName]: options.accessSecret,
		};
		if (sessionId !== undefined) {
			headers['mcp-session-id'] = sessionId;
		}
		const id = nextId;
		nextId += 1;
		const response = await fetch(options.endpoint, {
			body: JSON.stringify({
				jsonrpc: '2.0',
				id,
				method,
				...(params === undefined ? {} : { params }),
			}),
			headers,
			method: 'POST',
		});
		if (!response.ok) {
			throw new Error(
				`MCP request ${method} failed: ${String(response.status)} ${await response.text()}`,
			);
		}
		if (method === 'initialize') {
			sessionId = readMcpSessionId(response);
		}
		return readJsonRpcResult(await readMcpResponseBody(response));
	}

	async function postNotification(method: string): Promise<void> {
		const headers: Record<string, string> = {
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json',
			[options.accessHeaderName]: options.accessSecret,
		};
		if (sessionId !== undefined) {
			headers['mcp-session-id'] = sessionId;
		}
		const response = await fetch(options.endpoint, {
			body: JSON.stringify({ jsonrpc: '2.0', method }),
			headers,
			method: 'POST',
		});
		if (!response.ok) {
			throw new Error(
				`MCP notification ${method} failed: ${String(response.status)} ${await response.text()}`,
			);
		}
	}

	async function ensureInitialized(): Promise<void> {
		if (sessionId !== undefined) {
			return;
		}
		await postJsonRpc('initialize', {
			capabilities: {},
			clientInfo: { name: 'agent-vm-openclaw-mcp-portal-smoke', version: '1.0.0' },
			protocolVersion: '2025-03-26',
		});
		await postNotification('notifications/initialized');
	}

	return {
		callTool: async (props): Promise<unknown> => {
			await ensureInitialized();
			return await postJsonRpc('tools/call', {
				arguments: props.args,
				name: props.tool,
			});
		},
		listTools: async (): Promise<readonly string[]> => {
			await ensureInitialized();
			const result = await postJsonRpc('tools/list', {});
			if (!isObjectRecord(result) || !Array.isArray(result.tools)) {
				throw new Error(
					`Expected MCP tools/list result with tools array: ${JSON.stringify(result)}`,
				);
			}
			return result.tools.map((tool) => {
				if (!isObjectRecord(tool) || typeof tool.name !== 'string') {
					throw new Error(`Expected MCP tool descriptor with string name: ${JSON.stringify(tool)}`);
				}
				return tool.name;
			});
		},
	};
}

function createSmokeGatewayClient(harness: SmokeHarnessRuntime): GatewayApiClient {
	const gatewayIngress = harness.runtime.zones[0]?.ingress;
	if (!gatewayIngress) {
		throw new Error('OpenClaw MCP Portal smoke did not expose a gateway ingress URL.');
	}
	return createGatewayApiClient({
		gatewayUrl: `http://${gatewayIngress.host}:${String(gatewayIngress.port)}`,
		token: gatewayToken,
	});
}

function createSmokePortalMcpEndpoint(options: {
	readonly host: string;
	readonly port: number;
}): string {
	const portalIngressPrefix = '/__agent-vm-smoke/mcp-portal';
	return `http://${options.host}:${String(options.port)}${portalIngressPrefix}/agents/${encodeURIComponent(
		agentId,
	)}/mcp`;
}

describeOpenClawMcpPortalSmoke('smoke: OpenClaw MCP Portal gateway boot', () => {
	let harness: SmokeHarnessRuntime | undefined;
	let upstreamServer: StartedFakeUpstreamMcpServer | undefined;
	let gatewayClient: GatewayApiClient | undefined;
	let portalMcpClient: ReturnType<typeof createPortalMcpClient> | undefined;
	let portalMcpEndpoint: string | undefined;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkspacePackages(repoRoot);
		upstreamServer = await startFakeUpstreamMcpServer();
		const upstreamHost = 'smoke-upstream.vm.host';
		const upstreamUrl = `http://${upstreamHost}:${String(upstreamServer.port)}/mcp`;
		const project = await scaffoldOpenClawSmokeProject({
			agents: [agentId],
			architecture,
			prefix: 'openclaw-mcp-portal-smoke-',
			zoneId: 'mcp-portal-smoke',
		});
		const systemZone = project.systemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw smoke project to contain an OpenClaw zone.');
		}
		systemZone.egressHosts = [
			...systemZone.egressHosts,
			{ audience: 'gateway', host: upstreamHost },
		];
		systemZone.secrets = {
			...systemZone.secrets,
			MCP_PORTAL_SERVER_SECRET: {
				audience: 'gateway',
				envVar: 'MCP_PORTAL_SERVER_SECRET',
				injection: 'env',
				source: 'environment',
			},
		};
		await mkdir(path.join(systemZone.gateway.zoneFilesDir, 'agents', agentId), {
			recursive: true,
		});
		await writeOpenClawMcpPortalSmokeConfigs({
			agentId,
			configDir: path.dirname(systemZone.gateway.config),
			namespace: fakeUpstreamNamespace,
			portalAccessHeaderName,
			upstreamUrl,
		});
		await useLocalOpenClawGatewayImagePackages({
			profileName: systemZone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await runBuildCommand({
			forceRebuild: true,
			systemConfig: project.systemConfig,
		});
		harness = await startSmokeControllerRuntime({
			secrets: {
				GITHUB_TOKEN: 'mcp-portal-smoke-github-token',
				MCP_PORTAL_SERVER_SECRET: portalAccessSecret,
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-perplexity-smoke-token',
			},
			startOptions: {
				systemConfig: project.systemConfig,
				zoneIds: [systemZone.id],
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				const portalIngressPrefix = '/__agent-vm-smoke/mcp-portal';
				result.vm.setIngressRoutes([
					{
						port: 18790,
						prefix: portalIngressPrefix,
						stripPrefix: true,
					},
					{
						port: result.processSpec.guestListenPort,
						prefix: '/',
						stripPrefix: true,
					},
				]);
				portalMcpEndpoint = createSmokePortalMcpEndpoint(result.ingress);
				return result;
			},
			tcpHostsOverride: {
				[`${upstreamHost}:${String(upstreamServer.port)}`]: `127.0.0.1:${String(upstreamServer.port)}`,
			},
			vfsMountsOverride: {
				'/work/repo': {
					hostPath: repoRoot,
					kind: 'realfs-readonly',
				},
			},
		});
		gatewayClient = createSmokeGatewayClient(harness);
		if (portalMcpEndpoint === undefined) {
			throw new Error('OpenClaw MCP Portal smoke did not capture a portal MCP endpoint.');
		}
		portalMcpClient = createPortalMcpClient({
			accessHeaderName: portalAccessHeaderName,
			accessSecret: portalAccessSecret,
			endpoint: portalMcpEndpoint,
		});
	}, 900_000);

	afterAll(async () => {
		await harness?.close();
		await upstreamServer?.close();
	});

	it('boots OpenClaw and exposes the gateway API', async () => {
		const status = await gatewayClient?.getGatewayStatus();
		expect(status).toMatchObject({ ready: true });
		await expect(portalMcpClient?.listTools()).resolves.toEqual(
			expect.arrayContaining([
				'mcp_portal_list',
				'mcp_portal_search',
				'mcp_portal_describe',
				'mcp_portal_call',
			]),
		);
	});

	it('discovers the fake upstream namespace through mcp_portal_list', async () => {
		const result = parseGatewayPortalResult(
			await portalMcpClient?.callTool({
				args: { requests: [{ id: 'list', limit: 10 }] },
				tool: 'mcp_portal_list',
			}),
		);
		expect(result).toMatchObject({
			ok: true,
			results: {
				list: {
					ok: true,
					output: {
						namespaces: [fakeUpstreamNamespace],
					},
				},
			},
		});
	});

	it('calls read tools and blocks unsigned write tools', async () => {
		const readArguments = { title: 'Read from full OpenClaw smoke' };
		const readResult = parseGatewayPortalResult(
			await portalMcpClient?.callTool({
				args: {
					calls: [
						{
							arguments: readArguments,
							id: 'read',
							namespace: fakeUpstreamNamespace,
							toolName: 'read_thing',
						},
					],
				},
				tool: 'mcp_portal_call',
			}),
		);
		expect(readResult).toMatchObject({
			ok: true,
			results: {
				read: {
					ok: true,
					output: {
						namespace: fakeUpstreamNamespace,
						toolName: 'read_thing',
					},
				},
			},
		});
		expect(upstreamServer?.calls).toContainEqual({
			argumentsValue: readArguments,
			name: 'read_thing',
		});

		const writeArguments = { title: 'Write from full OpenClaw smoke' };
		const writeResult = parseGatewayPortalResult(
			await portalMcpClient?.callTool({
				args: {
					calls: [
						{
							arguments: writeArguments,
							id: 'write',
							namespace: fakeUpstreamNamespace,
							toolName: 'write_thing',
						},
					],
				},
				tool: 'mcp_portal_call',
			}),
		);
		expect(writeResult).toMatchObject({
			ok: false,
			results: {
				write: {
					error: {
						kind: 'approval_token_missing',
						namespace: fakeUpstreamNamespace,
						toolName: 'write_thing',
					},
					ok: false,
				},
			},
		});
		expect(upstreamServer?.calls).not.toContainEqual({
			argumentsValue: writeArguments,
			name: 'write_thing',
		});
	});
});
