/* oxlint-disable eslint/no-await-in-loop -- smoke test steps must be sequential against live VMs */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
	type StartedFakeUpstreamMcpServer,
} from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
import { portalServerNameForAgent } from '@agent-vm/openclaw-mcp-portal-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBuildCommand } from '../cli/build-command.js';
import {
	createGatewayApiClient,
	type GatewayApiClient,
} from '../gateway-api-client/gateway-api-client.js';
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

function portalToolName(toolName: string): string {
	return `${portalServerNameForAgent(agentId)}__${toolName}`;
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

describeOpenClawMcpPortalSmoke('smoke: OpenClaw MCP Portal gateway boot', () => {
	let harness: SmokeHarnessRuntime | undefined;
	let upstreamServer: StartedFakeUpstreamMcpServer | undefined;
	let gatewayClient: GatewayApiClient | undefined;

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
	}, 900_000);

	afterAll(async () => {
		await harness?.close();
		await upstreamServer?.close();
	});

	it('boots OpenClaw and exposes the gateway API', async () => {
		const status = await gatewayClient?.getGatewayStatus();
		expect(status).toMatchObject({ ready: true });
	});

	it('discovers the fake upstream namespace through mcp_portal_list', async () => {
		const result = parseGatewayPortalResult(
			await gatewayClient?.invokeTool({
				agentId,
				args: { requests: [{ id: 'list', limit: 10 }] },
				tool: portalToolName('mcp_portal_list'),
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
			await gatewayClient?.invokeTool({
				agentId,
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
				tool: portalToolName('mcp_portal_call'),
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
			await gatewayClient?.invokeTool({
				agentId,
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
				tool: portalToolName('mcp_portal_call'),
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
