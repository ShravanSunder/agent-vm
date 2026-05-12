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
					egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: 'environment',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							audience: 'gateway',
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
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: {
								backend: 'gondolin',
								mode: 'all',
								scope: 'agent',
								workspaceAccess: 'rw',
							},
							workspace: '/zone/agents/default',
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
						allow: ['gondolin', 'memory-core'],
						entries: {
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions',
								'/pnpm/global/5/node_modules/@openclaw',
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
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							model: { primary: 'openai-codex/gpt-5.5' },
							sandbox: {
								backend: 'gondolin',
								mode: 'all',
								scope: 'agent',
								workspaceAccess: 'rw',
							},
							workspace: '/zone/agents/default',
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
						allow: ['gondolin', 'memory-core', 'discord'],
						entries: {
							discord: { enabled: true },
							gondolin: { enabled: true },
							'memory-core': { enabled: true },
						},
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions',
								'/pnpm/global/5/node_modules/@openclaw',
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
			hint: 'Add plugins.load.paths for /home/openclaw/.openclaw/extensions and /pnpm/global/5/node_modules/@openclaw.',
		});
		expect(
			checks.find((check) => check.name === 'openclaw-tool-vm-workspace-shravan-defaults'),
		).toMatchObject({
			ok: false,
			hint: 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.',
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
								backend: 'gondolin',
								mode: 'all',
								scope: 'agent',
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
							paths: [
								'/home/openclaw/.openclaw/extensions',
								'/pnpm/global/5/node_modules/@openclaw',
							],
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
							sandbox: {
								backend: 'gondolin',
								mode: 'all',
								scope: 'agent',
								workspaceAccess: 'rw',
							},
							workspace: '/zone/agents/default',
						},
						list: [
							{ id: 'claude-agent' },
							{ id: 'codex-agent', model: { primary: 'openai-codex/gpt-5.5' } },
						],
					},
					plugins: {
						load: {
							paths: [
								'/home/openclaw/.openclaw/extensions',
								'/pnpm/global/5/node_modules/@openclaw',
							],
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
								sandbox: {
									backend: 'gondolin',
									mode: 'all',
									scope: 'agent',
									workspaceAccess: 'rw',
								},
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
						sandbox: {
							backend: 'gondolin',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
				},
				session: {
					dmScope: 'per-channel-peer',
				},
				plugins: {
					allow: ['memory-core'],
					entries: { 'memory-core': { enabled: true } },
					load: {
						paths: ['/home/openclaw/.openclaw/extensions', '/pnpm/global/5/node_modules/@openclaw'],
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
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});
});
