/* oxlint-disable eslint/no-await-in-loop -- smoke test steps must be sequential against live VMs */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
	removeSmokeTempRoot,
	scaffoldOpenClawSmokeProject,
	startSmokeControllerRuntime,
	type OpenClawSmokeProject,
	type SmokeHarnessRuntime,
	useLocalOpenClawGatewayImagePackages,
	writeOpenClawMcpPortalSmokeConfigs,
} from './smoke-harness.js';

const architecture = currentSmokeArchitecture();
const runOpenClawMcpPortalSmoke =
	process.env.AGENT_VM_OPENCLAW_SMOKE === '1' && (await canRunGondolinSmoke({ architecture }));
const describeOpenClawMcpPortalSmoke = runOpenClawMcpPortalSmoke ? describe : describe.skip;
const agentId = 'smoke';
const gatewayToken = 'mcp-portal-smoke-gateway-token';
const portalToolNames = [
	'mcp_portal_list',
	'mcp_portal_search',
	'mcp_portal_describe',
	'mcp_portal_call',
] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonObjectFile(filePath: string): Promise<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
	if (!isObjectRecord(parsed)) {
		throw new Error(`Expected JSON object in ${filePath}.`);
	}
	return parsed;
}

async function readManagedEffectiveConfigPair(effectivePortalDir: string): Promise<{
	readonly effectiveMcpConfig: Record<string, unknown>;
	readonly effectivePortalConfig: Record<string, unknown>;
}> {
	const manifest = await readJsonObjectFile(
		path.join(effectivePortalDir, 'mcp-portal-effective-manifest.json'),
	);
	const mcpConfigFile = manifest.mcpConfigFile;
	const portalConfigFile = manifest.portalConfigFile;
	if (typeof mcpConfigFile !== 'string' || typeof portalConfigFile !== 'string') {
		throw new Error('Expected MCP Portal effective config manifest to name both config files.');
	}
	return {
		effectiveMcpConfig: await readJsonObjectFile(path.join(effectivePortalDir, mcpConfigFile)),
		effectivePortalConfig: await readJsonObjectFile(
			path.join(effectivePortalDir, portalConfigFile),
		),
	};
}

function createSmokeGatewayClient(harness: SmokeHarnessRuntime): GatewayApiClient {
	const gatewayIngress = harness.runtime.zones[0]?.gateway?.ingress;
	if (!gatewayIngress) {
		throw new Error('OpenClaw MCP Portal smoke did not expose a gateway ingress URL.');
	}
	return createGatewayApiClient({
		gatewayUrl: `http://${gatewayIngress.host}:${String(gatewayIngress.port)}`,
		token: gatewayToken,
	});
}

async function allowPortalNativeToolsInOpenClawConfig(configPath: string): Promise<void> {
	const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
	if (!isObjectRecord(parsed)) {
		throw new Error('Expected OpenClaw smoke config to be a JSON object.');
	}
	const tools = isObjectRecord(parsed.tools) ? parsed.tools : {};
	const existingAllow = Array.isArray(tools.allow)
		? tools.allow.filter((tool): tool is string => typeof tool === 'string')
		: [];
	parsed.tools = {
		...tools,
		allow: [...new Set([...existingAllow, ...portalToolNames])],
	};
	await writeFile(configPath, `${JSON.stringify(parsed, null, '\t')}\n`, 'utf8');
}

function parseNativePortalToolResult(value: unknown): unknown {
	if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.result)) {
		throw new Error(`Expected successful OpenClaw /tools/invoke result: ${JSON.stringify(value)}`);
	}
	const details = value.result.details;
	if (details !== undefined) {
		return details;
	}
	const content = value.result.content;
	if (typeof content === 'string') {
		return JSON.parse(content) as unknown;
	}
	throw new Error(
		`Expected OpenClaw tool result details or JSON content: ${JSON.stringify(value)}`,
	);
}

function readScalarStructuredContent(result: unknown): unknown {
	if (!isObjectRecord(result) || !Array.isArray(result.content)) {
		throw new Error(`Expected scalar PortalCoreResult content: ${JSON.stringify(result)}`);
	}
	const contentBlock = result.content[0];
	if (!isObjectRecord(contentBlock) || contentBlock.type !== 'json') {
		throw new Error(
			`Expected first scalar PortalCoreResult block to be JSON: ${JSON.stringify(result)}`,
		);
	}
	return contentBlock.value;
}

function readSingleItem(result: unknown): Record<string, unknown> {
	if (!isObjectRecord(result) || !Array.isArray(result.items) || result.items.length !== 1) {
		throw new Error(`Expected PortalCoreResult with exactly one item: ${JSON.stringify(result)}`);
	}
	const item = result.items[0];
	if (!isObjectRecord(item)) {
		throw new Error(`Expected PortalCore item object: ${JSON.stringify(result)}`);
	}
	return item;
}

describeOpenClawMcpPortalSmoke('smoke: OpenClaw MCP Portal gateway boot', () => {
	let harness: SmokeHarnessRuntime | undefined;
	let project: OpenClawSmokeProject | undefined;
	let upstreamServer: StartedFakeUpstreamMcpServer | undefined;
	let gatewayClient: GatewayApiClient | undefined;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		rebuildWorkspacePackages(repoRoot);
		upstreamServer = await startFakeUpstreamMcpServer();
		const upstreamHost = 'smoke-upstream.vm.host';
		const upstreamUrl = `http://${upstreamHost}:${String(upstreamServer.port)}/mcp`;
		project = await scaffoldOpenClawSmokeProject({
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
		await mkdir(path.join(systemZone.gateway.zoneFilesDir, 'agents', agentId), {
			recursive: true,
		});
		await allowPortalNativeToolsInOpenClawConfig(systemZone.gateway.config);
		await writeOpenClawMcpPortalSmokeConfigs({
			agentId,
			configDir: path.dirname(systemZone.gateway.config),
			namespace: fakeUpstreamNamespace,
			portalAccessHeaderName: 'unused-native-smoke-header',
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
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				PERPLEXITY_API_KEY: 'unused-perplexity-smoke-token',
			},
			startOptions: {
				systemConfig: project.systemConfig,
				zoneIds: [systemZone.id],
			},
			startGatewayZone: async (startGatewayOptions) => {
				const result = await startGatewayZone(startGatewayOptions);
				result.vm.setIngressRoutes([
					{
						port: result.processSpec.guestListenPort,
						prefix: '/',
						stripPrefix: true,
					},
				]);
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
	}, 900_000);

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			try {
				await upstreamServer?.close();
			} finally {
				if (project) {
					await removeSmokeTempRoot(project.tempRoot);
				}
			}
		}
	});

	it('boots OpenClaw and exposes the gateway API', async () => {
		const status = await gatewayClient?.getGatewayStatus();
		expect(status).toMatchObject({ ready: true });
	});

	it('materializes native portal config without legacy server wiring', async () => {
		if (harness === undefined) {
			throw new Error('Expected OpenClaw MCP Portal smoke harness to be initialized.');
		}
		const zone = harness.systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw MCP Portal smoke zone to be initialized.');
		}
		const effectivePortalDir = path.join(
			harness.systemConfig.cacheDir,
			'gateways',
			zone.id,
			'mcp-portal-effective',
		);
		const { effectiveMcpConfig, effectivePortalConfig } =
			await readManagedEffectiveConfigPair(effectivePortalDir);
		const effectiveOpenClawConfig = await readJsonObjectFile(
			path.join(zone.gateway.stateDir, 'effective-openclaw.json'),
		);
		const mcpConfig = isObjectRecord(effectiveOpenClawConfig.mcp)
			? effectiveOpenClawConfig.mcp
			: {};
		const mcpServers = isObjectRecord(mcpConfig.servers) ? mcpConfig.servers : {};
		const serializedManagedConfigs = JSON.stringify({
			effectiveMcpConfig,
			effectiveOpenClawConfig,
			effectivePortalConfig,
		});

		expect(
			Object.keys(mcpServers).filter((serverName) => serverName.startsWith('mcp_portal')),
		).toEqual([]);
		expect(harness.runtime.zones[0]?.gateway?.ingress.port).not.toBe(18_790);
		expect(serializedManagedConfigs).not.toContain('agent-vm-mcp-portal-server');
		expect(serializedManagedConfigs).not.toMatch(
			/OP_SERVICE_ACCOUNT_TOKEN|OP_CONNECT_TOKEN|OP_SESSION|op read|spawn op/u,
		);
		expect(effectivePortalConfig.mcpProxy).toBeUndefined();
		expect(effectivePortalConfig.externalAuth).toBeUndefined();
	});

	it('discovers the fake upstream namespace through mcp_portal_list', async () => {
		const result = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId,
				args: { requests: [{ id: 'list', limit: 10 }] },
				tool: 'mcp_portal_list',
			}),
		);
		expect(readScalarStructuredContent(result)).toMatchObject({
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
		const readResult = parseNativePortalToolResult(
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
				tool: 'mcp_portal_call',
			}),
		);
		expect(readSingleItem(readResult)).toMatchObject({
			requestId: 'read',
			status: 'success',
			structuredContent: {
				namespace: fakeUpstreamNamespace,
				result: {
					content: [
						{
							text: expect.stringContaining('"name":"read_thing"'),
							type: 'text',
						},
					],
					structuredContent: {
						name: 'read_thing',
						ok: true,
					},
				},
				toolName: 'read_thing',
			},
		});
		expect(upstreamServer?.calls).toContainEqual({
			argumentsValue: readArguments,
			name: 'read_thing',
		});

		const writeArguments = { title: 'Write from full OpenClaw smoke' };
		await expect(
			gatewayClient?.invokeTool({
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
				tool: 'mcp_portal_call',
			}),
		).rejects.toThrow(/requiresApproval/u);
		expect(upstreamServer?.calls).not.toContainEqual({
			argumentsValue: writeArguments,
			name: 'write_thing',
		});
	});
});
