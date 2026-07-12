import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { UpstreamMcpClientRuntime } from '@agent-vm/mcp-portal';
import type { SecretResolver } from '@agent-vm/secret-management';
import { describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, loadSystemConfig } from '../config/system-config.js';
import { resolveProjectCheckoutPath, runConfigValidation } from './config-validation.js';
import { runLiveMcpPortalValidation } from './mcp-portal-live-validation.js';

type TestCommandRunner = NonNullable<Parameters<typeof runConfigValidation>[0]['runCommand']>;

const successfulOpenClawValidationCommand: TestCommandRunner = async () => ({
	exitCode: 0,
	stderr: '',
	stdout: '{"ok":true}\\n',
});

const missingOpenClawCommand: TestCommandRunner = async () => {
	throw Object.assign(new Error('spawn openclaw ENOENT'), { code: 'ENOENT' });
};

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

async function updateJsonFile(
	filePath: string,
	update: (value: Record<string, unknown>) => void,
): Promise<void> {
	const parsedValue: unknown = JSON.parse(await readFile(filePath, 'utf8'));
	if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) {
		throw new Error(`Expected ${filePath} to contain a JSON object.`);
	}
	const objectValue = parsedValue as Record<string, unknown>;
	update(objectValue);
	await writeJson(filePath, objectValue);
}

function minimalWorkerConfig(): unknown {
	return {
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: { path: './prompts/plan-agent.md' },
				reviewerInstructions: null,
			},
			work: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
			},
			wrapup: { instructions: null },
		},
	};
}

async function writeContainerProjectFixture(rootPath: string): Promise<string> {
	await writeJson(path.join(rootPath, 'config', 'system.json'), {
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			githubToken: { source: 'environment', envVar: 'GITHUB_TOKEN' },
		},
		cacheDir: '/var/agent-vm/cache',
		imageProfiles: {
			gateways: {
				worker: {
					type: 'worker',
					buildConfig: '/etc/agent-vm/vm-images/gateways/worker/build-config.json',
					dockerfile: '/etc/agent-vm/vm-images/gateways/worker/Dockerfile',
				},
			},
		},
		zones: [
			{
				id: 'coding-agent',
				gateway: {
					type: 'worker',
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: '/etc/agent-vm/gateways/coding-agent/worker.json',
					imageProfile: 'worker',
					stateDir: '/var/agent-vm/state',
				},
				secrets: {},
				egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
			},
		],
		tcpPool: { basePort: 19000, size: 5 },
	});
	await writeJson(
		path.join(rootPath, 'config', 'gateways', 'coding-agent', 'worker.json'),
		minimalWorkerConfig(),
	);
	await mkdir(path.join(rootPath, 'config', 'gateways', 'coding-agent', 'prompts'), {
		recursive: true,
	});
	await writeFile(
		path.join(rootPath, 'config', 'gateways', 'coding-agent', 'prompts', 'plan-agent.md'),
		'Plan carefully.\n',
		'utf8',
	);
	await writeJson(path.join(rootPath, 'vm-images', 'gateways', 'worker', 'build-config.json'), {
		arch: 'x86_64',
		distro: 'alpine',
	});
	await writeFile(
		path.join(rootPath, 'vm-images', 'gateways', 'worker', 'Dockerfile'),
		'FROM node:24-slim\n',
		'utf8',
	);
	await mkdir(path.join(rootPath, 'vm-host-system'), { recursive: true });
	await Promise.all(
		['Dockerfile', 'start.sh', 'agent-vm-controller.service'].map(async (fileName) => {
			await writeFile(path.join(rootPath, 'vm-host-system', fileName), '', 'utf8');
		}),
	);
	return path.join(rootPath, 'config', 'system.json');
}

async function writeOpenClawProjectFixture(rootPath: string): Promise<string> {
	await writeJson(path.join(rootPath, 'config', 'system.json'), {
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			githubToken: { source: 'environment', envVar: 'GITHUB_TOKEN' },
		},
		cacheDir: path.join(rootPath, 'cache'),
		imageProfiles: {
			gateways: {
				openclaw: {
					type: 'openclaw',
					buildConfig: '../vm-images/gateways/openclaw/build-config.json',
					dockerfile: '../vm-images/gateways/openclaw/Dockerfile',
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: '../vm-images/tool-vms/default/build-config.json',
					dockerfile: '../vm-images/tool-vms/default/Dockerfile',
				},
			},
		},
		zones: [
			{
				id: 'shravan',
				agents: [{ id: 'shravan' }],
				gateway: {
					type: 'openclaw',
					controlAuth: {
						mode: 'token',
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
					memory: '2G',
					cpus: 2,
					port: 18791,
					config: './gateways/shravan/openclaw.json',
					imageProfile: 'openclaw',
					stateDir: path.join(rootPath, 'state', 'shravan'),
					zoneFilesDir: path.join(rootPath, 'zone-files', 'shravan'),
					authProfilesByAgent: {
						shravan: { source: 'environment', envVar: 'SHRAVAN_AUTH_PROFILES' },
					},
				},
				secrets: {
					OPENCLAW_GATEWAY_TOKEN: {
						source: 'environment',
						envVar: 'OPENCLAW_GATEWAY_TOKEN',
						injection: 'env',
						audience: 'gateway',
					},
				},
				egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
				defaultToolVmProfile: 'default',
				agentToolVmProfiles: {},
				agentSandboxSeeds: {
					shravan: [
						{
							source: { source: 'environment', envVar: 'SHRAVAN_GCLOUD_CONFIG' },
							target: '.config/gcloud/configurations/config_default',
						},
					],
				},
			},
		],
		toolVmProfiles: {
			default: {
				memory: '1G',
				cpus: 1,
				imageProfile: 'default',
			},
		},
		tcpPool: { basePort: 19000, size: 5 },
	});
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'openclaw.json'), {
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
			list: [{ id: 'shravan' }],
		},
		gateway: {
			auth: { mode: 'token' },
			bind: 'loopback',
			controlUi: {
				allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
			},
			mode: 'local',
			port: 18789,
		},
		channels: {},
	});
	await writeJson(path.join(rootPath, 'vm-images', 'gateways', 'openclaw', 'build-config.json'), {
		arch: 'aarch64',
		distro: 'alpine',
	});
	await writeFile(
		path.join(rootPath, 'vm-images', 'gateways', 'openclaw', 'Dockerfile'),
		'FROM node:24-slim\n',
		'utf8',
	);
	await writeJson(path.join(rootPath, 'vm-images', 'tool-vms', 'default', 'build-config.json'), {
		arch: 'aarch64',
		distro: 'alpine',
	});
	await writeFile(
		path.join(rootPath, 'vm-images', 'tool-vms', 'default', 'Dockerfile'),
		'FROM node:24-slim\n',
		'utf8',
	);
	return path.join(rootPath, 'config', 'system.json');
}

async function addMcpPortalReferencesToOpenClawFixture(rootPath: string): Promise<void> {
	const systemConfigPath = path.join(rootPath, 'config', 'system.json');
	await updateJsonFile(systemConfigPath, (systemConfig) => {
		const zones = systemConfig.zones;
		if (!Array.isArray(zones)) {
			throw new Error('Expected zones array.');
		}
		const firstZone = zones[0];
		if (typeof firstZone !== 'object' || firstZone === null || Array.isArray(firstZone)) {
			throw new Error('Expected first zone object.');
		}
		const zone = firstZone as Record<string, unknown>;
		zone.agents = [{ id: 'shravan' }];
		zone.toolPortal = { configDir: './gateways/shravan' };
	});
}

async function addZoneGitToOpenClawFixture(rootPath: string): Promise<void> {
	const systemConfigPath = path.join(rootPath, 'config', 'system.json');
	await updateJsonFile(systemConfigPath, (systemConfig) => {
		const zones = systemConfig.zones;
		if (!Array.isArray(zones)) {
			throw new Error('Expected zones array.');
		}
		const firstZone = zones[0];
		if (typeof firstZone !== 'object' || firstZone === null || Array.isArray(firstZone)) {
			throw new Error('Expected first zone object.');
		}
		const zone = firstZone as Record<string, unknown>;
		const gateway = zone.gateway;
		if (typeof gateway !== 'object' || gateway === null || Array.isArray(gateway)) {
			throw new Error('Expected gateway object.');
		}
		const gatewayRecord = gateway as Record<string, unknown>;
		gatewayRecord.zoneGit = {
			remote: {
				repoUrl: 'ShravanSunder/sunfam-zone-files',
				branch: 'agent/zone-files',
			},
		};
	});
}

async function addObservabilityToOpenClawFixture(rootPath: string): Promise<void> {
	const systemConfigPath = path.join(rootPath, 'config', 'system.json');
	await updateJsonFile(systemConfigPath, (systemConfig) => {
		const hostValue = systemConfig.host;
		if (typeof hostValue !== 'object' || hostValue === null || Array.isArray(hostValue)) {
			throw new Error('Expected host object.');
		}
		const hostRecord = hostValue as Record<string, unknown>;
		hostRecord.observability = {
			enabled: true,
			stack: {
				mode: 'managed',
				scrubbing: { responsibility: 'agent-vm-managed-collector' },
			},
			mode: 'collector',
			dataDir: path.join(rootPath, 'observability-data'),
			runner: 'docker-compose',
			prepareOnBuild: true,
			retention: {
				metrics: { period: '30d' },
				logs: { period: '14d' },
				traces: { period: '7d' },
			},
		};

		const zones = systemConfig.zones;
		if (!Array.isArray(zones)) {
			throw new Error('Expected zones array.');
		}
		const firstZone = zones[0];
		if (typeof firstZone !== 'object' || firstZone === null || Array.isArray(firstZone)) {
			throw new Error('Expected first zone object.');
		}
		const zoneRecord = firstZone as Record<string, unknown>;
		zoneRecord.observability = {
			enabled: true,
			openclaw: {
				serviceName: 'agent-vm-openclaw-shravan',
				logs: true,
				metrics: true,
				traces: true,
			},
		};
	});
}

async function writeMcpPortalConfigFiles(rootPath: string, profileName: string): Promise<void> {
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'), {
		schemaVersion: 1,
		providers: {},
	});
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp-portal.config.jsonc'), {
		schemaVersion: 1,
		agents: { shravan: { profile: profileName } },
		profiles: {
			default: {
				namespaces: {},
			},
		},
	});
}

async function writeMcpPortalConfigWithControllerHostAction(
	rootPath: string,
	actionTools: readonly ('controller_host_probe' | 'zone_git_push')[] = ['zone_git_push'],
): Promise<void> {
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'), {
		schemaVersion: 1,
		providers: {},
	});
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp-portal.config.jsonc'), {
		schemaVersion: 1,
		agents: { shravan: { profile: 'default' } },
		profiles: {
			default: {
				namespaces: {
					controller_host_action: {
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: actionTools },
						},
						tools: { allow: actionTools },
					},
				},
			},
		},
	});
}

async function writeMcpPortalConfigWithProvider(
	rootPath: string,
	provider: unknown,
	calls: {
		readonly requiresApproval: { readonly allow: '*' | readonly string[] };
		readonly withoutApproval: { readonly allow: '*' | readonly string[] };
	} = {
		requiresApproval: { allow: [] },
		withoutApproval: { allow: '*' },
	},
): Promise<void> {
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'), {
		providers: { tavily: provider },
		schemaVersion: 1,
	});
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp-portal.config.jsonc'), {
		agents: { shravan: { profile: 'default' } },
		profiles: {
			default: {
				namespaces: {
					tavily: {
						calls,
						tools: { allow: '*' },
					},
				},
			},
		},
		schemaVersion: 1,
	});
}

async function writeMcpPortalConfigWithAgents(
	rootPath: string,
	agents: Record<string, { readonly profile: string }>,
): Promise<void> {
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'), {
		schemaVersion: 1,
		providers: {},
	});
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp-portal.config.jsonc'), {
		schemaVersion: 1,
		agents,
		profiles: {
			default: {
				namespaces: {},
			},
		},
	});
}

async function createOpenClawSystemConfigWithMcpPortal(): Promise<
	Awaited<ReturnType<typeof loadSystemConfig>>
> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
	const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
	await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
	await updateJsonFile(
		path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
		(openClawConfig) => {
			openClawConfig.tools = {
				...(typeof openClawConfig.tools === 'object' && openClawConfig.tools !== null
					? openClawConfig.tools
					: {}),
				sandbox: {
					tools: {
						alsoAllow: ['group:plugins'],
					},
				},
			};
		},
	);
	await writeMcpPortalConfigFiles(temporaryDirectoryPath, 'default');
	return await loadSystemConfig(systemConfigPath);
}

function createSingleToolMcpConfig(props: {
	readonly namespace: string;
	readonly toolName: string;
}): unknown {
	void props.toolName;
	return {
		schemaVersion: 1,
		providers: {
			[props.namespace]: {
				kind: 'mcp',
				namespace: props.namespace,
				secretPolicies: {},
				transport: {
					kind: 'streamable-http',
					url: `https://${props.namespace}.example.test/mcp`,
				},
			},
		},
	};
}

async function createSystemConfigWithLiveMcpFiles(props: {
	readonly enableZoneGit?: boolean;
	readonly mcpConfig: unknown;
	readonly portalConfig: unknown;
}): Promise<Awaited<ReturnType<typeof loadSystemConfig>>> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
	const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
	await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
	if (props.enableZoneGit === true) {
		await addZoneGitToOpenClawFixture(temporaryDirectoryPath);
	}
	await writeJson(
		path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'),
		props.mcpConfig,
	);
	await writeJson(
		path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'mcp-portal.config.jsonc'),
		props.portalConfig,
	);
	return await loadSystemConfig(systemConfigPath);
}

function createFakeMcpRuntime(
	toolsByNamespace: Readonly<Record<string, readonly string[]>>,
): UpstreamMcpClientRuntime {
	return {
		callTool: vi.fn(),
		closeAgentScope: vi.fn(),
		closeSession: vi.fn(),
		listTools: vi.fn(async (call: { readonly namespace: string }) =>
			(toolsByNamespace[call.namespace] ?? []).map((name) => ({
				inputSchema: { type: 'object' as const },
				name,
			})),
		),
	};
}

function createTestSecretResolver(): SecretResolver {
	return {
		resolve: vi.fn(async () => 'secret-value'),
		resolveAll: vi.fn(async () => ({})),
	};
}

describe('runConfigValidation', () => {
	it('skips live MCP discovery unless --mcp-live is requested', async () => {
		const systemConfig = await createOpenClawSystemConfigWithMcpPortal();
		const runLiveMcpPortalValidationMock = vi.fn(async () => [
			{ hint: 'deepwiki discovered 2 tools', name: 'mcp-live-deepwiki', ok: true },
		]);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			runLiveMcpPortalValidation: runLiveMcpPortalValidationMock,
			systemConfig,
		});

		expect(runLiveMcpPortalValidationMock).not.toHaveBeenCalled();
		expect(result.checks.map((check) => check.name)).not.toContain('mcp-live-deepwiki');
	});

	it('includes live MCP discovery checks when requested', async () => {
		const systemConfig = await createOpenClawSystemConfigWithMcpPortal();
		const secretResolver = createTestSecretResolver();
		const runLiveMcpPortalValidationMock = vi.fn(async () => [
			{
				hint: 'perplexity connect failed: stdio MCP command failed before tool discovery; verify command, package bin name, gateway PATH, and arg count.',
				name: 'mcp-live-beta-perplexity',
				ok: false,
			},
		]);

		const result = await runConfigValidation({
			mcpLive: true,
			runCommand: successfulOpenClawValidationCommand,
			runLiveMcpPortalValidation: runLiveMcpPortalValidationMock,
			secretResolver,
			systemConfig,
		});

		expect(runLiveMcpPortalValidationMock).toHaveBeenCalledWith({
			secretResolver,
			systemConfig,
		});
		expect(result.ok).toBe(false);
		expect(result.checks).toContainEqual({
			hint: 'perplexity connect failed: stdio MCP command failed before tool discovery; verify command, package bin name, gateway PATH, and arg count.',
			name: 'mcp-live-beta-perplexity',
			ok: false,
		});
	});

	it('keeps degraded MCP namespaces visible without failing the whole validation', async () => {
		const systemConfig = await createOpenClawSystemConfigWithMcpPortal();
		const secretResolver = createTestSecretResolver();
		const runLiveMcpPortalValidationMock = vi.fn(async () => [
			{
				hint: 'deepwiki disabled/unavailable: list_tools timed out',
				name: 'mcp-live-beta-deepwiki',
				ok: false,
				status: 'unavailable' as const,
			},
			{
				hint: 'tavily discovered 5 tools.',
				name: 'mcp-live-beta-tavily',
				ok: true,
				status: 'available' as const,
			},
		]);

		const result = await runConfigValidation({
			mcpLive: true,
			runCommand: successfulOpenClawValidationCommand,
			runLiveMcpPortalValidation: runLiveMcpPortalValidationMock,
			secretResolver,
			systemConfig,
		});

		expect(result.ok).toBe(true);
		expect(result.checks).toContainEqual({
			hint: 'deepwiki disabled/unavailable: list_tools timed out',
			name: 'mcp-live-beta-deepwiki',
			ok: false,
			status: 'unavailable',
		});
		expect(result.checks).toContainEqual({
			hint: 'tavily discovered 5 tools.',
			name: 'mcp-live-beta-tavily',
			ok: true,
			status: 'available',
		});
	});

	it('validates the OpenClaw default OpenAI runtime shape', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await updateJsonFile(
			path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
			(openClawConfig) => {
				openClawConfig.agents = {
					defaults: {
						model: { primary: 'openai/gpt-5.5' },
						models: {
							'openai/gpt-5.5': { agentRuntime: { id: 'openclaw' } },
						},
						sandbox: {
							backend: 'gondolin',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
				};
			},
		);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.checks).toContainEqual({
			name: 'openclaw-config-shravan',
			ok: true,
			hint: path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
		});
		expect(result.ok).toBe(true);
		await rm(temporaryDirectoryPath, { recursive: true, force: true });
	});

	it('accepts OpenClaw zone observability through mediated OTLP HTTP during control-plane cutover', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addObservabilityToOpenClawFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.checks).toContainEqual({
			name: 'openclaw-config-shravan',
			ok: true,
			hint: path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
		});
		expect(result.ok).toBe(true);
		await rm(temporaryDirectoryPath, { recursive: true, force: true });
	});

	it('reports Tool VM mediated secret agent access', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await updateJsonFile(systemConfigPath, (systemConfig) => {
			const zones = systemConfig.zones;
			if (!Array.isArray(zones)) {
				throw new Error('Expected zones array.');
			}
			const zone = zones[0];
			if (typeof zone !== 'object' || zone === null || Array.isArray(zone)) {
				throw new Error('Expected first zone object.');
			}
			const zoneRecord = zone as Record<string, unknown>;
			zoneRecord.agents = [{ id: 'shravan' }];
			zoneRecord.egressHosts = [
				{ host: 'api.openai.com', audience: 'gateway' },
				{ host: 'api.github.com', audience: 'both' },
				{ host: 'api.linear.app', audience: 'tool-vm' },
			];
			zoneRecord.secrets = {
				...(zoneRecord.secrets as Record<string, unknown>),
				GITHUB_TOKEN: {
					source: 'environment',
					envVar: 'GITHUB_TOKEN',
					injection: 'http-mediation',
					audience: 'both',
					hosts: ['api.github.com'],
					agentAccess: ['shravan'],
				},
				LINEAR_API_KEY: {
					source: 'environment',
					envVar: 'LINEAR_API_KEY',
					injection: 'http-mediation',
					audience: 'tool-vm',
					hosts: ['api.linear.app'],
					agentAccess: 'all',
				},
			};
		});
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.checks).toContainEqual({
			name: 'zone-agent-secret-access-shravan-GITHUB_TOKEN',
			ok: true,
			hint: 'tool-vm: shravan; gateway: zone-wide',
		});
		expect(result.checks).toContainEqual({
			name: 'zone-agent-secret-access-shravan-LINEAR_API_KEY',
			ok: true,
			hint: 'tool-vm: all declared agents',
		});
	});

	it('rejects Tool VM mediated secret agent access before validation checks run when agents are undeclared', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await updateJsonFile(systemConfigPath, (systemConfig) => {
			const zones = systemConfig.zones;
			if (!Array.isArray(zones)) {
				throw new Error('Expected zones array.');
			}
			const zone = zones[0];
			if (typeof zone !== 'object' || zone === null || Array.isArray(zone)) {
				throw new Error('Expected first zone object.');
			}
			const zoneRecord = zone as Record<string, unknown>;
			delete zoneRecord.agents;
			zoneRecord.egressHosts = [
				{ host: 'api.openai.com', audience: 'gateway' },
				{ host: 'api.github.com', audience: 'tool-vm' },
			];
			zoneRecord.secrets = {
				...(zoneRecord.secrets as Record<string, unknown>),
				GITHUB_TOKEN: {
					source: 'environment',
					envVar: 'GITHUB_TOKEN',
					injection: 'http-mediation',
					audience: 'tool-vm',
					hosts: ['api.github.com'],
					agentAccess: 'all',
				},
			};
		});

		await expect(loadSystemConfig(systemConfigPath)).rejects.toThrow(/zones\[\]\.agents is empty/u);
	});

	it('fails when a portal profile references a namespace without an MCP provider', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: {
				schemaVersion: 1,
				providers: {},
			},
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['ask_question'] },
								},
								tools: { allow: ['ask_question'] },
							},
						},
					},
				},
			},
		});

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toContainEqual({
			hint: "Agent 'shravan' profile 'default' references MCP namespace 'deepwiki', but no provider with that namespace exists in mcp.config.jsonc.",
			name: 'mcp-live-profile-namespace-shravan-shravan-deepwiki',
			ok: false,
		});
	});

	it('does not require controller host action to be declared as an upstream MCP provider', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			enableZoneGit: true,
			mcpConfig: {
				schemaVersion: 1,
				providers: {},
			},
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							controller_host_action: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['zone_git_push'] },
								},
								tools: { allow: ['zone_git_push'] },
							},
						},
					},
				},
			},
		});

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({}),
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toEqual([]);
	});

	it('does not require controller host probe to be declared as an upstream MCP provider', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: {
				schemaVersion: 1,
				providers: {},
			},
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							controller_host_action: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['controller_host_probe'] },
								},
								tools: { allow: ['controller_host_probe'] },
							},
						},
					},
				},
			},
		});

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({}),
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toEqual([]);
	});

	it('checks hidden and approval tool names, not only enabled tools', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: createSingleToolMcpConfig({
				namespace: 'deepwiki',
				toolName: 'ask_question',
			}),
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['missing_approval_tool'] },
								},
								tools: {
									allow: '*',
									deny: ['missing_hidden_tool'],
								},
							},
						},
					},
				},
			},
		});

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toContainEqual({
			hint: "Agent 'shravan' profile 'default' references missing deepwiki tools: missing_approval_tool, missing_hidden_tool. Actual tools: ask_question.",
			name: 'mcp-live-profile-tools-shravan-shravan-deepwiki',
			ok: false,
		});
	});

	it('fails referenced MCP namespaces that are unavailable without suppressing successful namespaces', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: {
				schemaVersion: 1,
				providers: {
					deepwiki: {
						kind: 'mcp',
						namespace: 'deepwiki',
						secretPolicies: {},
						transport: {
							kind: 'streamable-http',
							url: 'https://deepwiki.example.test/mcp',
						},
					},
					tavily: {
						kind: 'mcp',
						namespace: 'tavily',
						secretPolicies: {},
						transport: {
							kind: 'streamable-http',
							url: 'https://tavily.example.test/mcp',
						},
					},
				},
			},
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['ask_question'] },
								},
								tools: { allow: ['ask_question'] },
							},
							tavily: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['tavily_search'] },
								},
								tools: { allow: ['tavily_search'] },
							},
						},
					},
				},
			},
		});
		const listTools = vi.fn(async (call: { readonly namespace: string }) => {
			if (call.namespace === 'deepwiki') {
				throw new Error('MCP listTools timed out after 12000ms');
			}
			return [{ inputSchema: { type: 'object' as const }, name: 'tavily_search' }];
		});
		const runtime = {
			callTool: vi.fn(),
			closeAgentScope: vi.fn(),
			closeSession: vi.fn(),
			listTools,
		} satisfies UpstreamMcpClientRuntime;

		const checks = await runLiveMcpPortalValidation({
			createRuntime: () => runtime,
			secretResolver: createTestSecretResolver(),
			systemConfig,
		});

		expect(checks).toContainEqual({
			hint: expect.stringContaining('disabled/unavailable'),
			name: 'mcp-live-shravan-deepwiki',
			ok: false,
			status: 'unavailable',
		});
		expect(checks).toContainEqual({
			hint: 'tavily discovered 1 tools.',
			name: 'mcp-live-shravan-tavily',
			ok: true,
			status: 'available',
		});
		expect(checks).not.toContainEqual(
			expect.objectContaining({
				name: 'mcp-live-profile-tools-shravan-shravan-deepwiki',
			}),
		);
		expect(listTools).toHaveBeenCalledWith({
			agentScopeId: 'validate:shravan',
			namespace: 'deepwiki',
		});
		expect(listTools).toHaveBeenCalledWith({
			agentScopeId: 'validate:shravan',
			namespace: 'tavily',
		});
	});

	it('fails live MCP validation when discovered tool schemas cannot build validators', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: {
				schemaVersion: 1,
				providers: {
					deepwiki: {
						kind: 'mcp',
						namespace: 'deepwiki',
						secretPolicies: {},
						transport: {
							kind: 'streamable-http',
							url: 'https://deepwiki.example.test/mcp',
						},
					},
				},
			},
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['ask_question'] },
								},
								tools: { allow: ['ask_question'] },
							},
						},
					},
				},
			},
		});
		const runtime = {
			callTool: vi.fn(),
			closeAgentScope: vi.fn(),
			closeSession: vi.fn(),
			listTools: vi.fn(async () => [
				{
					inputSchema: {
						properties: { repo: { type: 'string' } },
						required: ['repo'],
						type: 'object' as const,
						unevaluatedProperties: false,
					},
					name: 'ask_question',
				},
			]),
		} satisfies UpstreamMcpClientRuntime;

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => runtime,
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toContainEqual({
			hint: expect.stringContaining(
				"deepwiki.ask_question input schema uses unsupported JSON Schema feature 'unevaluatedProperties'",
			),
			name: 'mcp-live-tool-schema-shravan-deepwiki-ask_question',
			ok: false,
		});
	});

	it('reports live MCP config load failures as validation checks', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: {
				providers: {
					deepwiki: {
						kind: 'mcp',
						namespace: 'deepwiki',
						transport: { kind: 'streamable-http', url: 'not-a-url' },
					},
				},
				schemaVersion: 1,
			},
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								calls: {
									requiresApproval: { allow: '*' },
									withoutApproval: { allow: [] },
								},
								tools: { allow: '*' },
							},
						},
					},
				},
			},
		});

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				name: 'mcp-live-shravan-config',
				ok: false,
			}),
		]);
	});

	it('reports live MCP profile resolution failures as validation checks', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: createSingleToolMcpConfig({
				namespace: 'deepwiki',
				toolName: 'ask_question',
			}),
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'missing' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								calls: {
									requiresApproval: { allow: '*' },
									withoutApproval: { allow: [] },
								},
								tools: { allow: '*' },
							},
						},
					},
				},
			},
		});

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				hint: expect.stringContaining("unknown MCP profile 'missing'"),
				name: 'mcp-live-shravan-config',
				ok: false,
			}),
		]);
	});

	it('reports live MCP secret resolution failures as validation checks', async () => {
		const systemConfig = await createSystemConfigWithLiveMcpFiles({
			mcpConfig: {
				providers: {
					deepwiki: {
						kind: 'mcp',
						namespace: 'deepwiki',
						transport: {
							headers: {
								Authorization: { name: 'MISSING_TOKEN', source: 'environment' },
							},
							kind: 'streamable-http',
							url: 'https://deepwiki.example.test/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
			portalConfig: {
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								calls: {
									requiresApproval: { allow: '*' },
									withoutApproval: { allow: [] },
								},
								tools: { allow: '*' },
							},
						},
					},
				},
			},
		});

		const secretResolver = {
			resolve: vi.fn(async () => {
				throw new Error('secret missing');
			}),
			resolveAll: vi.fn(async () => ({})),
		} satisfies SecretResolver;

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
				secretResolver,
				systemConfig,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				hint: expect.stringContaining('secret missing'),
				name: 'mcp-live-shravan-config',
				ok: false,
			}),
		]);
	});

	it('leaves runtime container paths unchanged inside /etc/agent-vm', () => {
		const systemConfig = createLoadedSystemConfig(
			{
				host: { controllerPort: 18800, projectNamespace: 'agent-vm' },
				imageProfiles: {
					gateways: {
						worker: {
							type: 'worker',
							buildConfig: '/etc/agent-vm/vm-images/gateways/worker/build-config.json',
						},
					},
				},
				zones: [
					{
						id: 'coding-agent',
						gateway: {
							type: 'worker',
							memory: '2G',
							cpus: 2,
							port: 18791,
							config: '/etc/agent-vm/gateways/coding-agent/worker.json',
							imageProfile: 'worker',
							stateDir: '/var/agent-vm/state',
						},
						secrets: {},
						egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
					},
				],
				tcpPool: { basePort: 19000, size: 5 },
			},
			{ systemConfigPath: '/etc/agent-vm/system.json' },
		);

		const resolvedPath = resolveProjectCheckoutPath(
			systemConfig,
			'/etc/agent-vm/gateways/coding-agent/worker.json',
		);

		expect(resolvedPath).toBe('/etc/agent-vm/gateways/coding-agent/worker.json');
	});

	it('validates a container project from its checkout paths', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeContainerProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({ systemConfig });

		expect(result.ok).toBe(true);
		expect(result.checks.every((check) => check.ok)).toBe(true);
		expect(result.checks.find((check) => check.name === 'worker-config-coding-agent')?.hint).toBe(
			path.join(temporaryDirectoryPath, 'config', 'gateways', 'coding-agent', 'worker.json'),
		);
		expect(result.checks.find((check) => check.name === 'gateway-worker-build-config')?.ok).toBe(
			true,
		);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('rejects managed image overlays with deployment pnpm overrides during validation', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await writeJson(
			path.join(temporaryDirectoryPath, 'vm-images', 'gateways', 'openclaw', 'overlay.jsonc'),
			{
				pnpmOverrides: { undici: '8.5.0' },
				schemaVersion: 1,
			},
		);
		await updateJsonFile(systemConfigPath, (systemConfig) => {
			const imageProfiles = systemConfig.imageProfiles;
			if (
				typeof imageProfiles !== 'object' ||
				imageProfiles === null ||
				Array.isArray(imageProfiles)
			) {
				throw new Error('Expected imageProfiles object.');
			}
			const gateways = (imageProfiles as Record<string, unknown>).gateways;
			if (typeof gateways !== 'object' || gateways === null || Array.isArray(gateways)) {
				throw new Error('Expected gateways object.');
			}
			const openClawProfile = (gateways as Record<string, unknown>).openclaw;
			if (
				typeof openClawProfile !== 'object' ||
				openClawProfile === null ||
				Array.isArray(openClawProfile)
			) {
				throw new Error('Expected openclaw profile object.');
			}
			(openClawProfile as Record<string, unknown>).source = {
				base: 'openclaw-gateway',
				kind: 'managedBase',
				overlay: '../vm-images/gateways/openclaw/overlay.jsonc',
			};
		});
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(result.checks).toContainEqual(
			expect.objectContaining({
				hint: expect.stringContaining('move pnpmOverrides to packageOverrides.pnpm'),
				name: 'gateway-openclaw-overlay',
				ok: false,
			}),
		);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('accepts managed image overlays with packageOverrides pnpm during validation', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await writeJson(
			path.join(temporaryDirectoryPath, 'vm-images', 'gateways', 'openclaw', 'overlay.jsonc'),
			{
				packageOverrides: { pnpm: { undici: '8.5.0' } },
				schemaVersion: 1,
			},
		);
		await updateJsonFile(systemConfigPath, (systemConfig) => {
			const imageProfiles = systemConfig.imageProfiles;
			if (
				typeof imageProfiles !== 'object' ||
				imageProfiles === null ||
				Array.isArray(imageProfiles)
			) {
				throw new Error('Expected imageProfiles object.');
			}
			const gateways = (imageProfiles as Record<string, unknown>).gateways;
			if (typeof gateways !== 'object' || gateways === null || Array.isArray(gateways)) {
				throw new Error('Expected gateways object.');
			}
			const openClawProfile = (gateways as Record<string, unknown>).openclaw;
			if (
				typeof openClawProfile !== 'object' ||
				openClawProfile === null ||
				Array.isArray(openClawProfile)
			) {
				throw new Error('Expected openclaw profile object.');
			}
			(openClawProfile as Record<string, unknown>).source = {
				base: 'openclaw-gateway',
				kind: 'managedBase',
				overlay: '../vm-images/gateways/openclaw/overlay.jsonc',
			};
		});
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(true);
		expect(result.checks).toContainEqual(
			expect.objectContaining({
				name: 'gateway-openclaw-overlay',
				ok: true,
			}),
		);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing vm-host-system for container checkout paths', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeContainerProjectFixture(temporaryDirectoryPath);
		await rm(path.join(temporaryDirectoryPath, 'vm-host-system'), {
			force: true,
			recursive: true,
		});
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({ systemConfig });

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'vm-host-system')).toMatchObject({
			ok: false,
			hint: expect.stringContaining('vm-host-system'),
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports runtimeDir overlap with non-runtime storage paths', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeContainerProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			systemConfig: {
				...systemConfig,
				cacheDir: path.join(temporaryDirectoryPath, 'cache'),
				runtimeDir: path.join(temporaryDirectoryPath, 'cache', 'runtime'),
			},
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'runtime-path-isolation-cacheDir'),
		).toMatchObject({
			ok: false,
			hint: 'runtimeDir must not overlap cacheDir',
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing project-local worker prompt files', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeContainerProjectFixture(temporaryDirectoryPath);
		await rm(
			path.join(
				temporaryDirectoryPath,
				'config',
				'gateways',
				'coding-agent',
				'prompts',
				'plan-agent.md',
			),
		);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({ systemConfig });

		expect(result.ok).toBe(false);
		const workerConfigCheck = result.checks.find(
			(check) => check.name === 'worker-config-coding-agent',
		);
		expect(workerConfigCheck?.ok).toBe(false);
		expect(workerConfigCheck?.hint).toMatch(/plan-agent\.md/u);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('validates OpenClaw gateway configs with the OpenClaw CLI', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const runCommandCalls: {
			readonly command: string;
			readonly arguments_: readonly string[];
			readonly cwd: string | undefined;
			readonly env: Readonly<Record<string, string>> | undefined;
		}[] = [];
		const runCommand: TestCommandRunner = async (command, arguments_, options) => {
			runCommandCalls.push({ command, arguments_, cwd: options?.cwd, env: options?.env });
			return { exitCode: 0, stderr: '', stdout: '{"ok":true}\\n' };
		};

		const result = await runConfigValidation({ runCommand, systemConfig });

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: true,
			hint: path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
		});
		expect(
			result.checks.find((check) => check.name === 'zone-default-tool-vm-profile-shravan'),
		).toMatchObject({
			ok: true,
			hint: 'default',
		});
		expect(
			result.checks.find((check) => check.name === 'zone-agent-auth-profile-shravan-shravan'),
		).toMatchObject({
			ok: true,
			hint: 'configured',
		});
		expect(
			result.checks.find((check) => check.name === 'zone-agent-sandbox-seed-shravan-shravan-0'),
		).toMatchObject({
			ok: true,
			hint: '.config/gcloud/configurations/config_default',
		});
		expect(runCommandCalls).toEqual([
			{
				command: 'openclaw',
				arguments_: ['config', 'validate', '--json'],
				cwd: temporaryDirectoryPath,
				env: {
					OPENCLAW_CONFIG_PATH: path.join(
						temporaryDirectoryPath,
						'config',
						'gateways',
						'shravan',
						'openclaw.json',
					),
				},
			},
		]);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports the managed OpenClaw install hint when the OpenClaw CLI is missing', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({ runCommand: missingOpenClawCommand, systemConfig });

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: false,
			hint: 'OpenClaw CLI not found. Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.6.8.',
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports sandboxed MCP Portal plugins hidden by sandbox tool policy', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigFiles(temporaryDirectoryPath, 'default');
		await updateJsonFile(
			path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
			(openClawConfig) => {
				openClawConfig.plugins = {
					allow: ['mcp-portal'],
					entries: {
						'mcp-portal': { enabled: true },
					},
				};
				openClawConfig.tools = {
					alsoAllow: ['group:plugins'],
					sandbox: {
						tools: {
							alsoAllow: ['web_search'],
						},
					},
				};
			},
		);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'openclaw-sandbox-plugin-tools-shravan'),
		).toMatchObject({
			ok: false,
			hint: 'Sandboxed agents need tools.sandbox.tools.alsoAllow to include "group:plugins" (or tool-portal / tool_portal_*). Top-level tools.alsoAllow does not expose optional plugin tools inside sandbox.mode=all.',
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('accepts OpenClaw configs when host-only plugin path validation is the only issue', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const validationOutput =
			'{"valid":false,"issues":[{"path":"plugins.load.paths","message":"plugin: plugin path not found: /home/openclaw/.openclaw/extensions"}]}';
		const runCommand: TestCommandRunner = async () => ({
			exitCode: 1,
			stderr: '',
			stdout: validationOutput,
		});

		const result = await runConfigValidation({ runCommand, systemConfig });

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: true,
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports OpenClaw schema validation failures before gateway boot', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const validationOutput =
			'{"ok":false,"errors":[{"path":["agents","defaults","thinkingDefault"],"message":"Unrecognized key"}]}';
		const runCommand: TestCommandRunner = async () => ({
			exitCode: 1,
			stderr: '',
			stdout: validationOutput,
		});

		const result = await runConfigValidation({ runCommand, systemConfig });

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: false,
			hint: expect.stringContaining('agents.defaults.thinkingDefault: Unrecognized key'),
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing referenced MCP config files', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(result.checks.find((check) => check.name === 'mcp-config-shravan')).toMatchObject({
			ok: false,
			hint: expect.stringContaining('Missing'),
		});
		expect(result.checks.find((check) => check.name === 'mcp-portal-config-shravan')).toMatchObject(
			{
				ok: false,
				hint: expect.stringContaining('Missing'),
			},
		);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('runs MCP Portal materialization validation before gateway boot', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigWithProvider(temporaryDirectoryPath, {
			kind: 'mcp',
			namespace: 'tavily',
			secretPolicies: {},
			transport: {
				args: ['-y', 'tavily-mcp'],
				command: 'npx',
				env: {},
				kind: 'stdio',
			},
		});
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'tool-portal-effective-config-shravan'),
		).toMatchObject({
			hint: expect.stringContaining('must declare networkAccess'),
			ok: false,
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('allows controller host action Tool Portal materialization when zoneGit is enabled', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await addZoneGitToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigWithControllerHostAction(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(
			result.checks.find((check) => check.name === 'tool-portal-effective-config-shravan'),
		).toMatchObject({
			ok: true,
		});
		expect(result.checks.map((check) => check.hint).join('\n')).not.toMatch(
			/controller_host_action while zoneGit is disabled/u,
		);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('allows controller host probe Tool Portal materialization without zoneGit', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigWithControllerHostAction(temporaryDirectoryPath, [
			'controller_host_probe',
		]);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(
			result.checks.find((check) => check.name === 'tool-portal-effective-config-shravan'),
		).toMatchObject({
			ok: true,
		});
		expect(result.checks.map((check) => check.hint).join('\n')).not.toMatch(
			/zone_git_push while zoneGit is disabled/u,
		);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('rejects zone git controller host action Tool Portal materialization without zoneGit', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigWithControllerHostAction(temporaryDirectoryPath, ['zone_git_push']);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'tool-portal-effective-config-shravan'),
		).toMatchObject({
			hint: expect.stringContaining('zone_git_push while zoneGit is disabled'),
			ok: false,
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('rejects managed OpenClaw MCP Portal calls that require approval', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigWithProvider(
			temporaryDirectoryPath,
			{
				kind: 'mcp',
				namespace: 'tavily',
				transport: {
					args: ['-y', 'tavily-mcp'],
					command: 'npx',
					kind: 'stdio',
					networkAccess: 'none',
				},
			},
			{
				requiresApproval: { allow: '*' },
				withoutApproval: { allow: [] },
			},
		);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'tool-portal-effective-config-shravan'),
		).toMatchObject({
			hint: expect.stringContaining('does not support calls.requiresApproval'),
			ok: false,
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports agent bindings that reference missing MCP Portal profiles', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigFiles(temporaryDirectoryPath, 'builder');
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'mcp-portal-profile-shravan-shravan'),
		).toMatchObject({
			ok: false,
			hint: "Agent 'shravan' references unknown MCP Portal profile 'builder'.",
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports system agents missing from MCP Portal agent bindings', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigWithAgents(temporaryDirectoryPath, {});
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'mcp-portal-agent-shravan-shravan'),
		).toMatchObject({
			ok: false,
			hint: "Agent 'shravan' is missing from mcp-portal.config.jsonc agents.",
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('accepts matching same-zone multi-agent MCP Portal bindings', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await updateJsonFile(systemConfigPath, (systemConfig) => {
			const zones = systemConfig.zones;
			if (!Array.isArray(zones)) {
				throw new Error('Expected zones array.');
			}
			const firstZone = zones[0];
			if (typeof firstZone !== 'object' || firstZone === null || Array.isArray(firstZone)) {
				throw new Error('Expected first zone object.');
			}
			const zone = firstZone as Record<string, unknown>;
			zone.agents = [{ id: 'shravan' }, { id: 'sun' }];
			zone.agentToolVmProfiles = { sun: 'default' };
		});
		await writeMcpPortalConfigWithAgents(temporaryDirectoryPath, {
			shravan: { profile: 'default' },
			sun: { profile: 'default' },
		});
		await updateJsonFile(
			path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'openclaw.json'),
			(openClawConfig) => {
				openClawConfig.tools = {
					sandbox: {
						tools: {
							alsoAllow: ['group:plugins'],
						},
					},
				};
			},
		);
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.checks.filter((check) => !check.ok)).toEqual([]);
		expect(result.ok).toBe(true);
		expect(
			result.checks.find((check) => check.name === 'mcp-portal-profile-shravan-shravan'),
		).toMatchObject({
			ok: true,
		});
		expect(
			result.checks.find((check) => check.name === 'mcp-portal-profile-shravan-sun'),
		).toMatchObject({
			ok: true,
		});
		expect(
			result.checks.find((check) => check.name === 'zone-agent-tool-vm-profile-shravan-sun'),
		).toMatchObject({
			ok: true,
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports MCP Portal agents not declared in system config', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addMcpPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeMcpPortalConfigWithAgents(temporaryDirectoryPath, {
			shravan: { profile: 'default' },
			ghost: { profile: 'default' },
		});
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'mcp-portal-agent-declared-shravan-ghost'),
		).toMatchObject({
			ok: false,
			hint: "mcp-portal.config.jsonc declares agent 'ghost' that is not in zones[].agents.",
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});
});
