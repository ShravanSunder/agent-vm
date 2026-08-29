import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runControllerOperationCommand } from './controller-operation-commands.js';

const originalPath = process.env.PATH;
const ansiEscapeSequencePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function createControllerOperationToolPortalConfig(
	configDir: string,
): NonNullable<LoadedSystemConfig['zones'][number]['toolPortal']> {
	return {
		configDir,
		surfaceEligibilityByProfile: { default: {} },
	};
}

afterEach(() => {
	process.env.PATH = originalPath;
	delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
	delete process.env.OP_SESSION;
});

function createWorkerSystemConfig(
	workerConfigPath: string,
	systemConfigPath: string,
): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			storageRootDir: './storage',
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
					},
					id: 'worker',
					secrets: {},
				},
			],
		},
		{ systemConfigPath },
	);
}

function createHermesSystemConfig(
	toolVmBuildConfigPath: string,
	systemConfigPath: string,
	options: { readonly includeToolPortal?: boolean } = {},
): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			storageRootDir: './storage',
			host: {
				controllerPort: 18800,
				projectNamespace: 'agent-vm-test',
			},
			imageProfiles: {
				gateways: {
					hermes: {
						type: 'hermes',
						buildConfig: path.join(
							path.dirname(systemConfigPath),
							'vm-images',
							'gateways',
							'hermes',
							'build-config.json',
						),
						dockerfile: './vm-images/gateways/hermes/Dockerfile',
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
						type: 'hermes',
						profileSecretProjectionsByAgent: {
							sun: {
								API_SERVER_KEY: 'API_SERVER_KEY_SUN',
								DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SUN',
							},
						},
						profilesByAgent: { sun: 'sun' },
						imageProfile: 'hermes',
						cpus: 2,
						memory: '2G',
						config: path.join(path.dirname(systemConfigPath), 'gateways', 'shravan', 'hermes.yaml'),
						port: 18791,
					},
					id: 'shravan',
					agents: [{ id: 'sun' }],
					...(options.includeToolPortal === true
						? {
								toolPortal: createControllerOperationToolPortalConfig(
									path.join(path.dirname(systemConfigPath), 'gateways', 'shravan'),
								),
							}
						: {}),
					secrets: {
						API_SERVER_KEY_SUN: {
							source: 'environment',
							envVar: 'API_SERVER_KEY_SUN',
							injection: 'env',
							audience: 'gateway',
						},
						DISCORD_BOT_TOKEN_SUN: {
							source: 'environment',
							envVar: 'DISCORD_BOT_TOKEN_SUN',
							injection: 'env',
							audience: 'gateway',
						},
					},
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
				},
			],
		},
		{ systemConfigPath },
	);
}

function createManagedBaseWorkerSystemConfig(
	gatewayBuildConfigPath: string,
	toolVmBuildConfigPath: string,
	systemConfigPath: string,
): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			storageRootDir: './storage',
			host: {
				controllerPort: 18800,
				projectNamespace: 'agent-vm-test',
			},
			imageProfiles: {
				gateways: {
					worker: {
						type: 'worker',
						buildConfig: gatewayBuildConfigPath,
						source: {
							kind: 'managedBase',
							base: 'worker-gateway',
							overlay: path.join(
								path.dirname(systemConfigPath),
								'..',
								'vm-images',
								'gateways',
								'worker',
								'overlay.jsonc',
							),
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
							overlay: path.join(
								path.dirname(systemConfigPath),
								'..',
								'vm-images',
								'tool-vms',
								'default',
								'overlay.jsonc',
							),
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
					egressHosts: [{ host: 'api.openai.com', audience: 'gateway' }],
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						cpus: 2,
						memory: '2G',
						config: path.join(path.dirname(systemConfigPath), 'worker.json'),
						port: 18791,
					},
					id: 'worker',
					secrets: {},
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
		getZoneHealth: async () => ({}),
		getZoneHealthSnapshot: async () => ({}),
		getZoneServiceHealth: async () => ({}),
		getZoneLogs: async () => ({}),
		refreshZoneCredentials: async () => ({}),
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

function fastDoctorEnvironmentOptions(binaryNames: readonly string[] = []): {
	readonly collectDoctorEnvironment: NonNullable<
		Parameters<typeof runControllerOperationCommand>[0]['collectDoctorEnvironment']
	>;
} {
	return {
		collectDoctorEnvironment: async () => ({
			availableBinaries: new Set(binaryNames),
			dockerDaemonReady: binaryNames.includes('docker'),
			env: {},
			nodeVersion: 'v24.0.0',
			requiredZigVersion: '0.16.0',
			zigVersion: '0.16.0',
		}),
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
	it('prints live zone health and zone health snapshots through the controller client', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-health-command-'),
		);
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		const systemConfig = createHermesSystemConfig(toolVmBuildConfigPath, systemConfigPath);
		const outputs: string[] = [];
		const calledOperations: string[] = [];
		const controllerClient = {
			...createControllerClientStub(),
			getZoneHealth: async (zoneId: string) => {
				calledOperations.push(`health:${zoneId}`);
				return { ok: true, path: '/readyz', zoneId };
			},
			getZoneHealthSnapshot: async (zoneId: string) => {
				calledOperations.push(`health-snapshot:${zoneId}`);
				return { healthy: true, issues: [], zoneId };
			},
			getZoneServiceHealth: async (zoneId: string) => {
				calledOperations.push(`service-health:${zoneId}`);
				return { ok: true, path: '/health', zoneId };
			},
		};

		try {
			for (const subcommand of ['health', 'health-snapshot', 'service-health'] as const) {
				// oxlint-disable-next-line no-await-in-loop -- commands intentionally run serially against shared output capture
				await runControllerOperationCommand({
					dependencies: {
						...defaultCliDependencies,
						createControllerClient: () => controllerClient,
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
					zoneId: 'shravan',
					subcommand,
					systemConfig,
				});
			}
		} finally {
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}

		expect(calledOperations).toEqual([
			'health:shravan',
			'health-snapshot:shravan',
			'service-health:shravan',
		]);
		expect(outputs.join('\n')).toContain('"path": "/readyz"');
		expect(outputs.join('\n')).toContain('"healthy": true');
		expect(outputs.join('\n')).toContain('"path": "/health"');
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
			...fastDoctorEnvironmentOptions(),
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
			json: true,
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

		expect(result.checks.filter((check) => !check.ok)).toEqual([]);
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
			...fastDoctorEnvironmentOptions(),
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
						{ name: 'controller-cache-writable', ok: true },
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
				...fastDoctorEnvironmentOptions(),
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
				...fastDoctorEnvironmentOptions(),
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
				showPassed: true,
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
				...fastDoctorEnvironmentOptions(),
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: createControllerClientStub,
					runControllerDoctor: () => ({
						ok: false,
						checks: [
							{ name: 'controller-required-binary', ok: false, hint: 'missing binary' },
							{
								name: 'controller-port',
								ok: true,
								value: 18800,
								hint: 'bound to localhost',
							},
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
				showPassed: true,
				subcommand: 'doctor',
				systemConfig,
			});

			const output = outputs.join('').replaceAll(ansiEscapeSequencePattern, '');
			expect(output).toContain('Failures');
			expect(output).toContain('Passing');
			expect(output).toContain('FAIL  controller-required-binary');
			expect(output).toContain('ok    controller-port');
			expect(output).toContain('      18800');
			expect(output).toContain('      bound to localhost');
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
			...fastDoctorEnvironmentOptions(),
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
			json: true,
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

	it('reports 1Password service-account headless fallback readiness without printing the token', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		const opShimDirectory = path.join(temporaryDirectoryPath, 'bin');
		const opEnvCapturePath = path.join(temporaryDirectoryPath, 'op-env.txt');
		await fs.mkdir(opShimDirectory, { recursive: true });
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
		await fs.writeFile(
			path.join(opShimDirectory, 'op'),
			[
				'#!/bin/sh',
				`env | sort > ${JSON.stringify(opEnvCapturePath)}`,
				'if [ "$1" = "whoami" ]; then',
				'  printf "URL: https://example.1password.test\\nUser Type: SERVICE_ACCOUNT\\n"',
				'  exit 0',
				'fi',
				'exit 2',
				'',
			].join('\n'),
			'utf8',
		);
		await fs.chmod(path.join(opShimDirectory, 'op'), 0o755);

		process.env.PATH = originalPath
			? `${opShimDirectory}${path.delimiter}${originalPath}`
			: opShimDirectory;
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'SUPER-SECRET-TOKEN';
		process.env.OP_SESSION = 'ambient-human-session';

		try {
			const outputs: string[] = [];
			const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);
			const onePasswordSystemConfig = {
				...systemConfig,
				host: {
					...systemConfig.host,
					secretsProvider: {
						type: '1password' as const,
						tokenSource: { type: 'env' as const },
					},
				},
			} satisfies LoadedSystemConfig;
			await writeImageBuildConfigsForDoctor(onePasswordSystemConfig);

			await runControllerOperationCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: createControllerClientStub,
					runControllerDoctor: () => ({
						ok: true,
						checks: [],
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
				json: true,
				subcommand: 'doctor',
				systemConfig: onePasswordSystemConfig,
			});

			const renderedOutput = outputs.join('');
			expect(renderedOutput).not.toContain('SUPER-SECRET-TOKEN');
			expect(renderedOutput).not.toContain('ambient-human-session');
			const result = JSON.parse(renderedOutput) as {
				readonly checks: readonly {
					readonly hint?: string;
					readonly name: string;
					readonly ok: boolean;
				}[];
			};
			expect(result.checks.find((check) => check.name === '1password-op-cli-headless')).toEqual({
				name: '1password-op-cli-headless',
				ok: true,
				hint: 'op whoami returned SERVICE_ACCOUNT with isolated service-account env',
			});
			const opEnv = await fs.readFile(opEnvCapturePath, 'utf8');
			expect(opEnv).toContain('OP_SERVICE_ACCOUNT_TOKEN=SUPER-SECRET-TOKEN');
			expect(opEnv).toContain('OP_BIOMETRIC_UNLOCK_ENABLED=false');
			expect(opEnv).toContain('OP_CACHE=false');
			expect(opEnv).not.toContain('OP_SESSION=');
		} finally {
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('redacts literal service-account token values from 1Password doctor probe hints', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'system.json');
		const workerConfigPath = path.join(temporaryDirectoryPath, 'worker.json');
		const opShimDirectory = path.join(temporaryDirectoryPath, 'bin');
		await fs.mkdir(opShimDirectory, { recursive: true });
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
		await fs.writeFile(path.join(opShimDirectory, 'op'), '#!/bin/sh\nexit 0\n', 'utf8');
		await fs.chmod(path.join(opShimDirectory, 'op'), 0o755);

		process.env.PATH = originalPath
			? `${opShimDirectory}${path.delimiter}${originalPath}`
			: opShimDirectory;
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'SUPER-SECRET-TOKEN';

		try {
			const outputs: string[] = [];
			const systemConfig = createWorkerSystemConfig(workerConfigPath, systemConfigPath);
			const onePasswordSystemConfig = {
				...systemConfig,
				host: {
					...systemConfig.host,
					secretsProvider: {
						type: '1password' as const,
						tokenSource: { type: 'env' as const },
					},
				},
			} satisfies LoadedSystemConfig;
			await writeImageBuildConfigsForDoctor(onePasswordSystemConfig);

			await runControllerOperationCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: createControllerClientStub,
					probeOnePasswordServiceAccountHeadlessAuth: async () => ({
						hint: 'probe failed for raw token SUPER-SECRET-TOKEN',
						ok: false,
					}),
					runControllerDoctor: () => ({
						ok: true,
						checks: [],
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
				json: true,
				subcommand: 'doctor',
				systemConfig: onePasswordSystemConfig,
			});

			const renderedOutput = outputs.join('');
			expect(renderedOutput).not.toContain('SUPER-SECRET-TOKEN');
			const result = JSON.parse(renderedOutput) as {
				readonly checks: readonly {
					readonly hint?: string;
					readonly name: string;
					readonly ok: boolean;
				}[];
			};
			expect(result.checks.find((check) => check.name === '1password-op-cli-headless')).toEqual({
				name: '1password-op-cli-headless',
				ok: false,
				hint: 'probe failed for raw token <redacted>',
			});
		} finally {
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
	});

	it('does not resolve or report retired whole-zone Git authority during doctor', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-doctor-'));
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'SUPER-SECRET-TOKEN';

		try {
			const outputs: string[] = [];
			const systemConfig = createHermesSystemConfig(toolVmBuildConfigPath, systemConfigPath);
			const onePasswordSystemConfig = {
				...systemConfig,
				host: {
					...systemConfig.host,
					githubToken: {
						source: '1password' as const,
						ref: 'op://agent-vm/github-token/credential',
					},
					secretsProvider: {
						type: '1password' as const,
						tokenSource: { type: 'env' as const },
					},
				},
			} satisfies LoadedSystemConfig;
			await writeImageBuildConfigsForDoctor(onePasswordSystemConfig);
			const createSecretResolver = vi.fn(async () => ({
				resolve: async (): Promise<string> => {
					throw new Error('Retired whole-zone Git authority must not be resolved by doctor.');
				},
				resolveAll: async (): Promise<Record<string, string>> => ({}),
			}));

			await runControllerOperationCommand({
				...fastDoctorEnvironmentOptions(['op']),
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: createControllerClientStub,
					createSecretResolver,
					probeOnePasswordServiceAccountHeadlessAuth: async () => ({
						hint: 'headless probe ok for SUPER-SECRET-TOKEN',
						ok: true,
					}),
					runControllerDoctor: () => ({
						ok: true,
						checks: [],
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
				json: true,
				subcommand: 'doctor',
				systemConfig: onePasswordSystemConfig,
			});

			const renderedOutput = outputs.join('');
			expect(renderedOutput).not.toContain('SUPER-SECRET-TOKEN');
			expect(renderedOutput).not.toContain('op://');
			expect(createSecretResolver).not.toHaveBeenCalled();
			const result = JSON.parse(renderedOutput) as {
				readonly checks: readonly {
					readonly hint?: string;
					readonly name: string;
					readonly ok: boolean;
				}[];
			};
			expect(result.checks.find((check) => check.name === '1password-op-cli-headless')).toEqual({
				name: '1password-op-cli-headless',
				ok: true,
				hint: 'headless probe ok for <redacted>',
			});
			expect(result.checks.some((check) => check.name.startsWith('zone-git-'))).toBe(false);
		} finally {
			await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
		}
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
			...fastDoctorEnvironmentOptions(),
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
			json: true,
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
			...fastDoctorEnvironmentOptions(),
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
			json: true,
			subcommand: 'doctor',
			systemConfig: createHermesSystemConfig(toolVmBuildConfigPath, systemConfigPath),
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
			'worker',
			'build-config.json',
		);
		const toolVmBuildConfigPath = path.join(
			temporaryDirectoryPath,
			'vm-images',
			'tool-vms',
			'default',
			'build-config.json',
		);
		const workerConfigPath = path.join(temporaryDirectoryPath, 'config', 'worker.json');
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(gatewayBuildConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(toolVmBuildConfigPath), { recursive: true });
		await fs.mkdir(path.dirname(workerConfigPath), { recursive: true });
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
				mcpServers: [],
			}),
			'utf8',
		);
		await fs.writeFile(
			gatewayBuildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-worker:latest', pullPolicy: 'never' } }),
			'utf8',
		);
		await fs.writeFile(
			toolVmBuildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-tool:latest', pullPolicy: 'never' } }),
			'utf8',
		);
		await fs.writeFile(
			path.join(path.dirname(gatewayBuildConfigPath), 'overlay.jsonc'),
			JSON.stringify({ schemaVersion: 1 }),
			'utf8',
		);
		await fs.writeFile(
			path.join(path.dirname(toolVmBuildConfigPath), 'overlay.jsonc'),
			JSON.stringify({ schemaVersion: 1 }),
			'utf8',
		);
		const outputs: string[] = [];

		await runControllerOperationCommand({
			...fastDoctorEnvironmentOptions(),
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
			json: true,
			subcommand: 'doctor',
			systemConfig: createManagedBaseWorkerSystemConfig(
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

		expect(result.checks.filter((check) => !check.ok)).toEqual([]);
		expect(result.ok).toBe(true);
		expect(
			result.checks.find((check) => check.name === 'gateway-image-profile-worker-dockerfile'),
		).toMatchObject({
			ok: true,
			hint: expect.stringContaining(path.join('vm-images', 'gateways', 'worker', 'overlay.jsonc')),
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
			'worker',
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
			...fastDoctorEnvironmentOptions(),
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
			json: true,
			subcommand: 'doctor',
			systemConfig: createManagedBaseWorkerSystemConfig(
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
			result.checks.find((check) => check.name === 'gateway-image-profile-worker-build-config'),
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
			...fastDoctorEnvironmentOptions(),
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
			json: true,
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
			...fastDoctorEnvironmentOptions(),
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
			json: true,
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
