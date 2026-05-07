import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
	buildOpenClawDeploymentDoctorChecks,
	collectOpenClawDeploymentDoctorChecks,
} from './openclaw-deployment-doctor.js';

function createSystemConfig(openClawConfigPath: string): LoadedSystemConfig {
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
					},
					id: 'shravan',
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
				zoneId: 'shravan',
				config: {
					agents: {
						defaults: {
							sandbox: {
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
							sandbox: {
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
			hint: 'Add plugins.load.paths for /home/openclaw/.openclaw/extensions and /pnpm/global/5/node_modules/@openclaw.',
		});
		expect(
			checks.find((check) => check.name === 'openclaw-shared-zone-workspace-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Use /zone/agents/default or per-agent workspaces; keep /zone for shared zone files.',
		});
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
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	});
});
