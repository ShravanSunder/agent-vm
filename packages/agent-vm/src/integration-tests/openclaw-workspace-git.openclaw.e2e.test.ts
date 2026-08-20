import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolPortalConfig } from '@agent-vm/config-contracts';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';

import { resolveWorkspaceGitBranchObjectId } from '../controller/workspace-git/workspace-git-operations.js';
import { createGatewayApiClient } from '../gateway-api-client/gateway-api-client.js';
import {
	canRunManagedVmE2e,
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
const runOpenClawWorkspaceGitSmoke =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeOpenClawWorkspaceGitSmoke = runOpenClawWorkspaceGitSmoke ? describe : describe.skip;
const portalToolNames = [
	'tool_portal_list',
	'tool_portal_search',
	'tool_portal_describe',
	'tool_portal_call',
] as const;
const commitWorkspaceThroughToolVmScript = [
	'set -eu',
	'export GIT_CONFIG_GLOBAL=/dev/null',
	'export GIT_CONFIG_NOSYSTEM=1',
	'export HOME=/nonexistent/agent-vm-e2e-git-home',
	'cd /workspace',
	"printf '%s\\n' 'workspace git push through Tool Portal' > workspace-git-proof.txt",
	"commit_log='.agent-vm-e2e-git-command.log'",
	'set +e',
	'{',
	'  /usr/bin/git -c safe.directory=/workspace add -- workspace-git-proof.txt &&',
	"  /usr/bin/git -c safe.directory=/workspace -c user.name='Agent VM E2E' -c user.email='agent-vm-e2e@example.invalid' commit -m 'test: workspace Git Tool Portal push'",
	'} > "$commit_log" 2>&1',
	'commit_exit_code=$?',
	'set -e',
	'if [ "$commit_exit_code" -ne 0 ]; then exit "$commit_exit_code"; fi',
	'rm -f -- "$commit_log"',
].join('\n');

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function allowPortalNativeToolsInOpenClawConfig(configPath: string): Promise<void> {
	const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
	if (!isObjectRecord(parsed)) {
		throw new Error('Expected OpenClaw workspace Git smoke config to be a JSON object.');
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

async function writeWorkspaceGitToolPortalConfigs(options: {
	readonly agentId: string;
	readonly configDir: string;
}): Promise<void> {
	const toolPortalConfig = {
		agents: { [options.agentId]: { profile: 'smoke' } },
		mode: 'managed',
		profiles: {
			smoke: {
				namespaces: {
					controller_execution: {
						backend: {
							kind: 'controller_execution',
							operations: {
								controller_host_probe: { kind: 'registered_action' },
								workspace_git_push: { kind: 'registered_action' },
							},
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: {
								allow: ['workspace_git_push', 'controller_host_probe'],
								deny: [],
							},
						},
						tools: {
							allow: ['workspace_git_push', 'controller_host_probe'],
							deny: [],
						},
					},
					sandbox: {
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								commit_workspace: {
									description: 'Create one committed workspace change inside the real Tool VM.',
									executable: '/bin/sh',
									kind: 'command.fixed',
									mandatoryArgvPrefix: ['-c', commitWorkspaceThroughToolVmScript],
									workingDirectory: '.',
								},
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['commit_workspace'], deny: [] },
						},
						tools: { allow: ['commit_workspace'], deny: [] },
					},
				},
			},
		},
		schemaVersion: 1,
	} satisfies ToolPortalConfig;
	await writeFile(
		path.join(options.configDir, 'mcp.config.jsonc'),
		`${JSON.stringify({ providers: {}, schemaVersion: 1 }, null, '\t')}\n`,
		'utf8',
	);
	await writeFile(
		path.join(options.configDir, 'tool-portal.config.jsonc'),
		`${JSON.stringify(toolPortalConfig, null, '\t')}\n`,
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

describeOpenClawWorkspaceGitSmoke('smoke: OpenClaw workspace Git through Tool Portal', () => {
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

	it('replaces the old direct workspace_git_push model tool with Tool Portal controller_execution', async () => {
		const repoRoot = path.resolve(process.cwd());
		const agentId = 'smoke';

		project = await scaffoldOpenClawE2eProject({
			agents: [agentId],
			architecture,
			prefix: 'openclaw-workspace-git-e2e-',
			zoneId: 'workspace-git-smoke',
		});
		const systemZone = project.systemConfig.zones[0];
		if (!systemZone || systemZone.gateway.type !== 'openclaw') {
			throw new Error('Expected workspace Git smoke system config to contain an OpenClaw zone.');
		}
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
		systemZone.toolPortal = {
			configDir: toolPortalConfigDir,
			surfaceEligibilityByProfile: {
				smoke: {
					controller_execution: ['protected_uds'],
					sandbox: ['protected_uds'],
				},
			},
		};
		await allowPortalNativeToolsInOpenClawConfig(project.zone.gateway.config);
		await writeWorkspaceGitToolPortalConfigs({
			agentId,
			configDir: toolPortalConfigDir,
		});
		const remoteGitDir = path.join(project.tempRoot, 'zone-files-remote.git');
		const workspaceGitBranch = 'agent/zone-files';
		await execa('git', ['init', '--bare', remoteGitDir]);
		project.systemConfig.host.githubToken = {
			source: 'environment',
			envVar: 'AGENT_VM_TEST_ZONE_GIT_TOKEN',
		};
		systemZone.agents = (systemZone.agents ?? []).map((agent) =>
			agent.id === agentId
				? {
						...agent,
						workspaceGit: {
							mode: 'remote' as const,
							remote: {
								branch: workspaceGitBranch,
								defaultBranch: 'main',
								repoUrl: remoteGitDir,
							},
						},
					}
				: agent,
		);
		await prepareGatewayE2eProjectImages({ project });

		harness = await startE2eControllerRuntime({
			secrets: {
				AGENT_VM_E2E_CONTROLLER_HOST_PROBE: '1',
				AGENT_VM_TEST_ZONE_GIT_TOKEN: 'local-remote-token-not-for-tool-vm',
				GITHUB_TOKEN: 'local-remote-token-not-for-tool-vm',
				OPENCLAW_GATEWAY_TOKEN: 'workspace-git-smoke-gateway-token',
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
			token: 'workspace-git-smoke-gateway-token',
		});
		await expect(
			gatewayClient.invokeTool({
				agentId,
				args: { expectedHead: '0000000000000000000000000000000000000000' },
				tool: 'workspace_git_push',
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
				namespaces: expect.arrayContaining(['controller_execution', 'sandbox']),
				tools: expect.arrayContaining([
					expect.objectContaining({ name: 'workspace_git_push' }),
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
							namespace: 'controller_execution',
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
				action: {
					actionId: 'controller_host_probe',
					result: {
						entryNames: ['agent-vm-host-probe.txt'],
						probeKind: 'controller_cache_dir_listing',
					},
				},
				kind: 'registered_action',
			},
		});

		const commitResult = parseNativePortalToolResult(
			await gatewayClient.invokeTool({
				agentId,
				args: {
					calls: [
						{
							arguments: {},
							id: 'commit-workspace-in-tool-vm',
							name: 'commit_workspace',
							namespace: 'sandbox',
						},
					],
				},
				tool: 'tool_portal_call',
			}),
		);
		const commitItem = expectSingleItemStatusOk(commitResult);
		const commitValue = commitItem.value;
		if (
			!isObjectRecord(commitValue) ||
			commitValue.kind !== 'exited' ||
			commitValue.exitCode !== 0
		) {
			const commitDiagnosticPath = path.join(
				systemZone.gateway.zoneFilesDir,
				'agents',
				agentId,
				'.agent-vm-e2e-git-command.log',
			);
			const commitDiagnostic = await readFile(commitDiagnosticPath, 'utf8').catch(
				(error: unknown) =>
					`<unavailable: ${error instanceof Error ? error.message : String(error)}>`,
			);
			throw new Error(
				`Tool VM workspace Git commit failed: ${JSON.stringify(commitItem)}\n${commitDiagnostic}`,
			);
		}
		expect(commitItem).toMatchObject({
			id: 'commit-workspace-in-tool-vm',
			status: 'ok',
			value: { exitCode: 0, kind: 'exited' },
		});
		const committedHead = await resolveWorkspaceGitBranchObjectId({
			agentId,
			branch: workspaceGitBranch,
			zoneRuntimeDir: project.zone.gateway.zoneRuntimeDir,
			zoneId: project.zone.id,
		});
		if (committedHead === null) {
			throw new Error('Expected the Tool VM to create one committed workspace Git head.');
		}

		const pushResult = parseNativePortalToolResult(
			await gatewayClient.invokeTool({
				agentId,
				args: {
					calls: [
						{
							arguments: { expectedHead: committedHead },
							id: 'push-zone',
							name: 'workspace_git_push',
							namespace: 'controller_execution',
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
				action: {
					actionId: 'workspace_git_push',
					result: {
						branch: workspaceGitBranch,
						localHead: committedHead,
						remoteHead: committedHead,
					},
				},
				kind: 'registered_action',
			},
		});
		await expect(
			execa('/usr/bin/git', [
				`--git-dir=${remoteGitDir}`,
				'rev-parse',
				`refs/heads/${workspaceGitBranch}`,
			]),
		).resolves.toMatchObject({ stdout: committedHead });
	}, 900_000);
});
