/* oxlint-disable eslint/no-await-in-loop -- e2e steps must be sequential against live VMs */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import {
	ensureZoneGitRepository,
	getZoneGitStatus,
} from '../controller/zone-git/zone-git-operations.js';
import { resolveZoneGitPaths } from '../controller/zone-git/zone-git-paths.js';
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import {
	canRunGondolinE2e,
	currentE2eArchitecture,
	disableOpenClawMcpPortalPlugin,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	type E2eHarnessRuntime,
	type OpenClawE2eProject,
	useLocalOpenClawPluginGatewayImage,
	useLocalToolVmMcpPortalPackage,
} from './e2e-harness.js';

const architecture = currentE2eArchitecture();
const runOpenClawZoneGitSmoke =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunGondolinE2e({ architecture }));
const describeOpenClawZoneGitSmoke = runOpenClawZoneGitSmoke ? describe : describe.skip;
const portalToolNames = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function allowPortalNativeToolsInOpenClawConfig(configPath: string): Promise<void> {
	const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
	if (!isObjectRecord(parsed)) {
		throw new Error('Expected OpenClaw zone Git smoke config to be a JSON object.');
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

async function writeZoneGitToolPortalConfigs(options: {
	readonly agentId: string;
	readonly configDir: string;
}): Promise<void> {
	await writeFile(
		path.join(options.configDir, 'mcp.config.jsonc'),
		`${JSON.stringify({ providers: {}, schemaVersion: 1 }, null, '\t')}\n`,
		'utf8',
	);
	await writeFile(
		path.join(options.configDir, 'mcp-portal.config.jsonc'),
		`${JSON.stringify(
			{
				agents: { [options.agentId]: { profile: 'smoke' } },
				profiles: {
					smoke: {
						namespaces: {
							controller_host_action: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['zone_git_push', 'controller_host_probe'] },
								},
								tools: { allow: ['zone_git_push', 'controller_host_probe'] },
							},
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
		throw new Error(`Expected Portal result with exactly one item: ${JSON.stringify(result)}`);
	}
	const item = result.items[0];
	if (!isObjectRecord(item)) {
		throw new Error(`Expected Portal item object: ${JSON.stringify(result)}`);
	}
	return item;
}

function expectSingleItemStatusOk(result: unknown): Record<string, unknown> {
	const item = readSingleItem(result);
	if (item.status !== 'ok') {
		throw new Error(`Expected Portal item status ok: ${JSON.stringify(item)}`);
	}
	return item;
}

describeOpenClawZoneGitSmoke('smoke: OpenClaw zone Git legacy surface', () => {
	let harness: E2eHarnessRuntime | undefined;
	let project: OpenClawE2eProject | undefined;

	afterAll(async () => {
		try {
			await harness?.close();
		} finally {
			if (project) {
				await removeE2eTempRoot(project.tempRoot);
			}
		}
	});

	it('replaces the old direct zone_git_push model tool with Tool Portal controller_host_action', async () => {
		const repoRoot = path.resolve(process.cwd());
		const agentId = 'smoke';

		project = await scaffoldOpenClawE2eProject({
			agents: [agentId],
			architecture,
			prefix: 'openclaw-zone-git-e2e-',
			zoneId: 'zone-git-smoke',
		});
		await useLocalOpenClawPluginGatewayImage({
			profileName: project.zone.gateway.imageProfile,
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		await disableOpenClawMcpPortalPlugin(project.zone.gateway.config);
		await useLocalToolVmMcpPortalPackage({
			projectRoot: project.tempRoot,
			repoRoot,
			systemConfig: project.systemConfig,
		});
		const toolPortalConfigDir = path.dirname(project.zone.gateway.config);
		project.zone.toolPortal = { configDir: toolPortalConfigDir };
		await allowPortalNativeToolsInOpenClawConfig(project.zone.gateway.config);
		await writeZoneGitToolPortalConfigs({
			agentId,
			configDir: toolPortalConfigDir,
		});
		const remoteGitDir = path.join(project.tempRoot, 'zone-files-remote.git');
		const zoneGitBranch = 'agent/zone-files';
		await execa('git', ['init', '--bare', remoteGitDir]);
		project.systemConfig.host.githubToken = {
			source: 'environment',
			envVar: 'AGENT_VM_TEST_ZONE_GIT_TOKEN',
		};
		project.zone.gateway.zoneGit = {
			remote: {
				branch: zoneGitBranch,
				defaultBranch: 'main',
				protectedBranches: ['main'],
				protectedBranchPatterns: ['release/*'],
				repoUrl: remoteGitDir,
			},
		};
		await mkdir(path.join(project.zone.gateway.zoneFilesDir, 'agents', 'smoke'), {
			recursive: true,
		});
		await ensureZoneGitRepository({
			branch: zoneGitBranch,
			remoteUrl: remoteGitDir,
			runtimeDir: project.systemConfig.runtimeDir,
			zoneFilesDir: project.zone.gateway.zoneFilesDir,
			zoneId: project.zone.id,
		});
		const proofFilePath = path.join(
			project.zone.gateway.zoneFilesDir,
			'agents',
			agentId,
			'zone-git-proof.txt',
		);
		await writeFile(proofFilePath, 'zone git push through Tool Portal\n', 'utf8');
		const zoneGitPaths = resolveZoneGitPaths({
			runtimeDir: project.systemConfig.runtimeDir,
			zoneId: project.zone.id,
		});
		await execa('git', [
			`--git-dir=${zoneGitPaths.hostGitDir}`,
			`--work-tree=${project.zone.gateway.zoneFilesDir}`,
			'add',
			'.',
		]);
		await execa('git', [
			`--git-dir=${zoneGitPaths.hostGitDir}`,
			`--work-tree=${project.zone.gateway.zoneFilesDir}`,
			'-c',
			'user.name=Agent VM E2E',
			'-c',
			'user.email=agent-vm-e2e@example.invalid',
			'commit',
			'-m',
			'test: zone git tool portal push',
		]);
		const zoneGitStatus = await getZoneGitStatus({
			branch: zoneGitBranch,
			remoteUrl: remoteGitDir,
			runtimeDir: project.systemConfig.runtimeDir,
			zoneFilesDir: project.zone.gateway.zoneFilesDir,
			zoneId: project.zone.id,
		});
		if (zoneGitStatus.localHead === null) {
			throw new Error('Expected zone Git repository to have a local commit before push.');
		}
		await prepareGatewayE2eProjectImages({ project });

		harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_E2E_CONTROLLER_HOST_PROBE: '1',
				AGENT_VM_TEST_ZONE_GIT_TOKEN: 'local-remote-token-not-for-tool-vm',
				GITHUB_TOKEN: 'local-remote-token-not-for-tool-vm',
				MCP_PORTAL_SERVER_SECRET: 'zone-git-smoke-portal-secret',
				OPENCLAW_GATEWAY_TOKEN: 'zone-git-smoke-gateway-token',
				PERPLEXITY_API_KEY: 'unused-perplexity-smoke-token',
			},
			startOptions: {
				systemConfig: project.systemConfig,
				zoneIds: [project.zone.id],
			},
		});
		const gatewayIngress = harness.runtime.zones[0]?.gateway?.ingress;
		if (!gatewayIngress) {
			throw new Error('OpenClaw gateway smoke did not expose an ingress URL.');
		}

		const gatewayClient = createGatewayApiClient({
			gatewayUrl: `http://${gatewayIngress.host}:${String(gatewayIngress.port)}`,
			token: 'zone-git-smoke-gateway-token',
		});
		await expect(
			gatewayClient.invokeTool({
				agentId,
				args: { expectedHead: 'legacy-zone-git-head' },
				tool: 'zone_git_push',
			}),
		).rejects.toThrow(/Gateway API returned status/u);
		const listResult = parseNativePortalToolResult(
			await gatewayClient.invokeTool({
				agentId,
				args: { requests: [{ id: 'list-actions' }] },
				tool: 'tool_portal_list',
			}),
		);
		expect(readSingleItem(listResult)).toMatchObject({
			id: 'list-actions',
			status: 'ok',
			value: {
				namespaces: ['controller_host_action'],
				tools: expect.arrayContaining([
					expect.objectContaining({ name: 'zone_git_push' }),
					expect.objectContaining({ name: 'controller_host_probe' }),
				]),
			},
		});

		const hostProbeResult = parseNativePortalToolResult(
			await gatewayClient.invokeTool({
				agentId,
				args: {
					calls: [
						{
							arguments: {},
							id: 'probe-controller-host',
							name: 'controller_host_probe',
							namespace: 'controller_host_action',
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);
		expect(expectSingleItemStatusOk(hostProbeResult)).toMatchObject({
			id: 'probe-controller-host',
			status: 'ok',
			value: {
				actionId: 'controller_host_probe',
				result: {
					entryNames: ['agent-vm-host-probe.txt'],
					probeKind: 'controller_cache_dir_listing',
				},
			},
		});

		const pushResult = parseNativePortalToolResult(
			await gatewayClient.invokeTool({
				agentId,
				args: {
					calls: [
						{
							arguments: { expectedHead: zoneGitStatus.localHead },
							id: 'push-zone',
							name: 'zone_git_push',
							namespace: 'controller_host_action',
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);
		expect(expectSingleItemStatusOk(pushResult)).toMatchObject({
			id: 'push-zone',
			status: 'ok',
			value: {
				actionId: 'zone_git_push',
				result: {
					branch: zoneGitBranch,
					localHead: zoneGitStatus.localHead,
					remoteHead: zoneGitStatus.localHead,
				},
			},
		});
	}, 900_000);
});
