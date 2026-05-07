import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDefaultSystemCacheIdentifier } from '../config/system-cache-identifier.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runControllerOperationCommand } from './controller-operation-commands.js';

const originalPath = process.env.PATH;

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
					allowedHosts: ['api.openai.com'],
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
					allowedHosts: ['api.openai.com'],
					gateway: {
						type: 'openclaw',
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
					secrets: {},
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
					scope: 'agent',
					workspaceAccess: 'rw',
				},
				workspace: '/zone/agents/default',
			},
		},
		channels: {},
		plugins: {
			allow: ['gondolin', 'memory-core'],
			entries: {
				gondolin: { enabled: true },
				'memory-core': { enabled: true },
			},
			load: {
				paths: ['/home/openclaw/.openclaw/extensions', '/pnpm/global/5/node_modules/@openclaw'],
			},
			slots: { memory: 'memory-core' },
		},
	};
}

function createManagedBaseOpenClawSystemConfig(
	gatewayBuildConfigPath: string,
	toolVmBuildConfigPath: string,
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
					allowedHosts: ['api.openai.com'],
					gateway: {
						type: 'openclaw',
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
					secrets: {},
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
					websocketBypass: [],
				},
			],
		},
		{ systemConfigPath },
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
			createdAt: 1,
			lastUsedAt: 1,
			leaseId: 'lease-123',
			profileId: 'standard',
			scopeKey: 'scope',
			ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
			tcpSlot: 0,
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
	it('accepts authored worker config drafts without generated runtime instructions in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(systemCacheIdentifierPath, '{}\n', 'utf8');
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
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
			subcommand: 'doctor',
			systemConfig,
		});

		const result = JSON.parse(outputs.join('')) as {
			readonly ok: boolean;
			readonly checks: readonly {
				readonly name: string;
				readonly ok: boolean;
			}[];
		};

		expect(result.ok).toBe(true);
		expect(result.checks.find((check) => check.name === 'worker-config-worker')?.ok).toBe(true);

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
		await fs.writeFile(
			path.join(configDirectoryPath, 'systemCacheIdentifier.json'),
			'{}\n',
			'utf8',
		);
		await fs.writeFile(openClawConfigPath, JSON.stringify(createHealthyOpenClawConfig()), 'utf8');
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
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
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
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(systemCacheIdentifierPath, '{}\n', 'utf8');
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
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
			subcommand: 'doctor',
			systemConfig,
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
		const workerConfigCheck = result.checks.find((check) => check.name === 'worker-config-worker');
		expect(workerConfigCheck?.ok).toBe(false);
		expect(workerConfigCheck?.hint).toMatch(/phases\.plan\.agentInstructions.*missing\.md/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('flags never-pulled tool VM image profiles without a Dockerfile producer', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'config',
			'systemCacheIdentifier.json',
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
		await fs.writeFile(systemCacheIdentifierPath, '{}\n', 'utf8');
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
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
			subcommand: 'doctor',
			systemConfig: createOpenClawSystemConfig(toolVmBuildConfigPath, systemConfigPath),
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
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'config',
			'systemCacheIdentifier.json',
		);
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
		await fs.writeFile(systemCacheIdentifierPath, '{}\n', 'utf8');
		await fs.writeFile(openClawConfigPath, JSON.stringify(createHealthyOpenClawConfig()), 'utf8');
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
			restArguments: [],
			subcommand: 'doctor',
			systemConfig: createManagedBaseOpenClawSystemConfig(
				gatewayBuildConfigPath,
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
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'config',
			'systemCacheIdentifier.json',
		);
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
		await fs.writeFile(systemCacheIdentifierPath, '{}\n', 'utf8');
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
			restArguments: [],
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

	it('reports missing system cache identifier failures in doctor output', async () => {
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

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
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
		const identifierCheck = result.checks.find((check) => check.name === 'system-cache-identifier');
		expect(identifierCheck?.ok).toBe(false);
		expect(identifierCheck?.hint).toMatch(/Missing system cache identifier/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports malformed system cache identifier failures in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.writeFile(systemCacheIdentifierPath, '{not-json', 'utf8');
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
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
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
		const identifierCheck = result.checks.find((check) => check.name === 'system-cache-identifier');
		expect(identifierCheck?.ok).toBe(false);
		expect(identifierCheck?.hint).toMatch(/Failed to parse system cache identifier/u);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('resolves container worker config paths to checkout paths in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'config',
			'systemCacheIdentifier.json',
		);
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
		await fs.writeFile(
			systemCacheIdentifierPath,
			JSON.stringify({
				...buildDefaultSystemCacheIdentifier(),
				hostSystemType: 'container',
			}),
			'utf8',
		);
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
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
			subcommand: 'doctor',
			systemConfig: resolvedPathSystemConfig,
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
		expect(result.checks.find((check) => check.name === 'worker-config-worker')).toMatchObject({
			ok: true,
			hint: workerConfigPath,
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('reports missing vm-host-system files for container configs in doctor output', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'config',
			'systemCacheIdentifier.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.writeFile(
			systemCacheIdentifierPath,
			JSON.stringify({
				...buildDefaultSystemCacheIdentifier(),
				hostSystemType: 'container',
			}),
			'utf8',
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

		await runControllerOperationCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					destroyZone: async () => ({}),
					enableZoneSsh: async () => ({}),
					getControllerStatus: async () => ({}),
					getZoneLogs: async () => ({}),
					peekLease: async () => ({
						createdAt: 1,
						lastUsedAt: 1,
						leaseId: 'lease-123',
						profileId: 'standard',
						scopeKey: 'scope',
						ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
						tcpSlot: 0,
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
			restArguments: [],
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
