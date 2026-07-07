/* oxlint-disable eslint/no-await-in-loop -- e2e steps must be sequential against live VMs */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
	type StartedFakeUpstreamMcpServer,
} from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	createGatewayApiClient,
	type GatewayApiClient,
} from '../gateway-api-client/gateway-api-client.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	canRunGondolinE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	type OpenClawE2eProject,
	type E2eHarnessRuntime,
	useLocalOpenClawGatewayImagePackages,
} from './e2e-harness.js';

const architecture = currentE2eArchitecture();
const runOpenClawMcpPortalSmoke =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawMcpPortalSmoke = runOpenClawMcpPortalSmoke ? describe : describe.skip;
const agentIds = ['main', 'beta'] as const;
const mainAgentId = agentIds[0];
const betaAgentId = agentIds[1];
const gatewayToken = 'mcp-portal-smoke-gateway-token';
const unavailableNamespace = 'unavailable-mock';
const portalToolNames = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
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
		path.join(effectivePortalDir, 'tool-portal-effective-manifest.json'),
	);
	const mcpConfigFile = manifest.mcpConfigFile;
	const portalConfigFile = manifest.toolPortalConfigFile;
	if (typeof mcpConfigFile !== 'string' || typeof portalConfigFile !== 'string') {
		throw new Error('Expected Tool Portal effective config manifest to name both config files.');
	}
	return {
		effectiveMcpConfig: await readJsonObjectFile(path.join(effectivePortalDir, mcpConfigFile)),
		effectivePortalConfig: await readJsonObjectFile(
			path.join(effectivePortalDir, portalConfigFile),
		),
	};
}

function createSmokeGatewayClient(harness: E2eHarnessRuntime): GatewayApiClient {
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

async function writeOpenClawMultiAgentMcpPortalE2eConfigs(options: {
	readonly configDir: string;
	readonly namespace: string;
	readonly portalAccessHeaderName: string;
	readonly unavailableNamespace: string;
	readonly unavailableUpstreamUrl: string;
	readonly upstreamUrl: string;
}): Promise<void> {
	await writeFile(
		path.join(options.configDir, 'mcp.config.jsonc'),
		`${JSON.stringify(
			{
				$schema: '../../schemas/mcp.schema.json',
				providers: {
					upstreamMock: {
						discovery: { summary: 'Mock upstream MCP server for e2e tests' },
						kind: 'mcp',
						namespace: options.namespace,
						transport: {
							kind: 'streamable-http',
							url: options.upstreamUrl,
						},
					},
					unavailableMock: {
						discovery: { summary: 'Unavailable upstream MCP server for e2e tests' },
						kind: 'mcp',
						namespace: options.unavailableNamespace,
						transport: {
							kind: 'streamable-http',
							url: options.unavailableUpstreamUrl,
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
		path.join(options.configDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(
			{
				$schema: '../../schemas/mcp-portal.schema.json',
				agents: {
					[mainAgentId]: { profile: 'reader' },
					[betaAgentId]: { profile: 'writer' },
				},
				profiles: {
					reader: {
						namespaces: {
							[options.namespace]: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['read_thing'] },
								},
								tools: { allow: ['read_thing', 'write_thing'] },
							},
							[options.unavailableNamespace]: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['read_thing'] },
								},
								tools: { allow: ['read_thing'] },
							},
						},
						promptContext: { enabled: true, maxNamespaces: 12 },
					},
					writer: {
						namespaces: {
							[options.namespace]: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['write_thing'] },
								},
								tools: { allow: ['read_thing', 'write_thing'] },
							},
						},
						promptContext: { enabled: true, maxNamespaces: 12 },
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
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;
	let upstreamServer: StartedFakeUpstreamMcpServer | undefined;
	let gatewayClient: GatewayApiClient | undefined;

	beforeAll(async () => {
		const repoRoot = path.resolve(process.cwd());
		upstreamServer = await startFakeUpstreamMcpServer();
		const upstreamHost = 'smoke-upstream.vm.host';
		const upstreamUrl = `http://${upstreamHost}:${String(upstreamServer.port)}/mcp`;
		const unavailableUpstreamUrl = `http://${upstreamHost}:${String(upstreamServer.port)}/missing-mcp`;
		project = await scaffoldOpenClawE2eProject({
			agents: agentIds,
			architecture,
			prefix: 'openclaw-mcp-portal-e2e-',
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
		const zoneFilesDir = project.zone.gateway.zoneFilesDir;
		await Promise.all(
			agentIds.map(async (agentId) => {
				await mkdir(path.join(zoneFilesDir, 'agents', agentId), {
					recursive: true,
				});
			}),
		);
		await allowPortalNativeToolsInOpenClawConfig(systemZone.gateway.config);
		await writeOpenClawMultiAgentMcpPortalE2eConfigs({
			configDir: path.dirname(systemZone.gateway.config),
			namespace: fakeUpstreamNamespace,
			portalAccessHeaderName: 'unused-native-smoke-header',
			unavailableNamespace,
			unavailableUpstreamUrl,
			upstreamUrl,
		});
		await useLocalOpenClawGatewayImagePackages({
			profileName: systemZone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ project });
		harness = await startE2eControllerRuntime({
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
					await removeE2eTempRoot(project.tempRoot);
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
			'tool-portal-effective',
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

	it('discovers the fake upstream namespace through tool_portal_list', async () => {
		const result = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId: mainAgentId,
				args: { requests: [{ id: 'list', limit: 10 }] },
				tool: 'tool_portal_list',
			}),
		);
		expect(readSingleItem(result)).toMatchObject({
			id: 'list',
			status: 'ok',
			value: {
				namespaces: [fakeUpstreamNamespace],
			},
		});
	});

	it('keeps same-zone agents on their own Tool Portal profiles', async () => {
		const readArguments = { title: 'Read from full OpenClaw smoke' };
		const readResult = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId: mainAgentId,
				args: {
					calls: [
						{
							arguments: readArguments,
							id: 'read',
							name: 'read_thing',
							namespace: fakeUpstreamNamespace,
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);
		expect(readSingleItem(readResult)).toMatchObject({
			id: 'read',
			status: 'ok',
			value: {
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
				name: 'read_thing',
			},
		});
		expect(upstreamServer?.calls).toContainEqual({
			argumentsValue: readArguments,
			name: 'read_thing',
		});

		const writeArguments = { title: 'Write from full OpenClaw smoke' };
		const upstreamRequestCountBeforeDeniedWrite = upstreamServer?.requests.length ?? 0;
		const deniedWriteResult = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId: mainAgentId,
				args: {
					calls: [
						{
							arguments: writeArguments,
							id: 'write',
							name: 'write_thing',
							namespace: fakeUpstreamNamespace,
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);
		expect(deniedWriteResult).toMatchObject({
			items: [
				{
					error: {
						code: 'capability_denied',
					},
					id: 'write',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(upstreamServer?.calls).not.toContainEqual({
			argumentsValue: writeArguments,
			name: 'write_thing',
		});
		expect(upstreamServer?.requests.length).toBe(upstreamRequestCountBeforeDeniedWrite);

		const betaListResult = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId: betaAgentId,
				args: { requests: [{ id: 'beta-list', limit: 10 }] },
				tool: 'tool_portal_list',
			}),
		);
		expect(readSingleItem(betaListResult)).toMatchObject({
			id: 'beta-list',
			status: 'ok',
			value: {
				namespaces: [fakeUpstreamNamespace],
			},
		});

		const betaReadDeniedArguments = { title: 'Beta read should stay denied' };
		const upstreamRequestCountBeforeDeniedBetaRead = upstreamServer?.requests.length ?? 0;
		const betaReadDeniedResult = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId: betaAgentId,
				args: {
					calls: [
						{
							arguments: betaReadDeniedArguments,
							id: 'beta-read-denied',
							name: 'read_thing',
							namespace: fakeUpstreamNamespace,
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);
		expect(betaReadDeniedResult).toMatchObject({
			items: [
				{
					error: {
						code: 'capability_denied',
					},
					id: 'beta-read-denied',
					status: 'error',
				},
			],
			ok: false,
		});
		expect(upstreamServer?.calls).not.toContainEqual({
			argumentsValue: betaReadDeniedArguments,
			name: 'read_thing',
		});
		expect(upstreamServer?.requests.length).toBe(upstreamRequestCountBeforeDeniedBetaRead);

		const betaWriteArguments = { title: 'Write from beta agent' };
		const betaWriteResult = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId: betaAgentId,
				args: {
					calls: [
						{
							arguments: betaWriteArguments,
							id: 'beta-write',
							name: 'write_thing',
							namespace: fakeUpstreamNamespace,
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);
		expect(readSingleItem(betaWriteResult)).toMatchObject({
			id: 'beta-write',
			status: 'ok',
			value: {
				namespace: fakeUpstreamNamespace,
				result: {
					structuredContent: {
						name: 'write_thing',
						ok: true,
					},
				},
				name: 'write_thing',
			},
		});
		expect(upstreamServer?.calls).toContainEqual({
			argumentsValue: betaWriteArguments,
			name: 'write_thing',
		});
	});

	it('fails closed for unavailable MCP namespaces without calling upstream tools', async () => {
		const unavailableArguments = { title: 'Unavailable should not call upstream' };
		const unavailableResult = parseNativePortalToolResult(
			await gatewayClient?.invokeTool({
				agentId: mainAgentId,
				args: {
					calls: [
						{
							arguments: unavailableArguments,
							id: 'unavailable-read',
							name: 'read_thing',
							namespace: unavailableNamespace,
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);

		expect(readSingleItem(unavailableResult)).toMatchObject({
			error: {
				code: 'provider_unavailable',
				message: 'Capability provider is unavailable.',
			},
			id: 'unavailable-read',
			status: 'error',
		});
		expect(upstreamServer?.calls).not.toContainEqual({
			argumentsValue: unavailableArguments,
			name: 'read_thing',
		});
		expect(
			upstreamServer?.requests.some(
				(request) =>
					request.path === '/missing-mcp' && request.jsonRpcMethods.includes('tools/call'),
			),
		).toBe(false);
	});
});
