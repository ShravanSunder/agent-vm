import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
	buildOpenClawDeploymentDoctorChecks,
	collectOpenClawDeploymentDoctorChecks,
} from './openclaw-deployment-doctor.js';

function createSystemConfig(
	openClawConfigPath: string,
	authProfilesByAgent: Record<string, { readonly ref: string; readonly source: '1password' }> = {},
	mcpConfigDir?: string,
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
					allowedHosts: ['api.openai.com'],
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
					gateway: {
						type: 'openclaw',
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: openClawConfigPath,
						port: 18791,
						stateDir: './state/shravan',
						zoneFilesDir: './zone-files/shravan',
						authProfilesByAgent,
					},
					id: 'shravan',
					...(mcpConfigDir === undefined ? {} : { mcp: { configDir: mcpConfigDir } }),
					secrets: {},
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
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: {
								workspaceAccess: 'rw',
							},
							workspace: '/zone/agents/default',
						},
						list: [
							{
								id: 'sun',
								tools: {
									deny: [
										'mcp_portal_shravan__mcp_portal_list',
										'mcp_portal_shravan__mcp_portal_search',
										'mcp_portal_shravan__mcp_portal_describe',
										'mcp_portal_shravan__mcp_portal_call',
									],
								},
							},
							{
								id: 'shravan',
								tools: {
									deny: [
										'mcp_portal_sun__mcp_portal_list',
										'mcp_portal_sun__mcp_portal_search',
										'mcp_portal_sun__mcp_portal_describe',
										'mcp_portal_sun__mcp_portal_call',
									],
								},
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
						},
					},
					session: {
						dmScope: 'per-channel-peer',
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
				},
			},
		]);

		expect(checks.every((check) => check.ok)).toBe(true);
	});

	it('ignores OpenClaw-owned Discord session and binding semantics', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun'],
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: {
								workspaceAccess: 'rw',
							},
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
					session: {
						dmScope: 'per-peer',
						identityLinks: {
							shravan: ['discord:709857988919164981'],
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
			checks.find((check) => check.name === 'openclaw-workspace-access-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Set agents.defaults.sandbox.workspaceAccess to "rw" so agents can write their workspace.',
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
			checks.find((check) => check.name === 'openclaw-shared-zone-workspace-shravan'),
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
							sandbox: { workspaceAccess: 'rw' },
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
			hint: 'Generate one mcp.servers portal endpoint per OpenClaw agent and deny sibling portal tool names on each agent.',
		});
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
								tools: {
									deny: [
										'mcp_portal_shravan__mcp_portal_list',
										'mcp_portal_shravan__mcp_portal_search',
										'mcp_portal_shravan__mcp_portal_describe',
										'mcp_portal_shravan__mcp_portal_call',
									],
								},
							},
							{
								id: 'shravan',
								tools: {
									deny: [
										'mcp_portal_sun__mcp_portal_list',
										'mcp_portal_sun__mcp_portal_search',
										'mcp_portal_sun__mcp_portal_describe',
										'mcp_portal_sun__mcp_portal_call',
									],
								},
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
								tools: {
									deny: [
										'mcp_portal_shravan__mcp_portal_list',
										'mcp_portal_shravan__mcp_portal_search',
										'mcp_portal_shravan__mcp_portal_describe',
										'mcp_portal_shravan__mcp_portal_call',
									],
								},
							},
							{
								id: 'shravan',
								tools: {
									deny: [
										'mcp_portal_sun__mcp_portal_list',
										'mcp_portal_sun__mcp_portal_search',
										'mcp_portal_sun__mcp_portal_describe',
										'mcp_portal_sun__mcp_portal_call',
									],
								},
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
								tools: {
									deny: [
										'mcp_portal_shravan__mcp_portal_list',
										'mcp_portal_shravan__mcp_portal_search',
										'mcp_portal_shravan__mcp_portal_describe',
										'mcp_portal_shravan__mcp_portal_call',
									],
								},
							},
							{
								id: 'shravan',
								tools: {
									deny: [
										'mcp_portal_sun__mcp_portal_list',
										'mcp_portal_sun__mcp_portal_search',
										'mcp_portal_sun__mcp_portal_describe',
										'mcp_portal_sun__mcp_portal_call',
									],
								},
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
			hint: 'Generate one mcp.servers portal endpoint per OpenClaw agent and deny sibling portal tool names on each agent.',
		});
	});

	it('accepts portal endpoints using configured non-default server settings', () => {
		const checks = buildOpenClawDeploymentDoctorChecks([
			{
				configuredAuthProfileAgentIds: ['sun'],
				portalServer: {
					accessHeaderName: 'x-custom-portal-secret',
					host: '127.0.0.2',
					port: 18_888,
				},
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: { workspaceAccess: 'rw' },
							workspace: '/zone/agents/default',
						},
						list: [{ id: 'sun', tools: { deny: [] } }],
					},
					mcp: {
						servers: {
							mcp_portal_sun: {
								headers: { 'x-custom-portal-secret': '${MCP_PORTAL_SERVER_SECRET}' },
								transport: 'streamable-http',
								url: 'http://127.0.0.2:18888/agents/sun/mcp',
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
							sandbox: { workspaceAccess: 'rw' },
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
			hint: 'Move MCP Portal namespace/tool policy to mcp-portal.config.jsonc; OpenClaw plugin config may only carry configDir/binPath.',
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
							sandbox: {
								workspaceAccess: 'rw',
							},
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
			hint: 'auth profile configured for agent sun',
		});
		expect(
			checks.find((check) => check.name === 'openclaw-agent-auth-profile-shravan-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Configure gateway.authProfilesByAgent.shravan or run OpenClaw auth onboarding for agent shravan.',
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
							sandbox: { workspaceAccess: 'rw' },
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
								sandbox: { workspaceAccess: 'rw' },
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
						sandbox: { workspaceAccess: 'rw' },
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
				session: {
					dmScope: 'per-channel-peer',
				},
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
			}),
			'utf8',
		);

		try {
			const checks = await collectOpenClawDeploymentDoctorChecks(
				createSystemConfig(openClawConfigPath),
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

	it('loads MCP Portal server expectations from mcp-portal.config.jsonc', async () => {
		const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-doctor-'));
		const configDirectory = path.join(temporaryDirectory, 'config');
		const openClawConfigPath = path.join(configDirectory, 'openclaw.json');
		await mkdir(configDirectory, { recursive: true });
		await writeFile(
			path.join(configDirectory, 'mcp-portal.config.jsonc'),
			JSON.stringify({
				agents: { sun: { profile: 'default' } },
				profiles: { default: { enabledNamespaces: [] } },
				schemaVersion: 1,
				server: {
					accessHeader: {
						name: 'x-custom-portal-secret',
						secret: { source: 'environment', name: 'MCP_PORTAL_SERVER_SECRET' },
					},
					host: '127.0.0.2',
					port: 18_888,
				},
			}),
			'utf8',
		);
		await writeFile(
			openClawConfigPath,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: { workspaceAccess: 'rw' },
						workspace: '/zone/agents/default',
					},
					list: [{ id: 'sun' }],
				},
				mcp: {
					servers: {
						mcp_portal_sun: {
							headers: { 'x-custom-portal-secret': 'sun-secret' },
							transport: 'streamable-http',
							url: 'http://127.0.0.2:18888/agents/sun/mcp',
						},
					},
				},
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
