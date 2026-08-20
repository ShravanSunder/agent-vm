import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GATEWAY_RUNTIME_APPROVAL_AUDIENCE } from '@agent-vm/gateway-control-contracts';
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
		schemaVersion: 2,
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			githubToken: { source: 'environment', envVar: 'GITHUB_TOKEN' },
		},
		storageRootDir: '/var/agent-vm',
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
		schemaVersion: 2,
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm',
			githubToken: { source: 'environment', envVar: 'GITHUB_TOKEN' },
		},
		storageRootDir: path.join(rootPath, 'storage'),
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

async function addManagedToolPortalReferencesToOpenClawFixture(rootPath: string): Promise<void> {
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
		zone.toolPortal = {
			configDir: './gateways/shravan',
			surfaceEligibilityByProfile: { default: {} },
		};
	});
}

async function addApprovalAccessToOpenClawFixture(rootPath: string): Promise<void> {
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
		zone.approvalAccess = {
			approvers: [
				{
					approverId: 'primary-operator',
					kind: 'bearer',
					secret: {
						envVar: 'AGENT_VM_PRIMARY_APPROVAL_SECRET',
						source: 'environment',
					},
				},
			],
			audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
		};
	});
}

async function addRemoteWorkspaceGitToOpenClawFixture(rootPath: string): Promise<void> {
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
		const agents = zone.agents;
		if (!Array.isArray(agents)) {
			throw new Error('Expected agents array.');
		}
		const firstAgent = agents[0];
		if (typeof firstAgent !== 'object' || firstAgent === null || Array.isArray(firstAgent)) {
			throw new Error('Expected first agent object.');
		}
		const agent = firstAgent as Record<string, unknown>;
		agent.workspaceGit = {
			mode: 'remote',
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
			services: {
				framework: { logs: true, metrics: true, traces: true },
				toolPortal: { logs: true, metrics: true, traces: true },
			},
		};
	});
}

async function writeManagedToolPortalConfigFiles(
	rootPath: string,
	profileName: string,
): Promise<void> {
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'), {
		schemaVersion: 1,
		providers: {},
	});
	await writeJson(
		path.join(rootPath, 'config', 'gateways', 'shravan', 'tool-portal.config.jsonc'),
		{
			schemaVersion: 1,
			agents: { shravan: { profile: profileName } },
			mode: 'managed',
			profiles: {
				default: {
					namespaces: {},
				},
			},
		},
	);
}

async function writeManagedToolPortalConfigWithControllerExecution(
	rootPath: string,
	actionTools: readonly ('controller_host_probe' | 'workspace_git_push')[] = ['workspace_git_push'],
): Promise<void> {
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'), {
		schemaVersion: 1,
		providers: {},
	});
	await writeJson(
		path.join(rootPath, 'config', 'gateways', 'shravan', 'tool-portal.config.jsonc'),
		{
			schemaVersion: 1,
			agents: { shravan: { profile: 'default' } },
			mode: 'managed',
			profiles: {
				default: {
					namespaces: {
						controller_execution: {
							backend: {
								kind: 'controller_execution',
								operations: {
									controller_host_probe: { kind: 'registered_action' },
									workspace_git_push: { kind: 'registered_action' },
									push_branch: { kind: 'registered_action' },
									protected_uds: { kind: 'registered_action' },
								},
							},
							calls: {
								requiresApproval: { allow: [] },
								withoutApproval: { allow: actionTools },
							},
							tools: { allow: actionTools },
						},
					},
				},
			},
		},
	);
}

async function writeManagedToolPortalConfigWithProvider(
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
	await writeJson(
		path.join(rootPath, 'config', 'gateways', 'shravan', 'tool-portal.config.jsonc'),
		{
			agents: { shravan: { profile: 'default' } },
			mode: 'managed',
			profiles: {
				default: {
					namespaces: {
						tavily: {
							backend: { kind: 'mcp_provider' },
							calls,
							tools: { allow: '*' },
						},
					},
				},
			},
			schemaVersion: 1,
		},
	);
}

async function writeManagedToolPortalConfigWithAgents(
	rootPath: string,
	agents: Record<string, { readonly profile: string }>,
): Promise<void> {
	await writeJson(path.join(rootPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'), {
		schemaVersion: 1,
		providers: {},
	});
	await writeJson(
		path.join(rootPath, 'config', 'gateways', 'shravan', 'tool-portal.config.jsonc'),
		{
			schemaVersion: 1,
			agents,
			mode: 'managed',
			profiles: {
				default: {
					namespaces: {},
				},
			},
		},
	);
}

async function createOpenClawSystemConfigWithManagedToolPortal(): Promise<
	Awaited<ReturnType<typeof loadSystemConfig>>
> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
	const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
	await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
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
	await writeManagedToolPortalConfigFiles(temporaryDirectoryPath, 'default');
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

async function createSystemConfigWithLiveManagedToolPortalFiles(props: {
	readonly mcpConfig: unknown;
	readonly remoteWorkspaceGitEnabled?: boolean;
	readonly toolPortalConfig: unknown;
}): Promise<Awaited<ReturnType<typeof loadSystemConfig>>> {
	const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
	const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
	await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
	if (props.remoteWorkspaceGitEnabled === true) {
		await addRemoteWorkspaceGitToOpenClawFixture(temporaryDirectoryPath);
	}
	await writeJson(
		path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'mcp.config.jsonc'),
		props.mcpConfig,
	);
	await writeJson(
		path.join(temporaryDirectoryPath, 'config', 'gateways', 'shravan', 'tool-portal.config.jsonc'),
		props.toolPortalConfig,
	);
	return await loadSystemConfig(systemConfigPath);
}

async function configureLoadedFixtureAsHermes(
	systemConfig: Awaited<ReturnType<typeof loadSystemConfig>>,
): Promise<void> {
	const zone = systemConfig.zones.find((configuredZone) => configuredZone.id === 'shravan');
	if (zone === undefined || zone.gateway.type !== 'openclaw') {
		throw new Error('Expected OpenClaw fixture zone');
	}
	const hermesConfigurationDirectoryPath = path.join(
		path.dirname(zone.gateway.config),
		'hermes-managed',
	);
	const hermesConfigurationPath = path.join(hermesConfigurationDirectoryPath, 'config.yaml');
	await mkdir(hermesConfigurationDirectoryPath, { recursive: true });
	const zoneIndex = systemConfig.zones.indexOf(zone);
	systemConfig.zones[zoneIndex] = {
		...zone,
		gateway: {
			config: hermesConfigurationPath,
			cpus: zone.gateway.cpus,
			imageProfile: 'hermes',
			memory: zone.gateway.memory,
			port: zone.gateway.port,
			profilesByAgent: { shravan: 'researcher' },
			profileSecretProjectionsByAgent: {
				shravan: {
					API_SERVER_KEY: 'API_SERVER_KEY_SHRAVAN',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
				},
			},
			stateDir: zone.gateway.stateDir,
			type: 'hermes',
			zoneFilesDir: zone.gateway.zoneFilesDir,
			zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
		},
		secrets: {
			...zone.secrets,
			API_SERVER_KEY_SHRAVAN: {
				audience: 'gateway',
				envVar: 'API_SERVER_KEY_SHRAVAN',
				injection: 'env',
				source: 'environment',
			},
		},
	};
	await writeFile(
		hermesConfigurationPath,
		'plugins:\n  enabled: [agent-vm-tool-portal]\n  disabled: []\n',
		'utf8',
	);
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
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
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
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
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

	it('applies managed Tool VM, Tool Portal, and secret-access validation to Hermes', async () => {
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
		await configureLoadedFixtureAsHermes(systemConfig);
		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected Hermes fixture zone');
		}
		zone.secrets.HERMES_TOOL_TOKEN = {
			agentAccess: ['shravan'],
			audience: 'tool-vm',
			envVar: 'HERMES_TOOL_TOKEN',
			hosts: ['api.example.test'],
			injection: 'http-mediation',
			source: 'environment',
		};

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.checks).toContainEqual({
			hint: zone.gateway.config,
			name: 'hermes-config-shravan',
			ok: true,
		});
		expect(result.checks).toContainEqual({
			hint: 'default',
			name: 'zone-default-tool-vm-profile-shravan',
			ok: true,
		});
		expect(result.checks).toContainEqual(
			expect.objectContaining({ name: 'tool-portal-config-shravan', ok: true }),
		);
		expect(result.checks).toContainEqual({
			hint: 'tool-vm: shravan',
			name: 'zone-agent-secret-access-shravan-HERMES_TOOL_TOKEN',
			ok: true,
		});
		expect(result.checks.map((check) => check.name)).not.toContain('openclaw-config-shravan');
	});

	it('fails Hermes validation when the managed plugin is not centrally enabled', async () => {
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
		await configureLoadedFixtureAsHermes(systemConfig);
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes fixture zone');
		}
		await writeFile(zone.gateway.config, 'plugins:\n  enabled: []\n  disabled: []\n', 'utf8');

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(result.checks).toContainEqual({
			hint: expect.stringMatching(/must enable 'agent-vm-tool-portal'/u),
			name: 'hermes-config-shravan',
			ok: false,
		});
	});

	it.each([
		['an unexpected sibling', 'unexpected.txt'],
		['a managed .env sibling', '.env'],
	])('rejects Hermes managed configuration directory with %s', async (_caseName, siblingName) => {
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
		await configureLoadedFixtureAsHermes(systemConfig);
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes fixture zone');
		}
		await writeFile(
			path.join(path.dirname(zone.gateway.config), siblingName),
			'opaque-marker',
			'utf8',
		);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});
		const hermesConfigCheck = result.checks.find((check) => check.name === 'hermes-config-shravan');

		expect(hermesConfigCheck).toMatchObject({ ok: false });
		expect(hermesConfigCheck?.hint).toContain('must contain only config.yaml');
		expect(hermesConfigCheck?.hint).not.toContain('opaque-marker');
	});

	it('reports an unreadable Hermes managed configuration without exposing the configured path', async () => {
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
		await configureLoadedFixtureAsHermes(systemConfig);
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes fixture zone');
		}
		await rm(zone.gateway.config);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});
		const hermesConfigCheck = result.checks.find((check) => check.name === 'hermes-config-shravan');

		expect(hermesConfigCheck).toMatchObject({ ok: false });
		expect(hermesConfigCheck?.hint).toContain('path is unreadable');
		expect(hermesConfigCheck?.hint).not.toContain(zone.gateway.config);
	});

	it('does not expose malformed Hermes config contents in validation output', async () => {
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
		await configureLoadedFixtureAsHermes(systemConfig);
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes fixture zone');
		}
		const secretCanary = 'hermes-config-secret-canary';
		await writeFile(zone.gateway.config, `plugins: [${secretCanary}`, 'utf8');

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		const hermesConfigCheck = result.checks.find((check) => check.name === 'hermes-config-shravan');
		expect(hermesConfigCheck).toMatchObject({ ok: false });
		expect(hermesConfigCheck?.hint).not.toContain(secretCanary);
	});

	it('keeps degraded MCP namespaces visible without failing the whole validation', async () => {
		const systemConfig = await createOpenClawSystemConfigWithManagedToolPortal();
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
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
			mcpConfig: {
				schemaVersion: 1,
				providers: {},
			},
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
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
			hint: "Tool Portal agent 'shravan' profile 'default' references MCP namespace 'deepwiki', but no provider with that namespace exists in mcp.config.jsonc.",
			name: 'mcp-live-profile-namespace-shravan-shravan-deepwiki',
			ok: false,
		});
	});

	it('does not require controller host action to be declared as an upstream MCP provider', async () => {
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
			remoteWorkspaceGitEnabled: true,
			mcpConfig: {
				schemaVersion: 1,
				providers: {},
			},
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							controller_execution: {
								backend: {
									kind: 'controller_execution',
									operations: {
										controller_host_probe: { kind: 'registered_action' },
										workspace_git_push: { kind: 'registered_action' },
										push_branch: { kind: 'registered_action' },
										protected_uds: { kind: 'registered_action' },
									},
								},
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['workspace_git_push'] },
								},
								tools: { allow: ['workspace_git_push'] },
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

	it('runs the same managed MCP provider validation for Hermes profiles', async () => {
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
			mcpConfig: createSingleToolMcpConfig({
				namespace: 'deepwiki',
				toolName: 'ask_question',
			}),
			toolPortalConfig: {
				agents: { shravan: { profile: 'default' } },
				mode: 'managed',
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['ask_question'] },
								},
								tools: { allow: ['ask_question'] },
							},
						},
					},
				},
				schemaVersion: 1,
			},
		});
		await configureLoadedFixtureAsHermes(systemConfig);

		await expect(
			runLiveMcpPortalValidation({
				createRuntime: () => createFakeMcpRuntime({ deepwiki: ['ask_question'] }),
				secretResolver: createTestSecretResolver(),
				systemConfig,
			}),
		).resolves.toContainEqual({
			hint: 'deepwiki discovered 1 tools.',
			name: 'mcp-live-shravan-deepwiki',
			ok: true,
			status: 'available',
		});
	});

	it('does not require controller host probe to be declared as an upstream MCP provider', async () => {
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
			mcpConfig: {
				schemaVersion: 1,
				providers: {},
			},
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							controller_execution: {
								backend: {
									kind: 'controller_execution',
									operations: {
										controller_host_probe: { kind: 'registered_action' },
										workspace_git_push: { kind: 'registered_action' },
										push_branch: { kind: 'registered_action' },
										protected_uds: { kind: 'registered_action' },
									},
								},
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
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
			mcpConfig: createSingleToolMcpConfig({
				namespace: 'deepwiki',
				toolName: 'ask_question',
			}),
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
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
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
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
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['ask_question'] },
								},
								tools: { allow: ['ask_question'] },
							},
							tavily: {
								backend: { kind: 'mcp_provider' },
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
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
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
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
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
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
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
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
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
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
			mcpConfig: createSingleToolMcpConfig({
				namespace: 'deepwiki',
				toolName: 'ask_question',
			}),
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'missing' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
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
				hint: expect.stringMatching(/references missing profile .*missing/u),
				name: 'mcp-live-shravan-config',
				ok: false,
			}),
		]);
	});

	it('reports live MCP secret resolution failures as validation checks', async () => {
		const systemConfig = await createSystemConfigWithLiveManagedToolPortalFiles({
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
			toolPortalConfig: {
				mode: 'managed',
				schemaVersion: 1,
				agents: { shravan: { profile: 'default' } },
				profiles: {
					default: {
						namespaces: {
							deepwiki: {
								backend: { kind: 'mcp_provider' },
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
				schemaVersion: 2,
				host: { controllerPort: 18800, projectNamespace: 'agent-vm' },
				storageRootDir: '/var/agent-vm',
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

	it('rejects a canonical controllerStateDir alias to gateway state before validation', async () => {
		// Arrange
		const temporaryDirectoryPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-validate-controller-state-alias-'),
		);
		try {
			const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
			const gatewayStateDirectoryPath = path.join(
				temporaryDirectoryPath,
				'storage',
				'shravan',
				'state',
			);
			const controllerStateDirectoryPath = path.join(
				temporaryDirectoryPath,
				'storage',
				'controller-state',
			);
			await mkdir(controllerStateDirectoryPath, { recursive: true });
			await mkdir(path.dirname(gatewayStateDirectoryPath), { recursive: true });
			await symlink(controllerStateDirectoryPath, gatewayStateDirectoryPath);

			// Act / Assert
			await expect(loadSystemConfig(systemConfigPath)).rejects.toThrow(
				/controllerStateDir must not overlap stateDir/u,
			);
		} finally {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
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

	it('reports controllerRuntimeDir overlap with non-runtime storage paths', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeContainerProjectFixture(temporaryDirectoryPath);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			systemConfig: {
				...systemConfig,
				cacheDir: path.join(temporaryDirectoryPath, 'cache'),
				controllerRuntimeDir: path.join(temporaryDirectoryPath, 'cache', 'runtime'),
			},
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'runtime-path-isolation-cacheDir'),
		).toMatchObject({
			ok: false,
			hint: 'controllerRuntimeDir must not overlap cacheDir',
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
			hint: 'OpenClaw CLI not found. Install OpenClaw in this catalog for local schema validation: pnpm add -D openclaw@2026.7.1-2.',
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports sandboxed MCP Portal plugins hidden by sandbox tool policy', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigFiles(temporaryDirectoryPath, 'default');
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
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
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
		expect(
			result.checks.find((check) => check.name === 'tool-portal-config-shravan'),
		).toMatchObject({
			ok: false,
			hint: expect.stringContaining('Missing'),
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('runs MCP Portal materialization validation before gateway boot', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigWithProvider(temporaryDirectoryPath, {
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

	it('allows workspace Git push Tool Portal materialization for a remote-mode agent', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await addRemoteWorkspaceGitToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigWithControllerExecution(temporaryDirectoryPath);
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
			/cannot allow workspace_git_push/u,
		);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('allows controller host probe Tool Portal materialization without remote workspace Git', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigWithControllerExecution(temporaryDirectoryPath, [
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
		expect(result.checks.map((check) => check.hint).join('\n')).not.toMatch(/workspace_git_push/u);

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('rejects workspace Git push Tool Portal materialization without remote workspace Git', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigWithControllerExecution(temporaryDirectoryPath, [
			'workspace_git_push',
		]);
		const systemConfig = await loadSystemConfig(systemConfigPath);

		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'tool-portal-effective-config-shravan'),
		).toMatchObject({
			hint: expect.stringContaining(
				'managed agent "shravan" assigned profile "default" cannot allow workspace_git_push',
			),
			ok: false,
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('rejects a shared workspace Git push profile assigned to a local-mode agent', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await addRemoteWorkspaceGitToOpenClawFixture(temporaryDirectoryPath);
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
			const agents = zone.agents;
			if (!Array.isArray(agents)) {
				throw new Error('Expected agents array.');
			}
			agents.push({ id: 'local-agent', workspaceGit: { mode: 'local' } });
		});
		await writeManagedToolPortalConfigWithControllerExecution(temporaryDirectoryPath);
		await updateJsonFile(
			path.join(
				temporaryDirectoryPath,
				'config',
				'gateways',
				'shravan',
				'tool-portal.config.jsonc',
			),
			(toolPortalConfig) => {
				const agents = toolPortalConfig.agents;
				if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
					throw new Error('Expected Tool Portal agents object.');
				}
				(agents as Record<string, unknown>)['local-agent'] = { profile: 'default' };
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
			hint: expect.stringContaining(
				'managed agent "local-agent" assigned profile "default" cannot allow workspace_git_push',
			),
			ok: false,
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('rejects managed Tool Portal approval-required calls without approval access', async () => {
		// Arrange
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		try {
			const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
			await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
			await writeManagedToolPortalConfigWithProvider(
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
					requiresApproval: { allow: ['tavily_search'] },
					withoutApproval: { allow: [] },
				},
			);
			const systemConfig = await loadSystemConfig(systemConfigPath);

			// Act
			const result = await runConfigValidation({
				runCommand: successfulOpenClawValidationCommand,
				systemConfig,
			});

			// Assert
			expect(
				result.checks.find((check) => check.name === 'tool-portal-approval-access-shravan'),
			).toEqual({
				hint: "Managed Tool Portal calls requiring approval for zone 'shravan' require zones[].approvalAccess with at least one authenticated approver.",
				name: 'tool-portal-approval-access-shravan',
				ok: false,
			});
			expect(result.ok).toBe(false);
		} finally {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('accepts managed Tool Portal approval-required calls with protected approval access', async () => {
		// Arrange
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		try {
			const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
			await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
			await addApprovalAccessToOpenClawFixture(temporaryDirectoryPath);
			await writeManagedToolPortalConfigWithProvider(
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
					requiresApproval: { allow: ['tavily_search'] },
					withoutApproval: { allow: [] },
				},
			);
			const systemConfig = await loadSystemConfig(systemConfigPath);

			// Act
			const result = await runConfigValidation({
				runCommand: successfulOpenClawValidationCommand,
				systemConfig,
			});

			// Assert
			expect(
				result.checks.find((check) => check.name === 'tool-portal-approval-access-shravan'),
			).toMatchObject({
				ok: true,
			});
			expect(
				result.checks.find((check) => check.name === 'tool-portal-effective-config-shravan'),
			).toMatchObject({
				ok: true,
			});
		} finally {
			await rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('reports agent bindings that reference missing Tool Portal profiles', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigFiles(temporaryDirectoryPath, 'builder');
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'tool-portal-config-shravan'),
		).toMatchObject({
			ok: false,
			hint: expect.stringMatching(/references missing profile .*builder/u),
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports system agents missing from Tool Portal agent bindings', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigWithAgents(temporaryDirectoryPath, {});
		const systemConfig = await loadSystemConfig(systemConfigPath);
		const result = await runConfigValidation({
			runCommand: successfulOpenClawValidationCommand,
			systemConfig,
		});

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'tool-portal-agent-shravan-shravan'),
		).toMatchObject({
			ok: false,
			hint: "Agent 'shravan' is missing from tool-portal.config.jsonc agents.",
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('accepts matching same-zone multi-agent Tool Portal bindings', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
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
		await writeManagedToolPortalConfigWithAgents(temporaryDirectoryPath, {
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
			result.checks.find((check) => check.name === 'tool-portal-profile-shravan-shravan'),
		).toMatchObject({
			ok: true,
		});
		expect(
			result.checks.find((check) => check.name === 'tool-portal-profile-shravan-sun'),
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

	it('reports Tool Portal agents not declared in system config', async () => {
		const temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-validate-'));
		const systemConfigPath = await writeOpenClawProjectFixture(temporaryDirectoryPath);
		await addManagedToolPortalReferencesToOpenClawFixture(temporaryDirectoryPath);
		await writeManagedToolPortalConfigWithAgents(temporaryDirectoryPath, {
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
			result.checks.find((check) => check.name === 'tool-portal-agent-declared-shravan-ghost'),
		).toMatchObject({
			ok: false,
			hint: "tool-portal.config.jsonc declares agent 'ghost' that is not in zones[].agents.",
		});

		await rm(temporaryDirectoryPath, { force: true, recursive: true });
	});
});
