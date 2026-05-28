import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
	buildOpenClawDeploymentDoctorChecks,
	collectOpenClawDeploymentDoctorChecks,
} from './openclaw-deployment-doctor.js';

const openClawToolVmSandbox = {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
} satisfies Record<string, string>;

const openClawSandboxPluginTools = {
	sandbox: {
		tools: {
			alsoAllow: ['group:plugins'],
		},
	},
} satisfies Record<string, unknown>;

const openClawPluginApprovalSession = {
	plugin: {
		enabled: true,
		mode: 'session',
	},
} satisfies Record<string, unknown>;

function createSystemConfig(
	openClawConfigPath: string,
	authProfilesByAgent: Record<string, { readonly ref: string; readonly source: '1password' }> = {},
	mcpConfigDir?: string,
	stateDir = './state/shravan',
): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: './cache',
			runtimeDir: './runtime',
			host: {
				controllerPort: 18800,
				projectNamespace: 'agent-vm-test',
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: './vm-images/gateways/openclaw/build-config.json',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: './vm-images/tool-vms/default/build-config.json',
					},
				},
			},
			tcpPool: { basePort: 19000, size: 5 },
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
			zones: [
				{
					egressHosts: ['api.openai.com'].map((host) => ({
						audience: 'gateway' as const,
						host,
					})),
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: openClawConfigPath,
						port: 18791,
						stateDir,
						zoneFilesDir: './zone-files/shravan',
						authProfilesByAgent,
					},
					id: 'shravan',
					...(mcpConfigDir === undefined ? {} : { mcpPortal: { configDir: mcpConfigDir } }),
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							audience: 'gateway',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							source: 'environment',
						},
					},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath: path.join(path.dirname(openClawConfigPath), 'system.json') },
	);
}

describe('buildOpenClawDeploymentDoctorChecks', () => {
	it('accepts current agent-vm OpenClaw scaffold defaults', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun', 'shravan'],
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }, { id: 'shravan' }],
					},
					session: {
						dmScope: 'per-channel-peer',
					},
					approvals: {
						plugin: {
							enabled: true,
							mode: 'session',
						},
					},
					channels: {
						discord: {
							enabled: true,
							guilds: {
								'guild-1': {},
							},
						},
					},
					bindings: [
						{
							match: {
								channel: 'discord',
								guildId: 'guild-1',
							},
							agentId: 'shravan',
						},
					],
					plugins: {
						allow: ['gondolin', 'memory-core', 'mcp-portal'],
						entries: {
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
							'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions/gondolin',
								'/home/openclaw/.openclaw/extensions/mcp-portal',
							],
						},
						slots: { memory: 'memory-core' },
					},
					tools: openClawSandboxPluginTools,
				},
			},
		]);

		expect(checks.every((check) => check.ok)).toBe(true);
	});

	it('flags managed MCP Portal deployments without plugin approval session forwarding', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun'],
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
					session: {
						dmScope: 'per-channel-peer',
					},
					plugins: {
						allow: ['gondolin', 'memory-core', 'mcp-portal'],
						entries: {
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
							'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions/gondolin',
								'/home/openclaw/.openclaw/extensions/mcp-portal',
							],
						},
						slots: { memory: 'memory-core' },
					},
					tools: openClawSandboxPluginTools,
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-mcp-portal-plugin-approvals-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Set approvals.plugin.enabled=true and approvals.plugin.mode="session" so MCP Portal tools that require approval can return prompts to the originating chat.',
		});
	});

	it('flags OpenAI provider configs that do not explicitly use pi runtime', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: [],
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					models: {
						providers: {
							openai: {
								apiKey: { provider: 'default', id: 'OPENAI_API_KEY' },
							},
						},
					},
					plugins: {
						allow: ['gondolin', 'memory-core', 'mcp-portal'],
						entries: {
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
							'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions/gondolin',
								'/home/openclaw/.openclaw/extensions/mcp-portal',
							],
						},
						slots: { memory: 'memory-core' },
					},
					approvals: openClawPluginApprovalSession,
					tools: openClawSandboxPluginTools,
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-openai-provider-runtime-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Set models.providers.openai.agentRuntime.id="pi" so OpenAI API-key models do not get claimed by the Codex OAuth runtime.',
		});
	});

	it('accepts OpenAI provider configs that explicitly use pi runtime', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: [],
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					models: {
						providers: {
							openai: {
								apiKey: { provider: 'default', id: 'OPENAI_API_KEY' },
								agentRuntime: { id: 'pi' },
							},
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-openai-provider-runtime-shravan'),
		).toMatchObject({ ok: true });
	});

	it('ignores OpenClaw-owned Discord session and binding semantics', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun'],
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
					session: {
						dmScope: 'per-peer',
						identityLinks: {
							shravan: ['discord:709857988919164981'],
						},
					},
					approvals: openClawPluginApprovalSession,
					channels: {
						discord: {
							enabled: true,
							guilds: {
								'allowed-guild': {},
							},
						},
					},
					bindings: [
						{
							match: {
								channel: 'discord',
								guildId: 'missing-guild',
							},
							agentId: 'shravan',
						},
					],
					plugins: {
						allow: ['gondolin', 'memory-core', 'discord', 'mcp-portal'],
						entries: {
							discord: { enabled: true },
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
							'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions/gondolin',
								'/home/openclaw/.openclaw/extensions/mcp-portal',
							],
						},
						slots: { memory: 'memory-core' },
					},
					tools: openClawSandboxPluginTools,
				},
			},
		]);

		expect(checks.every((check) => check.ok)).toBe(true);
		expect(checks.map((check) => check.name)).not.toContain('openclaw-dm-scope-shravan');
		expect(checks.map((check) => check.name)).not.toContain(
			'openclaw-discord-guild-bindings-shravan',
		);
		expect(checks.map((check) => check.name)).not.toContain(
			'openclaw-stale-discord-plugin-shravan',
		);
	});

	it('flags stale agent-vm OpenClaw integration defaults from pre-managed deployments', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							sandbox: {
								backend: 'gondolin',
								scope: 'agent',
							},
							workspace: '/zone',
						},
					},
					plugins: {
						allow: ['gondolin', 'memory-core', 'discord'],
						entries: {
							discord: { enabled: true },
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
						},
					},
					channels: {
						discord: {
							enabled: true,
							guilds: {
								'allowed-guild': {},
							},
						},
					},
					bindings: [
						{
							match: {
								channel: 'discord',
								guildId: 'missing-guild',
							},
							agentId: 'shravan',
						},
					],
				},
			},
		]);

		expect(
			checks.find(
				(check) =>
					check.name ===
					'openclaw-tool-vm-agents-defaults-sandbox-workspaceAccess-shravan-defaults',
			),
		).toMatchObject({
			ok: false,
			hint: 'Set agents.defaults.sandbox.workspaceAccess to "rw" for OpenClaw Tool VM mediation.',
		});
		expect(checks.find((check) => check.name === 'openclaw-memory-slot-shravan')).toMatchObject({
			ok: false,
			hint: 'Set plugins.slots.memory to "memory-core" when memory-core is enabled.',
		});
		expect(
			checks.find((check) => check.name === 'openclaw-plugin-load-paths-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Add plugins.load.paths for /home/openclaw/.openclaw/extensions/gondolin.',
		});
		expect(
			checks.find((check) => check.name === 'openclaw-tool-vm-workspace-shravan-defaults'),
		).toMatchObject({
			ok: false,
			hint: 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.',
		});
	});

	it('flags portal endpoints that do not deny sibling agent portal tools', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [
							{ id: 'sun', tools: { deny: [] } },
							{ id: 'shravan', tools: { deny: [] } },
						],
					},
					mcp: {
						servers: {
							mcp_portal_sun: {},
							mcp_portal_shravan: {},
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-mcp-portal-agent-endpoints-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Set zones[].mcpPortal.configDir so agent-vm registers native MCP Portal tools through the OpenClaw plugin.',
		});
	});

	it('flags sandboxed MCP Portal deployments without sandbox plugin tool access', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
					approvals: openClawPluginApprovalSession,
					plugins: {
						allow: ['gondolin', 'memory-core', 'mcp-portal'],
						entries: {
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
							'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions/gondolin',
								'/home/openclaw/.openclaw/extensions/mcp-portal',
							],
						},
						slots: { memory: 'memory-core' },
					},
					tools: {
						alsoAllow: ['group:plugins'],
						sandbox: {
							tools: {
								alsoAllow: ['web_search', 'web_fetch', 'message'],
							},
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-sandbox-plugin-tools-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Sandboxed agents need tools.sandbox.tools.alsoAllow to include "group:plugins" (or mcp-portal / mcp_portal_*). Top-level tools.alsoAllow does not expose optional plugin tools inside sandbox.mode=all.',
		});
	});

	it('does not treat empty sandbox alsoAllow as plugin tool access', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
					approvals: openClawPluginApprovalSession,
					plugins: {
						allow: ['gondolin', 'memory-core', 'mcp-portal'],
						entries: {
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
							'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
						},
					},
					tools: {
						sandbox: {
							tools: {
								alsoAllow: [],
							},
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-sandbox-plugin-tools-shravan'),
		).toMatchObject({ ok: false });
	});

	it('flags portal endpoints without the generated access header', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						list: [
							{
								id: 'sun',
							},
							{
								id: 'shravan',
							},
						],
					},
					mcp: {
						servers: {
							mcp_portal_sun: {
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18790/agents/sun/mcp',
							},
							mcp_portal_shravan: {
								headers: { 'x-agent-vm-mcp-portal-secret': 'shravan-secret' },
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18790/agents/shravan/mcp',
							},
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-mcp-portal-agent-endpoints-shravan'),
		).toMatchObject({ ok: false });
	});

	it('flags portal endpoints with a non-generated loopback URL', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						list: [
							{
								id: 'sun',
							},
							{
								id: 'shravan',
							},
						],
					},
					mcp: {
						servers: {
							mcp_portal_sun: {
								headers: { 'x-agent-vm-mcp-portal-secret': 'sun-secret' },
								transport: 'streamable-http',
								url: 'http://127.0.0.1:19999/agents/sun/mcp',
							},
							mcp_portal_shravan: {
								headers: { 'x-agent-vm-mcp-portal-secret': 'shravan-secret' },
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18790/agents/shravan/mcp',
							},
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-mcp-portal-agent-endpoints-shravan'),
		).toMatchObject({ ok: false });
	});

	it('flags orphaned portal servers that are not bound to a configured agent', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						list: [
							{
								id: 'sun',
							},
							{
								id: 'shravan',
							},
						],
					},
					mcp: {
						servers: {
							mcp_portal_sun: {
								headers: { 'x-agent-vm-mcp-portal-secret': 'sun-secret' },
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18790/agents/sun/mcp',
							},
							mcp_portal_shravan: {
								headers: { 'x-agent-vm-mcp-portal-secret': 'shravan-secret' },
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18790/agents/shravan/mcp',
							},
							mcp_portal_old_agent: {
								headers: { 'x-agent-vm-mcp-portal-secret': 'old-secret' },
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18790/agents/old-agent/mcp',
							},
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-mcp-portal-agent-endpoints-shravan'),
		).toMatchObject({ ok: false });
	});

	it('flags portal endpoint checks when no agents are configured', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						list: [],
					},
					mcp: {
						servers: {},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-mcp-portal-agent-endpoints-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Set zones[].mcpPortal.configDir so agent-vm registers native MCP Portal tools through the OpenClaw plugin.',
		});
	});

	it('accepts native MCP Portal when runtime materialization is configured', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun'],
				runtimeMaterializesPortalEndpoints: true,
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
					approvals: openClawPluginApprovalSession,
					plugins: {
						allow: ['gondolin', 'memory-core', 'mcp-portal'],
						entries: {
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
							'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions/gondolin',
								'/home/openclaw/.openclaw/extensions/mcp-portal',
							],
						},
						slots: { memory: 'memory-core' },
					},
					tools: openClawSandboxPluginTools,
				},
			},
		]);

		expect(checks.every((check) => check.ok)).toBe(true);
	});

	it('flags stale MCP Portal policy in OpenClaw plugin config', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
					mcp: {
						servers: {
							mcp_portal_sun: {
								headers: { 'x-agent-vm-mcp-portal-secret': 'sun-secret' },
								transport: 'streamable-http',
								url: 'http://127.0.0.1:18790/agents/sun/mcp',
							},
						},
					},
					plugins: {
						allow: ['mcp-portal'],
						entries: {
							'mcp-portal': {
								enabled: true,
								hooks: { allowPromptInjection: true },
								config: {
									configDir: '/home/openclaw/.openclaw/config',
									promptContext: { enabled: true },
								},
							},
						},
						load: {
							paths: ['/home/openclaw/.openclaw/extensions/mcp-portal'],
						},
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-mcp-portal-config-source-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Move MCP Portal namespace/tool policy to mcp-portal.config.jsonc; OpenClaw plugin config may only carry configDir.',
		});
	});

	it('flags configured OpenClaw agents without matching auth profile material', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun'],
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }, { id: 'shravan' }],
					},
					plugins: {
						allow: ['memory-core'],
						entries: { 'memory-core': { enabled: true } },
						load: {
							paths: ['/home/openclaw/.openclaw/extensions/gondolin'],
						},
						slots: { memory: 'memory-core' },
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-agent-auth-profile-shravan-sun'),
		).toMatchObject({
			ok: true,
			hint: 'OpenClaw auth profile configured for agent sun',
		});
		expect(
			checks.find((check) => check.name === 'openclaw-agent-auth-profile-shravan-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Run agent-vm auth codex-harness --zone shravan --agent shravan or configure gateway.authProfilesByAgent.shravan.',
		});
	});

	it('prefers OpenClaw auth profile hints when both auth profile and Codex harness auth exist', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun'],
				configuredCodexHarnessAuthAgentIds: ['sun'],
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-agent-auth-profile-shravan-sun'),
		).toMatchObject({
			ok: true,
			hint: 'OpenClaw auth profile configured for agent sun',
		});
	});

	it('reports Codex harness auth.json read errors separately from missing auth material', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				codexHarnessAuthReadErrors: [
					{
						agentId: 'sun',
						message: 'EACCES: permission denied',
						path: '/state/agents/sun/agent/codex-home/auth.json',
					},
				],
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun' }],
					},
				},
			},
		]);

		expect(
			checks.find((check) => check.name === 'openclaw-codex-harness-auth-readable-shravan-sun'),
		).toMatchObject({
			ok: false,
			hint: 'Cannot read Codex harness auth.json at /state/agents/sun/agent/codex-home/auth.json: EACCES: permission denied',
		});
		expect(
			checks.find((check) => check.name === 'openclaw-agent-auth-profile-shravan-sun'),
		).toMatchObject({
			ok: false,
			hint: 'Run agent-vm auth codex-harness --zone shravan --agent sun or configure gateway.authProfilesByAgent.sun.',
		});
	});

	it('skips per-agent auth profile checks for non-Codex agents', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'anthropic/claude-opus-4-6' },
							sandbox: openClawToolVmSandbox,
							workspace: '/zone/agents/default',
						},
						list: [
							{ id: 'claude-agent' },
							{ id: 'codex-agent', model: { primary: 'openai-codex/gpt-5.5' } },
						],
					},
					plugins: {
						load: {
							paths: ['/home/openclaw/.openclaw/extensions/gondolin'],
						},
					},
				},
			},
		]);

		expect(checks.map((check) => check.name)).not.toContain(
			'openclaw-agent-auth-profile-shravan-claude-agent',
		);
		expect(checks.map((check) => check.name)).toContain(
			'openclaw-agent-auth-profile-shravan-codex-agent',
		);
	});

	it('does not emit auth profile checks when agents.list is missing or empty', () => {
		for (const list of [undefined, []] as const) {
			const checks = buildOpenClawDeploymentDoctorChecks([
				{
					zoneId: 'shravan',
					config: {
						agents: {
							defaults: {
								model: { primary: 'openai-codex/gpt-5.5' },
								sandbox: openClawToolVmSandbox,
								workspace: '/zone/agents/default',
							},
							...(list === undefined ? {} : { list }),
						},
					},
				},
			]);

			expect(checks.map((check) => check.name)).not.toContain(
				'openclaw-agent-auth-profile-shravan',
			);
			expect(
				checks.filter((check) => check.name.startsWith('openclaw-agent-auth-profile-')),
			).toEqual([]);
		}
	});
});

describe('collectOpenClawDeploymentDoctorChecks', () => {
	it('loads OpenClaw configs from the resolved zone gateway config path', async () => {
		const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-doctor-'));
		const openClawConfigPath = path.join(temporaryDirectory, 'config', 'openclaw.json');
		await mkdir(path.dirname(openClawConfigPath), { recursive: true });
		await writeFile(
			openClawConfigPath,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: openClawToolVmSandbox,
						workspace: '/zone/agents/default',
					},
					list: [{ id: 'sun' }],
				},
				session: {
					dmScope: 'per-channel-peer',
				},
				approvals: openClawPluginApprovalSession,
				plugins: {
					allow: ['memory-core', 'mcp-portal'],
					entries: {
						'memory-core': { enabled: true },
						'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
					},
					load: {
						paths: [
							'/home/openclaw/.openclaw/extensions/gondolin',
							'/home/openclaw/.openclaw/extensions/mcp-portal',
						],
					},
					slots: { memory: 'memory-core' },
				},
				tools: openClawSandboxPluginTools,
			}),
			'utf8',
		);

		try {
			const checks = await collectOpenClawDeploymentDoctorChecks(
				createSystemConfig(openClawConfigPath, {}, path.dirname(openClawConfigPath)),
			);

			expect(checks.every((check) => check.ok)).toBe(true);
			expect(
				checks.find((check) => check.name === 'openclaw-deployment-config-readable-shravan'),
			).toMatchObject({
				ok: true,
				hint: openClawConfigPath,
			});
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it('accepts Codex harness auth.json as per-agent Codex auth material', async () => {
		const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-doctor-'));
		const configDirectory = path.join(temporaryDirectory, 'config');
		const openClawConfigPath = path.join(configDirectory, 'openclaw.json');
		const stateDir = path.join(temporaryDirectory, 'state', 'shravan');
		await mkdir(configDirectory, { recursive: true });
		await mkdir(path.join(stateDir, 'agents', 'sun', 'agent', 'codex-home'), {
			recursive: true,
		});
		await writeFile(
			path.join(stateDir, 'agents', 'sun', 'agent', 'codex-home', 'auth.json'),
			'{}',
			'utf8',
		);
		await writeFile(
			openClawConfigPath,
			JSON.stringify({
				agents: {
					defaults: {
						model: { primary: 'openai-codex/gpt-5.5' },
						sandbox: openClawToolVmSandbox,
						workspace: '/zone/agents/default',
					},
					list: [{ id: 'sun' }, { id: 'shravan' }],
				},
			}),
			'utf8',
		);

		try {
			const checks = await collectOpenClawDeploymentDoctorChecks(
				createSystemConfig(openClawConfigPath, {}, undefined, stateDir),
			);

			expect(
				checks.find((check) => check.name === 'openclaw-agent-auth-profile-shravan-sun'),
			).toMatchObject({
				ok: true,
				hint: 'Codex harness auth.json present for agent sun',
			});
			expect(
				checks.find((check) => check.name === 'openclaw-agent-auth-profile-shravan-shravan'),
			).toMatchObject({
				ok: false,
				hint: 'Run agent-vm auth codex-harness --zone shravan --agent shravan or configure gateway.authProfilesByAgent.shravan.',
			});
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it('accepts native MCP Portal when mcp-portal config is present', async () => {
		const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-doctor-'));
		const configDirectory = path.join(temporaryDirectory, 'config');
		const openClawConfigPath = path.join(configDirectory, 'openclaw.json');
		await mkdir(configDirectory, { recursive: true });
		await writeFile(
			path.join(configDirectory, 'mcp-portal.config.jsonc'),
			JSON.stringify({
				agents: { sun: { profile: 'default' } },
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			}),
			'utf8',
		);
		await writeFile(
			openClawConfigPath,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: openClawToolVmSandbox,
						workspace: '/zone/agents/default',
					},
					list: [{ id: 'sun' }],
				},
				approvals: openClawPluginApprovalSession,
				plugins: {
					allow: ['memory-core', 'mcp-portal'],
					entries: {
						'memory-core': { enabled: true },
						'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
					},
					load: {
						paths: [
							'/home/openclaw/.openclaw/extensions/gondolin',
							'/home/openclaw/.openclaw/extensions/mcp-portal',
						],
					},
					slots: { memory: 'memory-core' },
				},
				tools: openClawSandboxPluginTools,
			}),
			'utf8',
		);

		try {
			const checks = await collectOpenClawDeploymentDoctorChecks(
				createSystemConfig(openClawConfigPath, {}, configDirectory),
			);

			expect(checks.every((check) => check.ok)).toBe(true);
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it('accepts runtime-materialized MCP Portal endpoints when system mcp config is present', async () => {
		const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-doctor-'));
		const configDirectory = path.join(temporaryDirectory, 'config');
		const openClawConfigPath = path.join(configDirectory, 'openclaw.json');
		await mkdir(configDirectory, { recursive: true });
		await writeFile(
			path.join(configDirectory, 'mcp-portal.config.jsonc'),
			JSON.stringify({
				agents: { sun: { profile: 'default' } },
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			}),
			'utf8',
		);
		await writeFile(
			openClawConfigPath,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: openClawToolVmSandbox,
						workspace: '/zone/agents/default',
					},
					list: [{ id: 'sun' }],
				},
				approvals: openClawPluginApprovalSession,
				plugins: {
					allow: ['memory-core', 'mcp-portal'],
					entries: {
						'memory-core': { enabled: true },
						'mcp-portal': { enabled: true, hooks: { allowPromptInjection: true } },
					},
					load: {
						paths: [
							'/home/openclaw/.openclaw/extensions/gondolin',
							'/home/openclaw/.openclaw/extensions/mcp-portal',
						],
					},
					slots: { memory: 'memory-core' },
				},
				tools: openClawSandboxPluginTools,
			}),
			'utf8',
		);

		try {
			const checks = await collectOpenClawDeploymentDoctorChecks(
				createSystemConfig(openClawConfigPath, {}, configDirectory),
			);

			expect(
				checks.find((check) => check.name === 'openclaw-mcp-portal-agent-endpoints-shravan'),
			).toMatchObject({
				ok: true,
				hint: 'agent-vm registers native MCP Portal tools through the OpenClaw plugin; do not configure mcp.servers portal endpoints.',
			});
			expect(checks.every((check) => check.ok)).toBe(true);
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it('reports unreadable OpenClaw config paths directly', async () => {
		const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-doctor-'));
		const openClawConfigPath = path.join(temporaryDirectory, 'config', 'missing-openclaw.json');

		try {
			const checks = await collectOpenClawDeploymentDoctorChecks(
				createSystemConfig(openClawConfigPath),
			);

			expect(
				checks.find((check) => check.name === 'openclaw-deployment-config-readable-shravan'),
			).toMatchObject({
				ok: false,
				hint: expect.stringContaining(`Cannot read ${openClawConfigPath}:`),
			});
			expect(checks).toHaveLength(1);
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});
});
