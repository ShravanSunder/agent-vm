import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runControllerOperationCommand } from './controller-operation-commands.js';

const originalPath = process.env.PATH;
const ansiEscapeSequencePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

afterEach(() => {
	process.env.PATH = originalPath;
});

function createWorkerSystemConfig(
	workerConfigPath: string,
	systemConfigPath: string,
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
					worker: {
						type: 'worker',
						buildConfig: path.join(
							path.dirname(systemConfigPath),
							'vm-images',
							'gateways',
							'worker',
							'build-config.json',
						),
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: path.join(
							path.dirname(systemConfigPath),
							'vm-images',
							'tool-vms',
							'default',
							'build-config.json',
						),
					},
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			zones: [
				{
					egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						cpus: 2,
						memory: '2G',
						config: workerConfigPath,
						port: 18791,
						stateDir: './state/worker',
					},
					id: 'worker',
					secrets: {},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

function createOpenClawSystemConfig(
	toolVmBuildConfigPath: string,
	systemConfigPath: string,
	options: { readonly includeMcpPortal?: boolean } = {},
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
						buildConfig: path.join(
							path.dirname(systemConfigPath),
							'vm-images',
							'gateways',
							'openclaw',
							'build-config.json',
						),
						dockerfile: './vm-images/gateways/openclaw/Dockerfile',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: toolVmBuildConfigPath,
					},
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			zones: [
				{
					egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: path.join(
							path.dirname(systemConfigPath),
							'gateways',
							'shravan',
							'openclaw.json',
						),
						port: 18791,
						stateDir: './state/shravan',
						zoneFilesDir: './zone-files/shravan',
					},
					id: 'shravan',
					...(options.includeMcpPortal === true
						? {
								agents: [{ id: 'sun' }],
								mcpPortal: {
									configDir: path.join(path.dirname(systemConfigPath), 'gateways', 'shravan'),
								},
							}
						: {}),
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: 'environment',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							audience: 'gateway',
						},
					},
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

function createHealthyOpenClawConfig(): object {
	return {
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
			list: [{ id: 'sun' }],
		},
		channels: {},
		approvals: {
			plugin: {
				enabled: true,
				mode: 'session',
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
		tools: {
			sandbox: {
				tools: {
					alsoAllow: ['group:plugins'],
				},
			},
		},
	};
}

function createManagedBaseOpenClawSystemConfig(
	gatewayBuildConfigPath: string,
	toolVmBuildConfigPath: string,
	systemConfigPath: string,
	options: { readonly includeMcpPortal?: boolean } = {},
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
						buildConfig: gatewayBuildConfigPath,
						source: {
							kind: 'managedBase',
							base: 'openclaw-gateway',
							overlay: './vm-images/gateways/openclaw/overlay.jsonc',
						},
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: toolVmBuildConfigPath,
						source: {
							kind: 'managedBase',
							base: 'tool-vm',
							overlay: './vm-images/tool-vms/default/overlay.jsonc',
						},
					},
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
			},
			zones: [
				{
					egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: path.join(
							path.dirname(systemConfigPath),
							'gateways',
							'shravan',
							'openclaw.json',
						),
						port: 18791,
						stateDir: './state/shravan',
						zoneFilesDir: './zone-files/shravan',
					},
					id: 'shravan',
					...(options.includeMcpPortal === true
						? {
								agents: [{ id: 'sun' }],
								mcpPortal: {
									configDir: path.join(path.dirname(systemConfigPath), 'gateways', 'shravan'),
								},
							}
						: {}),
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: 'environment',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							audience: 'gateway',
						},
					},
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
	);
}

async function writeNativeMcpPortalConfigFiles(configDirectoryPath: string): Promise<void> {
	const portalConfigDirectoryPath = path.join(configDirectoryPath, 'gateways', 'shravan');
	await fs.mkdir(portalConfigDirectoryPath, { recursive: true });
	await fs.writeFile(
		path.join(portalConfigDirectoryPath, 'mcp.config.jsonc'),
		JSON.stringify({ providers: {}, schemaVersion: 1 }),
		'utf8',
	);
	await fs.writeFile(
		path.join(portalConfigDirectoryPath, 'mcp-portal.config.jsonc'),
		JSON.stringify({
			agents: { sun: { profile: 'default' } },
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		}),
		'utf8',
	);
}

function createControllerClientStub(): ReturnType<
	typeof defaultCliDependencies.createControllerClient
> {
	return {
		destroyZone: async () => ({}),
		enableZoneSsh: async () => ({}),
		getControllerStatus: async () => ({}),
		getZoneLogs: async () => ({}),
		peekLease: async () => ({
			agentId: 'main',
			createdAt: 1,
			idleTtlMs: 6_000_000,
			lastUsedAt: 1,
			leaseId: 'lease-123',
			profileId: 'standard',
			ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
			tcpSlot: 0,
			transport: 'ssh-sandbox' as const,
			workdir: '/workspace',

			zoneId: 'shravan',
		}),
		listLeases: async () => [],
		refreshZoneCredentials: async () => ({}),
		releaseLease: async () => {},
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

async function writeImageBuildConfigsForDoctor(systemConfig: LoadedSystemConfig): Promise<void> {
	const imageProfiles = [
		...Object.values(systemConfig.imageProfiles.gateways),
		...Object.values(systemConfig.imageProfiles.toolVms),
	] as const;
	await Promise.all(
		imageProfiles.map(async (imageProfile) => {
			await fs.mkdir(path.dirname(imageProfile.buildConfig), { recursive: true });
			await fs.writeFile(
				imageProfile.buildConfig,
				JSON.stringify({
					oci: {
						image: `agent-vm-test-${imageProfile.type}:latest`,
						pullPolicy: 'ifNotPresent',
					},
				}),
				'utf8',
			);
		}),
	);
}

describe('runControllerOperationCommand', () => {
	it('refreshes OpenClaw credentials without resolving Tool VM-only secrets', async () => {
		const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
		process.env.OPENCLAW_GATEWAY_TOKEN = 'test-gateway-token';
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-credentials-'),
		);
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		const outputs: string[] = [];
		const systemConfig = createOpenClawSystemConfig(toolVmBuildConfigPath, systemConfigPath);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected OpenClaw test system config to include a zone.');
		}
		zone.secrets.LINEAR_API_KEY = {
			source: '1password',
			ref: 'op://agent-vm/shravan-linear/credential',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
		};
		zone.egressHosts = [...zone.egressHosts, { host: 'api.linear.app', audience: 'tool-vm' }];

		try {
			await runControllerOperationCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () => createControllerClientStub(),
					runControllerDoctor: () => ({ ok: true, checks: [] }),
				},
				io: {
					stderr: { write: () => true },
					stdout: {
						write: (chunk: string | Uint8Array) => {
							outputs.push(String(chunk));
							return true;
						},
					},
				},
				restArguments: ['refresh', '--zone', 'shravan'],
				subcommand: 'credentials',
				systemConfig,
			});
		} finally {
			if (previousGatewayToken === undefined) {
				delete process.env.OPENCLAW_GATEWAY_TOKEN;
			} else {
				process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
			}
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}

		expect(JSON.parse(outputs.join(''))).toEqual({});
	});

	it('accepts authored worker config drafts without generated runtime instructions in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				commonAgentInstructions: null,
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
				mcpServers: [{ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }],
			}),
			'utf8',
		);
		const outputs: string[] = [];
		const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);
		await writeImageBuildConfigsForDoctor(systemConfig);

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig,
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly failed: number;
			readonly ok: boolean;
			readonly passed: number;
			readonly summary: string;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
			}[];
		};

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'worker-config-worker')?.ok).toBe(true);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('writes a human-readable failed doctor summary by default', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];
		const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);
		await writeImageBuildConfigsForDoctor(systemConfig);

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: createControllerClientStub,
				runControllerDoctor: () => ({
					ok: false,
					checks: [
						{
							name: 'controller-required-binary',
							ok: false,
							hint: 'missing binary\ninstall the binary',
						},
						{ name: 'controller-port', ok: true, value: 18800 },
						{ name: 'host-cache-dir', ok: true },
						{ name: 'host-runtime-dir', ok: true },
						{ name: 'gateway-image-profile-worker-dockerfile', ok: true },
						{ name: 'tool-vm-image-profile-default-dockerfile', ok: true },
						{ name: 'zone-git-shravan', ok: true },
						{ name: 'zone-runtime-shravan', ok: true },
						{ name: 'zone-secrets-shravan', ok: true },
						{ name: 'worker-config-path-worker', ok: true },
						{ name: 'worker-config-schema-worker', ok: true },
					],
				}),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: [],
			subcommand: 'doctor',
			systemConfig,
		});

		const output = outputs.join('').replaceAll(ansiEscapeSequencePattern, '');
		expect(output).toContain('agent-vm doctor');
		expect(output).toContain('1 failed');
		expect(output).toContain('Failures');
		expect(output).toContain('FAIL');
		expect(output).toContain('controller-required-binary');
		expect(output).toContain('missing binary');
		expect(output).toContain('      install the binary');
		expect(output).toContain('Passing (11)');
		expect(output).toContain('ok    controller-port');
		expect(output).toContain('ok    host-runtime-dir');
		expect(output).toContain('... 8 more passing checks hidden. Use --show-passed to show all.');
		expect(output).not.toContain('ok    gateway-image-profile-worker-dockerfile');
		expect(output).not.toContain('ok    worker-config-worker');
		expect(output).not.toContain('hint:');
		expect(output).not.toContain('passed checks hidden.');
		const parseDoctorOutput = (): void => {
			JSON.parse(output);
		};
		expect(parseDoctorOutput).toThrow();

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('uses singular wording for one hidden passing doctor check', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		try {
			const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
			const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
			const outputs: string[] = [];
			const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);

			await runControllerOperationCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: createControllerClientStub,
					runControllerDoctor: () => ({
						ok: false,
						checks: [
							{ name: 'controller-required-binary', ok: false, hint: 'missing binary' },
							{ name: 'controller-port', ok: true },
							{ name: 'host-cache-dir', ok: true },
							{ name: 'host-runtime-dir', ok: true },
							{ name: 'worker-config-worker', ok: true },
						],
					}),
				},
				io: {
					stderr: { write: () => true },
					stdout: {
						write: (chunk: string | Uint8Array) => {
							outputs.push(String(chunk));
							return true;
						},
					},
				},
				restArguments: [],
				subcommand: 'doctor',
				systemConfig,
			});

			const output = outputs.join('').replaceAll(ansiEscapeSequencePattern, '');
			expect(output).toContain('... 1 more passing check hidden. Use --show-passed to show all.');
			expect(output).not.toContain('... 1 more passing checks hidden.');
		} finally {
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('does not print an empty passing section when show-passed has no passed checks', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		try {
			const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
			const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
			const outputs: string[] = [];
			const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);

			await runControllerOperationCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: createControllerClientStub,
					runControllerDoctor: () => ({
						ok: false,
						checks: [{ name: 'controller-required-binary', ok: false, hint: 'missing binary' }],
					}),
				},
				io: {
					stderr: { write: () => true },
					stdout: {
						write: (chunk: string | Uint8Array) => {
							outputs.push(String(chunk));
							return true;
						},
					},
				},
				restArguments: ['--show-passed'],
				subcommand: 'doctor',
				systemConfig,
			});

			const output = outputs.join('').replaceAll(ansiEscapeSequencePattern, '');
			expect(output).toContain('Failures');
			expect(output).not.toContain('Passing (0)');
		} finally {
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('shows passed doctor checks when requested', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		try {
			const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
			const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
			await fs.writeFile(
				workerConfigPath,
				JSON.stringify({
					phases: {
						plan: {
							cycle: { kind: 'review', cycleCount: 1 },
							agentInstructions: null,
							reviewerInstructions: null,
						},
						work: {
							cycle: { kind: 'review', cycleCount: 1 },
							agentInstructions: null,
							reviewerInstructions: null,
						},
						wrapup: { instructions: null },
					},
				}),
				'utf8',
			);
			const outputs: string[] = [];
			const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);
			await writeImageBuildConfigsForDoctor(systemConfig);

			await runControllerOperationCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: createControllerClientStub,
					runControllerDoctor: () => ({
						ok: false,
						checks: [
							{ name: 'controller-required-binary', ok: false, hint: 'missing binary' },
							{ name: 'controller-port', ok: true, value: 18800 },
						],
					}),
				},
				io: {
					stderr: { write: () => true },
					stdout: {
						write: (chunk: string | Uint8Array) => {
							outputs.push(String(chunk));
							return true;
						},
					},
				},
				restArguments: ['--show-passed'],
				subcommand: 'doctor',
				systemConfig,
			});

			const output = outputs.join('').replaceAll(ansiEscapeSequencePattern, '');
			expect(output).toContain('Failures');
			expect(output).toContain('Passing');
			expect(output).toContain('FAIL  controller-required-binary');
			expect(output).toContain('ok    controller-port');
			expect(output).not.toContain('passed checks hidden.');
		} finally {
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('preserves machine-readable doctor output with json flag', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];
		const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);
		await writeImageBuildConfigsForDoctor(systemConfig);

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: createControllerClientStub,
				runControllerDoctor: () => ({
					ok: false,
					checks: [{ name: 'controller-required-binary', ok: false, hint: 'missing binary' }],
				}),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig,
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly failed: number;
			readonly ok: boolean;
			readonly summary: string;
		};

		expect(result.ok).toBe(false);
		expect(result.failed).toBe(1);
		expect(result.summary).toBe('1 check(s) failed');

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('validates OpenClaw gateway configs with the catalog OpenClaw CLI in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const binDirectoryPath = path.join(temporaryDirectoryPath, 'node_modules', '.bin');
		const configDirectoryPath = path.join(temporaryDirectoryPath, 'config');
		const openClawConfigPath = path.join(
			configDirectoryPath,
			'gateways',
			'shravan',
			'openclaw.json',
		);
		const commandLogPath = path.join(temporaryDirectoryPath, 'openclaw-command.json');
		await fs.mkdir(binDirectoryPath, { recursive: true });
		await fs.mkdir(path.dirname(openClawConfigPath), { recursive: true });
		await fs.writeFile(openClawConfigPath, JSON.stringify(createHealthyOpenClawConfig()), 'utf8');
		await writeNativeMcpPortalConfigFiles(configDirectoryPath);
		await fs.writeFile(
			path.join(binDirectoryPath, 'openclaw'),
			`#!/bin/sh
printf '{"cwd":"%s","config":"%s","args":"%s"}\\n' "$PWD" "$OPENCLAW_CONFIG_PATH" "$*" > "${commandLogPath}"
printf '{"ok":true}\\n'
`,
			{ encoding: 'utf8', mode: 0o755 },
		);
		process.env.PATH = `${binDirectoryPath}:${originalPath ?? ''}`;
		const outputs: string[] = [];
		const systemConfig = createOpenClawSystemConfig(
			path.join(temporaryDirectoryPath, 'vm-images', 'tool-vms', 'default', 'build-config.json'),
			path.join(configDirectoryPath, 'system.json'),
			{ includeMcpPortal: true },
		);
		await writeImageBuildConfigsForDoctor(systemConfig);

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				resolveGondolinMinimumZigVersion: async () => '0.15.2',
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig,
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly hint?: string;
				readonly name: string;
				readonly ok: boolean;
			}[];
		};
		const commandLog = JSON.parse(await fs.readFile(commandLogPath, 'utf8')) as {
			readonly args: string;
			readonly config: string;
			readonly cwd: string;
		};
		const realTemporaryDirectoryPath = await fs.realpath(temporaryDirectoryPath);

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'openclaw-config-shravan')).toMatchObject({
			ok: true,
			hint: openClawConfigPath,
		});
		expect(commandLog).toEqual({
			args: 'config validate --json',
			config: openClawConfigPath,
			cwd: realTemporaryDirectoryPath,
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports worker prompt reference failures in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: { path: './prompts/missing.md' },
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];
		const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);
		await writeImageBuildConfigsForDoctor(systemConfig);

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig,
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly failed: number;
			readonly passed: number;
			readonly summary: string;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		const workerConfigCheck = result.checks.find((check) => check.name === 'worker-config-worker');
		expect(workerConfigCheck?.ok).toBe(false);
		expect(workerConfigCheck?.hint).toMatch(/phases\.plan\.agentInstructions.*missing\.md/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('flags never-pulled tool VM image profiles without a Dockerfile producer', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(toolVmBuildConfigPath), { recursive: true });
		await fs.writeFile(
			toolVmBuildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-tool:latest', pullPolicy: 'never' } }),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig: createOpenClawSystemConfig(toolVmBuildConfigPath, systemConfigPath),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly failed: number;
			readonly passed: number;
			readonly summary: string;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'tool-vm-image-profile-default-dockerfile'),
		).toMatchObject({
			ok: false,
			hint: 'pullPolicy=never requires a dockerfile producer for agent-vm-tool:latest',
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('accepts never-pulled managed base image profiles without a Dockerfile producer', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const gatewayBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'gateways',
			'openclaw',
			'build-config.json',
		);
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		const openClawConfigPath = path.join(
			temporaryDirectoryPath,
			'config',
			'gateways',
			'shravan',
			'openclaw.json',
		);
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(gatewayBuildConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(toolVmBuildConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(openClawConfigPath), { recursive: true });
		await fs.writeFile(openClawConfigPath, JSON.stringify(createHealthyOpenClawConfig()), 'utf8');
		await writeNativeMcpPortalConfigFiles(path.dirname(systemConfigPath));
		await fs.writeFile(
			gatewayBuildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-openclaw:latest', pullPolicy: 'never' } }),
			'utf8',
		);
		await fs.writeFile(
			toolVmBuildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-tool:latest', pullPolicy: 'never' } }),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig: createManagedBaseOpenClawSystemConfig(
				gatewayBuildConfigPath,
				toolVmBuildConfigPath,
				systemConfigPath,
				{ includeMcpPortal: true },
			),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(true);
		expect(
			result.checks.find((check) => check.name === 'gateway-image-profile-openclaw-dockerfile'),
		).toMatchObject({
			ok: true,
			hint: expect.stringContaining(
				path.join('vm-images', 'gateways', 'openclaw', 'overlay.jsonc'),
			),
		});
		expect(
			result.checks.find((check) => check.name === 'tool-vm-image-profile-default-dockerfile'),
		).toMatchObject({
			ok: true,
			hint: expect.stringContaining(path.join('vm-images', 'tool-vms', 'default', 'overlay.jsonc')),
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing image profile build configs in controller doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const missingGatewayBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'gateways',
			'openclaw',
			'missing-build-config.json',
		);
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(toolVmBuildConfigPath), { recursive: true });
		await fs.writeFile(
			toolVmBuildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-tool:latest', pullPolicy: 'ifNotPresent' } }),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig: createManagedBaseOpenClawSystemConfig(
				missingGatewayBuildConfigPath,
				toolVmBuildConfigPath,
				systemConfigPath,
			),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		expect(
			result.checks.find((check) => check.name === 'gateway-image-profile-openclaw-build-config'),
		).toMatchObject({
			ok: false,
			hint: expect.stringContaining(missingGatewayBuildConfigPath),
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('resolves container worker config paths to checkout paths in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const workerConfigPath = path.join(
			temporaryDirectoryPath,
			'config',
			'gateways',
			'worker',
			'worker.json',
		);
		const vmHostSystemPath = path.join(temporaryDirectoryPath, 'vm-host-system');
		await fs.mkdir(path.dirname(workerConfigPath), { recursive: true });
		await fs.mkdir(vmHostSystemPath, { recursive: true });
		await Promise.all(
			['Dockerfile', 'start.sh', 'agent-vm-controller.service'].map(async (fileName) => {
				await fs.writeFile(path.join(vmHostSystemPath, fileName), '', 'utf8');
			}),
		);
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];
		const resolvedPathSystemConfig = createWorkerSystemConfig(
			'/etc/agent-vm/gateways/worker/worker.json',
			systemConfigPath,
		);
		await writeImageBuildConfigsForDoctor(resolvedPathSystemConfig);

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig: resolvedPathSystemConfig,
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly failed: number;
			readonly ok: boolean;
			readonly passed: number;
			readonly summary: string;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(true);
		expect(result.failed).toBe(0);
		expect(result.passed).toBeGreaterThan(0);
		expect(result.summary).toBe('all checks passed');
		expect(result.checks.find((check) => check.name === 'worker-config-worker')).toMatchObject({
			ok: true,
			hint: workerConfigPath,
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing vm-host-system files for container configs in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		const vmHostSystemPath = path.join(temporaryDirectoryPath, 'vm-host-system');
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.mkdir(vmHostSystemPath, { recursive: true });
		await fs.writeFile(
			workerConfigPath,
			JSON.stringify({
				phases: {
					plan: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { instructions: null },
				},
			}),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						agentId: 'main',
						createdAt: 1,
						idleTtlMs: 6_000_000,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
						transport: 'ssh-sandbox' as const,
						workdir: '/workspace',

						zoneId: 'shravan',
					}),
					listLeases: async () => [],
					refreshZoneCredentials: async () => ({}),
					releaseLease: async () => {},
					stopController: async () => ({}),
					upgradeZone: async () => ({}),
				}),
				runControllerDoctor: () => ({ ok: true, checks: [] }),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--json'],
			subcommand: 'doctor',
			systemConfig: createWorkerSystemConfig(workerConfigPath, systemConfigPath),
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
				readonly hint?: string;
			}[];
		};

		expect(result.ok).toBe(false);
		const vmHostSystemCheck = result.checks.find((check) => check.name === 'vm-host-system');
		expect(vmHostSystemCheck?.ok).toBe(false);
		expect(vmHostSystemCheck?.hint).toContain('vm-host-system/Dockerfile');

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});
});
