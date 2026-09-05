import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageArtifactFixtureFileContent } from '../../../../scripts/test-fixtures/image-artifact-fixture.js';
import { writeImageArtifactFixture } from '../../../../scripts/test-fixtures/image-artifact-fixture.js';
import { computeFingerprintFromConfigPath } from '../build/gondolin-image-builder.js';
import { managedVmImageAssetFileNames as buildImageAssetFileNames } from '../build/gondolin-managed-vm-build-tooling.js';
import {
	createLoadedSystemConfig,
	type LoadedSystemConfig,
	type SystemConfigInput,
} from '../config/system-config.js';
import {
	managedGatewayBootProjectionForGatewayType,
	runBuildCommand as runBuildCommandDefault,
	type BuildCommandDependencies,
} from './build-command.js';

const createdDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-build-command-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function writeFakeImageAssets(imagePath: string, contentPrefix: string): Promise<void> {
	await writeImageArtifactFixture(imagePath, contentPrefix);
}

function createSharedToolVmSystemConfig(options: {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
	readonly toolProfileNames: readonly string[];
}): LoadedSystemConfig {
	const baseConfig = createTestSystemConfigInput();
	return createLoadedSystemConfig(
		{
			...baseConfig,
			storageRootDir: path.join(path.dirname(options.cacheDirectory), 'deployment'),
			imageProfiles: {
				gateways: {
					hermes: {
						type: 'hermes',
						buildConfig: path.join(
							path.dirname(options.buildConfigPath),
							'gateway-build-config.json',
						),
					},
				},
				toolVms: Object.fromEntries(
					options.toolProfileNames.map((profileName) => [
						profileName,
						{ type: 'toolVm', buildConfig: options.buildConfigPath },
					]),
				),
			},
			toolVmProfiles: Object.fromEntries([
				[
					'standard',
					{
						cpus: 1,
						imageProfile: options.toolProfileNames[0] ?? 'default',
						memory: '1G',
					},
				],
				...options.toolProfileNames.slice(1).map((profileName) => [
					profileName,
					{
						cpus: 2,
						imageProfile: profileName,
						memory: '2G',
					},
				]),
			]),
		},
		{ systemConfigPath: path.join(path.dirname(options.buildConfigPath), 'system.json') },
	);
}

function createTestSystemConfigInput(): SystemConfigInput {
	const testRoot = createTemporaryDirectory();
	const gatewayBuildConfigPath = path.join(
		testRoot,
		'vm-images',
		'gateways',
		'hermes',
		'build-config.json',
	);
	const gatewayDockerfilePath = path.join(
		testRoot,
		'vm-images',
		'gateways',
		'hermes',
		'Dockerfile',
	);
	const toolVmBuildConfigPath = path.join(
		testRoot,
		'vm-images',
		'tool-vms',
		'default',
		'build-config.json',
	);
	fs.mkdirSync(path.dirname(gatewayBuildConfigPath), { recursive: true });
	fs.mkdirSync(path.dirname(toolVmBuildConfigPath), { recursive: true });
	fs.writeFileSync(
		gatewayBuildConfigPath,
		JSON.stringify({ arch: 'aarch64', distro: 'alpine', oci: { image: 'gateway:test' } }),
		'utf8',
	);
	fs.writeFileSync(gatewayDockerfilePath, 'FROM scratch\n', 'utf8');
	fs.writeFileSync(
		toolVmBuildConfigPath,
		JSON.stringify({ arch: 'aarch64', distro: 'alpine', oci: { image: 'tool-vm:test' } }),
		'utf8',
	);
	return {
		storageRootDir: path.join(testRoot, 'deployment'),
		host: {
			controllerPort: 18800,
			projectNamespace: 'agent-vm-tests-a1b2c3d4',
			secretsProvider: { type: '1password', tokenSource: { type: 'env' } },
		},
		imageProfiles: {
			gateways: {
				hermes: {
					type: 'hermes',
					buildConfig: gatewayBuildConfigPath,
					dockerfile: gatewayDockerfilePath,
				},
			},
			toolVms: {
				default: {
					type: 'toolVm',
					buildConfig: toolVmBuildConfigPath,
				},
			},
		},
		zones: [
			{
				egressHosts: ['example.com'].map((host) => ({ host, audience: 'gateway' as const })),
				gateway: {
					type: 'hermes',
					imageProfile: 'hermes',
					cpus: 2,
					memory: '2G',
					config: './config/test/hermes.yaml',
					port: 18791,
					profileSecretProjectionsByAgent: {
						main: {
							API_SERVER_KEY: 'API_SERVER_KEY_MAIN',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
						},
					},
					profilesByAgent: { main: 'main' },
				},
				id: 'test-zone',
				agents: [{ id: 'main' }],
				secrets: {
					API_SERVER_KEY: {
						audience: 'gateway',
						injection: 'env',
						source: 'config',
						value: 'test-root-api-server-key',
					},
					API_SERVER_KEY_MAIN: {
						audience: 'gateway',
						envVar: 'API_SERVER_KEY_MAIN',
						injection: 'env',
						source: 'environment',
					},
					DISCORD_BOT_TOKEN: {
						audience: 'gateway',
						envVar: 'DISCORD_BOT_TOKEN',
						injection: 'env',
						source: 'environment',
					},
				},
				defaultToolVmProfile: 'standard',
				agentToolVmProfiles: {},
			},
		],
		toolVmProfiles: {
			standard: {
				cpus: 1,
				imageProfile: 'default',
				memory: '1G',
			},
		},
		tcpPool: { basePort: 19000, size: 5 },
	};
}

function createTestSystemConfig(): LoadedSystemConfig {
	const input = createTestSystemConfigInput();
	return createLoadedSystemConfig(input, {
		systemConfigPath: path.join(path.dirname(input.storageRootDir), 'config', 'system.json'),
	});
}

function createObservabilitySystemConfig(
	options: {
		readonly prepareOnBuild?: boolean;
		readonly stackMode?: 'external' | 'managed';
		readonly zoneEnabled?: boolean;
	} = {},
): LoadedSystemConfig {
	const baseConfig = createTestSystemConfigInput();
	const stackMode = options.stackMode ?? 'managed';
	const zoneEnabled = options.zoneEnabled ?? false;
	const hostObservability =
		stackMode === 'managed'
			? {
					enabled: true as const,
					stack: {
						mode: 'managed' as const,
						scrubbing: { responsibility: 'agent-vm-managed-collector' as const },
					},
					mode: 'collector' as const,
					dataDir: '/observability',
					runner: 'docker-compose' as const,
					...(options.prepareOnBuild === undefined
						? {}
						: { prepareOnBuild: options.prepareOnBuild }),
					retention: {
						metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
						logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
						traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
					},
				}
			: {
					enabled: true as const,
					stack: {
						mode: 'external' as const,
						scrubbing: { responsibility: 'external-collector' as const },
					},
					mode: 'collector' as const,
					...(options.prepareOnBuild === undefined
						? {}
						: { prepareOnBuild: options.prepareOnBuild }),
				};
	return createLoadedSystemConfig(
		{
			...baseConfig,
			host: {
				...baseConfig.host,
				observability: hostObservability,
			},
			zones: baseConfig.zones.map((zone) => ({
				...zone,
				...(zoneEnabled
					? {
							observability: {
								enabled: true,
								services: {
									framework: { traces: true, metrics: true, logs: true },
									toolPortal: { traces: true, metrics: true, logs: true },
								},
							},
						}
					: {}),
			})),
		},
		{ systemConfigPath: '/project/config/system.json' },
	);
}

function createRecordingRunTask(
	outputLines: string[],
): NonNullable<BuildCommandDependencies['runTask']> {
	return async (_title, fn) => {
		await fn({
			interactive: false,
			setOutput: (output) => {
				outputLines.push(typeof output === 'string' ? output : output.message);
			},
			setStatus: () => {},
		});
	};
}

async function runBuildCommand(
	options: Parameters<typeof runBuildCommandDefault>[0],
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	const suppliedBuildManagedVmImage = dependencies.buildManagedVmImage;
	await runBuildCommandDefault(options, {
		computeManagedVmFingerprint: async (fingerprintOptions) =>
			fingerprintOptions.buildConfigPath.includes('/gateways/')
				? '1111111111111111'
				: '2222222222222222',
		resolveDockerRootfsIdentity: async (imageTag) => ({
			architecture: 'arm64',
			layers: [`sha256:test-layer:${imageTag}`],
			os: 'linux',
		}),
		resolveRequiredZigVersion: async () => '0.15.2',
		resolveZigVersion: async () => '0.15.2',
		...dependencies,
		...(suppliedBuildManagedVmImage === undefined
			? {}
			: {
					buildManagedVmImage: async (
						buildOptions: Parameters<
							NonNullable<BuildCommandDependencies['buildManagedVmImage']>
						>[0],
					) => {
						const result = await suppliedBuildManagedVmImage(buildOptions);
						const imagePath = path.join(buildOptions.cacheDir, result.fingerprint);
						await writeFakeImageAssets(imagePath, 'managed');
						return { ...result, imagePath };
					},
				}),
	});
}

describe('runBuildCommand', () => {
	it('selects the fixed sibling boot entry only for managed framework gateways', () => {
		expect(managedGatewayBootProjectionForGatewayType('hermes')).toEqual({
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		});
		expect(managedGatewayBootProjectionForGatewayType('worker')).toBeUndefined();
	});

	it('builds Docker image when dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const systemConfig = createTestSystemConfig();
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildManagedVmImage: async () => ({
				built: true,
				fingerprint: 'aaaaaaaaaaaaaaaa',
				imagePath: '/cache/abc123',
			}),
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
		};

		await runBuildCommand({ systemConfig }, dependencies);

		expect(dockerBuilds).toHaveLength(1);
		expect(dockerBuilds[0]?.dockerfilePath).toBe(
			systemConfig.imageProfiles.gateways.hermes?.dockerfile,
		);
		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:latest');
	});

	it('skips managed host observability preparation when no Hermes zone opted in', async () => {
		const events: string[] = [];
		const prepareObservabilityStack =
			vi.fn<NonNullable<BuildCommandDependencies['prepareObservabilityStack']>>();
		const dependencies: BuildCommandDependencies = {
			runTask: async (title, fn) => {
				events.push(`task:${title}`);
				await fn();
			},
			buildDockerImage: async () => {
				events.push('docker');
			},
			buildManagedVmImage: async () => {
				events.push('gondolin');
				return {
					built: true,
					fingerprint: 'aaaaaaaaaaaaaaaa',
					imagePath: '/cache/abc123',
				};
			},
			prepareObservabilityStack,
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
		};

		await runBuildCommand({ systemConfig: createObservabilitySystemConfig() }, dependencies);

		expect(events.indexOf('task:Observability stack')).toBeGreaterThan(events.indexOf('gondolin'));
		expect(prepareObservabilityStack).not.toHaveBeenCalled();
	});

	it('skips build-time observability when disabled by config', async () => {
		const prepareObservabilityStack =
			vi.fn<NonNullable<BuildCommandDependencies['prepareObservabilityStack']>>();
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async () => {},
			buildManagedVmImage: async () => ({
				built: true,
				fingerprint: 'aaaaaaaaaaaaaaaa',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
		};

		await runBuildCommand(
			{ systemConfig: createObservabilitySystemConfig({ prepareOnBuild: false }) },
			dependencies,
		);

		expect(prepareObservabilityStack).not.toHaveBeenCalled();
	});

	it('skips build-time observability for the no-observability escape hatch', async () => {
		const prepareObservabilityStack =
			vi.fn<NonNullable<BuildCommandDependencies['prepareObservabilityStack']>>();
		const outputLines: string[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: createRecordingRunTask(outputLines),
			buildDockerImage: async () => {},
			buildManagedVmImage: async () => ({
				built: true,
				fingerprint: 'aaaaaaaaaaaaaaaa',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
		};

		await runBuildCommand(
			{ systemConfig: createObservabilitySystemConfig(), skipObservability: true },
			dependencies,
		);

		expect(prepareObservabilityStack).not.toHaveBeenCalled();
		expect(outputLines.join('\n')).toContain('observability preparation skipped');
		expect(outputLines.join('\n')).toContain('--no-observability');
	});

	it('reports disabled build-time observability without calling Docker Compose', async () => {
		const prepareObservabilityStack =
			vi.fn<NonNullable<BuildCommandDependencies['prepareObservabilityStack']>>();
		const outputLines: string[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: createRecordingRunTask(outputLines),
			buildDockerImage: async () => {},
			buildManagedVmImage: async () => ({
				built: true,
				fingerprint: 'aaaaaaaaaaaaaaaa',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
		};

		const baseConfig = createTestSystemConfigInput();
		await runBuildCommand(
			{
				systemConfig: createLoadedSystemConfig(
					{
						...baseConfig,
						host: {
							...baseConfig.host,
							observability: { enabled: false },
						},
					},
					{ systemConfigPath: '/project/config/system.json' },
				),
			},
			dependencies,
		);

		expect(prepareObservabilityStack).not.toHaveBeenCalled();
		expect(outputLines.join('\n')).toContain('observability disabled');
	});

	it('reports external build-time observability without calling Docker Compose', async () => {
		const prepareObservabilityStack =
			vi.fn<NonNullable<BuildCommandDependencies['prepareObservabilityStack']>>();
		const outputLines: string[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: createRecordingRunTask(outputLines),
			buildDockerImage: async () => {},
			buildManagedVmImage: async () => ({
				built: true,
				fingerprint: 'aaaaaaaaaaaaaaaa',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
		};

		await runBuildCommand(
			{ systemConfig: createObservabilitySystemConfig({ stackMode: 'external' }) },
			dependencies,
		);

		expect(prepareObservabilityStack).not.toHaveBeenCalled();
		expect(outputLines.join('\n')).toContain('external observability stack');
		expect(outputLines.join('\n')).toContain('not managed by this deployment');
	});

	it('skips Docker build when no dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildManagedVmImage: async () => ({
				built: false,
				fingerprint: 'bbbbbbbbbbbbbbbb',
				imagePath: '/cache/cached',
			}),
			resolveOciImageTag: async () => 'agent-vm-tool:latest',
		};

		await runBuildCommand({ systemConfig: createTestSystemConfig() }, dependencies);

		expect(dockerBuilds).toHaveLength(1);
	});

	it('builds shared Gondolin assets once per image type into the shared cache dir', async () => {
		const systemConfig = createTestSystemConfig();
		const gondolinBuilds: {
			cacheDir: string;
			fullReset: boolean | undefined;
		}[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async () => {},
			buildManagedVmImage: async (options) => {
				gondolinBuilds.push({
					cacheDir: options.cacheDir,
					fullReset: options.fullReset,
				});
				return { built: true, fingerprint: 'cccccccccccccccc', imagePath: '/cache/f1' };
			},
			resolveOciImageTag: async () => 'tag:latest',
		};

		await runBuildCommand({ systemConfig }, dependencies);

		expect(gondolinBuilds).toHaveLength(2);
		expect(gondolinBuilds[0]).toEqual({
			cacheDir: path.join(systemConfig.cacheDir, 'vm-images'),
			fullReset: undefined,
		});
		expect(gondolinBuilds[1]).toEqual({
			cacheDir: path.join(systemConfig.cacheDir, 'vm-images'),
			fullReset: undefined,
		});
	});

	it('uses Docker rootfs identity as fingerprint input for Docker-backed targets', async () => {
		const systemConfig = createTestSystemConfig();
		const fingerprintInputs: {
			fingerprintInput: unknown;
			managedGatewayBoot: unknown;
		}[] = [];
		const gondolinBuilds: {
			cacheDir: string;
			fingerprintInput: unknown;
			fullReset: boolean | undefined;
			managedGatewayBoot: unknown;
		}[] = [];
		const dockerRootfsIdentity = {
			architecture: 'arm64',
			layers: ['sha256:rootfs-a', 'sha256:rootfs-b'],
			os: 'linux',
		};

		await runBuildCommand(
			{ systemConfig },
			{
				buildDockerImage: async () => {},
				buildManagedVmImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fingerprintInput: options.fingerprintInput,
						fullReset: options.fullReset,
						managedGatewayBoot: options.managedGatewayBoot,
					});
					return {
						built: true,
						fingerprint:
							options.managedGatewayBoot === undefined ? '2222222222222222' : '1111111111111111',
						imagePath: '/cache/docker-refresh',
					};
				},
				computeManagedVmFingerprint: async (options) => {
					fingerprintInputs.push({
						fingerprintInput: options.fingerprintInput,
						managedGatewayBoot: options.managedGatewayBoot,
					});
					return options.fingerprintInput === undefined ? '2222222222222222' : '1111111111111111';
				},
				resolveOciImageTag: async () => 'tag:latest',
				resolveDockerRootfsIdentity: async () => dockerRootfsIdentity,
				runTask: async (_title, fn) => await fn(),
			},
		);

		expect(fingerprintInputs).toEqual([
			{
				fingerprintInput: {
					dockerRootfsIdentity,
					schemaVersion: 1,
				},
				managedGatewayBoot: {
					frameworkBootEntry: 'hermes-framework-service',
					kind: 'managed-gateway-exact-two-role',
				},
			},
			{ fingerprintInput: undefined, managedGatewayBoot: undefined },
		]);
		expect(gondolinBuilds).toEqual([
			{
				cacheDir: path.join(systemConfig.cacheDir, 'vm-images'),
				fingerprintInput: {
					dockerRootfsIdentity,
					schemaVersion: 1,
				},
				fullReset: undefined,
				managedGatewayBoot: {
					frameworkBootEntry: 'hermes-framework-service',
					kind: 'managed-gateway-exact-two-role',
				},
			},
			{
				cacheDir: path.join(systemConfig.cacheDir, 'vm-images'),
				fingerprintInput: undefined,
				fullReset: undefined,
				managedGatewayBoot: undefined,
			},
		]);
	});

	it('keeps managed Gateway precomputed and actual image fingerprints aligned', async () => {
		// Arrange
		const temporaryDirectory = createTemporaryDirectory();
		const buildConfigPath = path.join(temporaryDirectory, 'build-config.json');
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({
				arch: 'aarch64',
				distro: 'alpine',
				rootfs: { label: 'shared-root' },
			}),
			'utf8',
		);
		const baseConfig = createTestSystemConfigInput();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				storageRootDir: path.join(path.dirname(cacheDirectory), 'deployment'),
				imageProfiles: {
					gateways: {
						hermes: { type: 'hermes', buildConfig: buildConfigPath },
					},
					toolVms: {
						default: { type: 'toolVm', buildConfig: buildConfigPath },
					},
				},
			},
			{ systemConfigPath: path.join(temporaryDirectory, 'config', 'system.json') },
		);
		const observedFingerprints: string[] = [];

		// Act
		await runBuildCommandDefault(
			{ systemConfig },
			{
				buildManagedVmImage: async (options) => {
					const fingerprint = await computeFingerprintFromConfigPath(
						options.buildConfigPath,
						options.managedGatewayBoot === undefined
							? {}
							: { managedGatewayBoot: options.managedGatewayBoot },
					);
					const imagePath = path.join(options.cacheDir, fingerprint);
					await writeImageArtifactFixture(imagePath, 'managed-boot-fingerprint');
					observedFingerprints.push(fingerprint);
					return { built: true, fingerprint, imagePath };
				},
				resolveRequiredZigVersion: async () => '0.15.2',
				resolveZigVersion: async () => '0.15.2',
				runTask: async (_title, fn) => await fn(),
			},
		);

		// Assert
		expect(observedFingerprints).toHaveLength(2);
		expect(new Set(observedFingerprints).size).toBe(2);
	});

	it('reuses the same shared Gondolin cache directories across multiple zones', async () => {
		const gondolinBuilds: { cacheDir: string }[] = [];
		const baseConfig = createTestSystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const multiZoneConfig: LoadedSystemConfig = {
			...baseConfig,
			zones: [
				{
					...baseZone,
					gateway: {
						...baseZone.gateway,
						stateDir: '/state/zone-a',
					},
					id: 'zone-a',
				},
				{
					...baseZone,
					gateway: {
						...baseZone.gateway,
						stateDir: '/state/zone-b',
					},
					id: 'zone-b',
				},
			],
		};
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async () => {},
			buildManagedVmImage: async (options) => {
				gondolinBuilds.push({ cacheDir: options.cacheDir });
				return { built: true, fingerprint: '3333333333333333', imagePath: '/cache/zone-fp' };
			},
			resolveOciImageTag: async () => 'tag:latest',
		};

		await runBuildCommand({ systemConfig: multiZoneConfig }, dependencies);

		expect(gondolinBuilds).toHaveLength(2);
		expect(gondolinBuilds.map((build) => build.cacheDir)).toEqual([
			path.join(multiZoneConfig.cacheDir, 'vm-images'),
			path.join(multiZoneConfig.cacheDir, 'vm-images'),
		]);
	});

	it('dedupes Gondolin builds for image profiles with identical effective fingerprints', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const configDirectory = path.join(temporaryDirectory, 'config');
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const buildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'tool-vms',
			'shared',
			'build-config.jsonc',
		);
		const gatewayBuildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'gateways',
			'hermes',
			'build-config.jsonc',
		);
		fs.mkdirSync(path.dirname(buildConfigPath), { recursive: true });
		fs.mkdirSync(path.dirname(gatewayBuildConfigPath), { recursive: true });
		fs.mkdirSync(configDirectory, { recursive: true });
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({
				arch: 'aarch64',
				distro: 'alpine',
				rootfs: {
					label: 'tool-root',
					sizeMb: 2048,
				},
			}),
			'utf8',
		);
		fs.writeFileSync(
			gatewayBuildConfigPath,
			JSON.stringify({
				arch: 'aarch64',
				distro: 'alpine',
				rootfs: {
					label: 'gateway-root',
					sizeMb: 4096,
				},
			}),
			'utf8',
		);
		const baseConfig = createTestSystemConfigInput();
		const toolProfileNames = ['default', 'shravan', 'alevtina', 'sun'] as const;
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				storageRootDir: path.join(path.dirname(cacheDirectory), 'deployment'),
				imageProfiles: {
					gateways: {
						hermes: {
							type: 'hermes',
							buildConfig: gatewayBuildConfigPath,
						},
					},
					toolVms: Object.fromEntries(
						toolProfileNames.map((profileName) => [
							profileName,
							{
								type: 'toolVm',
								buildConfig: buildConfigPath,
							},
						]),
					),
				},
				toolVmProfiles: Object.fromEntries([
					[
						'standard',
						{
							cpus: 1,
							imageProfile: 'default',
							memory: '1G',
						},
					],
					...toolProfileNames
						.filter((profileName) => profileName !== 'default')
						.map((profileName) => [
							profileName,
							{
								cpus: 2,
								imageProfile: profileName,
								memory: '2G',
							},
						]),
				]),
			},
			{ systemConfigPath: path.join(configDirectory, 'system.json') },
		);
		const runtimeBuildVersionTag = 'runtime@dedupe-test';
		const builtFingerprint = await computeFingerprintFromConfigPath(buildConfigPath, {
			resolveRuntimeBuildVersionTag: async () => runtimeBuildVersionTag,
		});
		const gondolinBuilds: { cacheDir: string; fullReset: boolean | undefined }[] = [];
		const fingerprintComputations: string[] = [];
		const writeFakeAssets = writeImageArtifactFixture;

		await runBuildCommand(
			{
				systemConfig,
			},
			{
				buildManagedVmImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fullReset: options.fullReset,
					});
					const fingerprint =
						options.buildConfigPath === gatewayBuildConfigPath
							? '4444444444444444'
							: builtFingerprint;
					const imagePath = path.join(options.cacheDir, fingerprint);
					await writeFakeAssets(imagePath);
					return { built: true, fingerprint, imagePath };
				},
				computeManagedVmFingerprint: async (options) => {
					fingerprintComputations.push(options.buildConfigPath);
					return options.buildConfigPath === gatewayBuildConfigPath
						? '4444444444444444'
						: builtFingerprint;
				},
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(fingerprintComputations).toEqual([gatewayBuildConfigPath, buildConfigPath]);
		expect(gondolinBuilds).toEqual([
			{
				cacheDir: path.join(cacheDirectory, 'vm-images'),
				fullReset: undefined,
			},
			{
				cacheDir: path.join(cacheDirectory, 'vm-images'),
				fullReset: undefined,
			},
		]);
		const sharedImagePath = path.join(cacheDirectory, 'vm-images', builtFingerprint);
		for (const fileName of buildImageAssetFileNames) {
			expect(fs.existsSync(path.join(sharedImagePath, fileName))).toBe(true);
		}
	});

	it('rejects Gondolin builds whose result fingerprint differs from the precomputed fingerprint', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const buildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'shared',
			'build-config.jsonc',
		);
		const systemConfig = createSharedToolVmSystemConfig({
			buildConfigPath,
			cacheDirectory,
			toolProfileNames: ['default', 'sun'],
		});

		await expect(
			runBuildCommand(
				{ systemConfig },
				{
					buildManagedVmImage: async (options) => {
						const fingerprint = options.buildConfigPath.includes('gateway-build-config')
							? '4444444444444444'
							: '5555555555555555';
						return {
							built: true,
							fingerprint,
							imagePath: path.join(options.cacheDir, fingerprint),
						};
					},
					computeManagedVmFingerprint: async (options) =>
						options.buildConfigPath.includes('gateway-build-config')
							? '4444444444444444'
							: '6666666666666666',
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toThrow(
			"Fingerprint mismatch for image profile 'toolVm/default': precomputed '6666666666666666' but build returned '5555555555555555'.",
		);
	});

	it('dedupes identical fingerprints across different build config paths', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const configDirectory = path.join(temporaryDirectory, 'config');
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const firstBuildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'tool-vms',
			'first',
			'build-config.jsonc',
		);
		const secondBuildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'tool-vms',
			'second',
			'build-config.jsonc',
		);
		const gatewayBuildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'gateways',
			'hermes',
			'build-config.jsonc',
		);
		fs.mkdirSync(path.dirname(firstBuildConfigPath), { recursive: true });
		fs.mkdirSync(path.dirname(secondBuildConfigPath), { recursive: true });
		fs.mkdirSync(path.dirname(gatewayBuildConfigPath), { recursive: true });
		fs.mkdirSync(configDirectory, { recursive: true });
		const sharedBuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			postBuild: {
				copy: [{ src: './sidecar.txt', dest: '/etc/sidecar.txt' }],
			},
			rootfs: {
				label: 'tool-root',
				sizeMb: 2048,
			},
		};
		fs.writeFileSync(firstBuildConfigPath, JSON.stringify(sharedBuildConfig), 'utf8');
		fs.writeFileSync(secondBuildConfigPath, JSON.stringify(sharedBuildConfig), 'utf8');
		fs.writeFileSync(
			path.join(path.dirname(firstBuildConfigPath), 'sidecar.txt'),
			'first\n',
			'utf8',
		);
		fs.writeFileSync(
			path.join(path.dirname(secondBuildConfigPath), 'sidecar.txt'),
			'second\n',
			'utf8',
		);
		fs.writeFileSync(
			gatewayBuildConfigPath,
			JSON.stringify({
				arch: 'aarch64',
				distro: 'alpine',
				rootfs: { label: 'gateway-root', sizeMb: 4096 },
			}),
			'utf8',
		);
		const baseConfig = createTestSystemConfigInput();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				storageRootDir: path.join(path.dirname(cacheDirectory), 'deployment'),
				imageProfiles: {
					gateways: {
						hermes: {
							type: 'hermes',
							buildConfig: gatewayBuildConfigPath,
						},
					},
					toolVms: {
						first: { type: 'toolVm', buildConfig: firstBuildConfigPath },
						second: { type: 'toolVm', buildConfig: secondBuildConfigPath },
					},
				},
				toolVmProfiles: {
					standard: { cpus: 1, imageProfile: 'first', memory: '1G' },
					second: { cpus: 2, imageProfile: 'second', memory: '2G' },
				},
			},
			{ systemConfigPath: path.join(configDirectory, 'system.json') },
		);
		const gondolinBuilds: string[] = [];

		await runBuildCommand(
			{ systemConfig },
			{
				buildManagedVmImage: async (options) => {
					gondolinBuilds.push(options.cacheDir);
					const fingerprint =
						options.buildConfigPath === gatewayBuildConfigPath
							? '4444444444444444'
							: '7777777777777777';
					const imagePath = path.join(options.cacheDir, fingerprint);
					fs.mkdirSync(imagePath, { recursive: true });
					for (const fileName of buildImageAssetFileNames) {
						fs.writeFileSync(
							path.join(imagePath, fileName),
							imageArtifactFixtureFileContent(fileName),
							'utf8',
						);
					}
					return { built: true, fingerprint, imagePath };
				},
				computeManagedVmFingerprint: async (options) =>
					options.buildConfigPath === gatewayBuildConfigPath
						? '4444444444444444'
						: '7777777777777777',
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(gondolinBuilds).toEqual([
			path.join(cacheDirectory, 'vm-images'),
			path.join(cacheDirectory, 'vm-images'),
		]);
	});

	it('dedupes mixed gateway and tool VM targets without forcing reset for Docker-backed profiles', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const configDirectory = path.join(temporaryDirectory, 'config');
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const sharedImageDirectory = path.join(temporaryDirectory, 'vm-images', 'shared');
		const buildConfigPath = path.join(sharedImageDirectory, 'build-config.jsonc');
		const dockerfilePath = path.join(sharedImageDirectory, 'Dockerfile');
		fs.mkdirSync(sharedImageDirectory, { recursive: true });
		fs.mkdirSync(configDirectory, { recursive: true });
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({
				arch: 'aarch64',
				distro: 'alpine',
				rootfs: { label: 'shared-root', sizeMb: 2048 },
			}),
			'utf8',
		);
		fs.writeFileSync(dockerfilePath, 'FROM scratch\n');
		const baseConfig = createTestSystemConfigInput();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				storageRootDir: path.join(path.dirname(cacheDirectory), 'deployment'),
				imageProfiles: {
					gateways: {
						hermes: {
							type: 'hermes',
							buildConfig: buildConfigPath,
							dockerfile: dockerfilePath,
						},
					},
					toolVms: {
						default: { type: 'toolVm', buildConfig: buildConfigPath },
					},
				},
				toolVmProfiles: {
					standard: { cpus: 1, imageProfile: 'default', memory: '1G' },
				},
			},
			{ systemConfigPath: path.join(configDirectory, 'system.json') },
		);
		const sharedFingerprint = '8888888888888888';
		const dockerBuilds: string[] = [];
		const gondolinBuilds: { cacheDir: string; fullReset: boolean | undefined }[] = [];

		await runBuildCommand(
			{ systemConfig },
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options.imageTag);
				},
				buildManagedVmImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fullReset: options.fullReset,
					});
					const imagePath = path.join(options.cacheDir, sharedFingerprint);
					fs.mkdirSync(imagePath, { recursive: true });
					for (const fileName of buildImageAssetFileNames) {
						fs.writeFileSync(
							path.join(imagePath, fileName),
							imageArtifactFixtureFileContent(fileName),
							'utf8',
						);
					}
					return { built: true, fingerprint: sharedFingerprint, imagePath };
				},
				computeManagedVmFingerprint: async () => sharedFingerprint,
				resolveOciImageTag: async () => 'agent-vm-shared:latest',
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(dockerBuilds).toEqual(['agent-vm-shared:latest']);
		expect(gondolinBuilds).toEqual([
			{
				cacheDir: path.join(cacheDirectory, 'vm-images'),
				fullReset: undefined,
			},
		]);
		for (const imagePath of [path.join(cacheDirectory, 'vm-images', sharedFingerprint)]) {
			for (const fileName of buildImageAssetFileNames) {
				expect(fs.existsSync(path.join(imagePath, fileName))).toBe(true);
			}
		}
	});

	it('builds multiple Docker-backed image targets concurrently before Gondolin asset builds', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayImageDirectory = path.join(temporaryDirectory, 'vm-images', 'gateways', 'hermes');
		const toolVmImageDirectory = path.join(temporaryDirectory, 'vm-images', 'tool-vms', 'default');
		const gatewayDockerfilePath = path.join(gatewayImageDirectory, 'Dockerfile');
		const toolVmDockerfilePath = path.join(toolVmImageDirectory, 'Dockerfile');
		const gatewayBuildConfigPath = path.join(gatewayImageDirectory, 'build-config.json');
		const toolVmBuildConfigPath = path.join(toolVmImageDirectory, 'build-config.json');
		fs.mkdirSync(gatewayImageDirectory, { recursive: true });
		fs.mkdirSync(toolVmImageDirectory, { recursive: true });
		fs.writeFileSync(gatewayDockerfilePath, 'FROM scratch\n', 'utf8');
		fs.writeFileSync(toolVmDockerfilePath, 'FROM scratch\n', 'utf8');
		fs.writeFileSync(gatewayBuildConfigPath, JSON.stringify({ arch: 'aarch64', distro: 'alpine' }));
		fs.writeFileSync(toolVmBuildConfigPath, JSON.stringify({ arch: 'aarch64', distro: 'alpine' }));

		const baseConfig = createTestSystemConfigInput();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				storageRootDir: temporaryDirectory,
				imageProfiles: {
					gateways: {
						hermes: {
							type: 'hermes',
							buildConfig: gatewayBuildConfigPath,
							dockerfile: gatewayDockerfilePath,
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: toolVmBuildConfigPath,
							dockerfile: toolVmDockerfilePath,
						},
					},
				},
			},
			{ systemConfigPath: path.join(temporaryDirectory, 'config', 'system.json') },
		);
		let activeDockerBuilds = 0;
		let maxActiveDockerBuilds = 0;
		const dockerBuildStarts: string[] = [];

		await runBuildCommand(
			{ systemConfig },
			{
				buildDockerImage: async (options) => {
					activeDockerBuilds += 1;
					maxActiveDockerBuilds = Math.max(maxActiveDockerBuilds, activeDockerBuilds);
					dockerBuildStarts.push(options.imageTag);
					await new Promise<void>((resolve) => setImmediate(resolve));
					activeDockerBuilds -= 1;
				},
				buildManagedVmImage: async (options) => {
					const imagePath = path.join(options.cacheDir, '9999999999999999');
					await writeFakeImageAssets(imagePath, options.cacheDir);
					return {
						built: true,
						fingerprint: '9999999999999999',
						imagePath,
					};
				},
				resolveOciImageTag: async (buildConfigPath) =>
					buildConfigPath.includes('/tool-vms/')
						? 'agent-vm-tool-vm:latest'
						: 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(dockerBuildStarts).toEqual(['agent-vm-gateway:latest', 'agent-vm-tool-vm:latest']);
		expect(maxActiveDockerBuilds).toBe(2);
	});

	it('keeps Docker image tags distinct when gateway and Tool VM profile names match', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayImageDirectory = path.join(temporaryDirectory, 'vm-images', 'gateways', 'default');
		const toolVmImageDirectory = path.join(temporaryDirectory, 'vm-images', 'tool-vms', 'default');
		const gatewayDockerfilePath = path.join(gatewayImageDirectory, 'Dockerfile');
		const toolVmDockerfilePath = path.join(toolVmImageDirectory, 'Dockerfile');
		const gatewayBuildConfigPath = path.join(gatewayImageDirectory, 'build-config.json');
		const toolVmBuildConfigPath = path.join(toolVmImageDirectory, 'build-config.json');
		fs.mkdirSync(gatewayImageDirectory, { recursive: true });
		fs.mkdirSync(toolVmImageDirectory, { recursive: true });
		fs.writeFileSync(gatewayDockerfilePath, 'FROM scratch\n', 'utf8');
		fs.writeFileSync(toolVmDockerfilePath, 'FROM scratch\n', 'utf8');
		fs.writeFileSync(gatewayBuildConfigPath, JSON.stringify({ arch: 'aarch64', distro: 'alpine' }));
		fs.writeFileSync(toolVmBuildConfigPath, JSON.stringify({ arch: 'aarch64', distro: 'alpine' }));

		const baseConfig = createTestSystemConfigInput();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				storageRootDir: temporaryDirectory,
				imageProfiles: {
					gateways: {
						default: {
							type: 'hermes',
							buildConfig: gatewayBuildConfigPath,
							dockerfile: gatewayDockerfilePath,
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: toolVmBuildConfigPath,
							dockerfile: toolVmDockerfilePath,
						},
					},
				},
				zones: baseConfig.zones.map((zone) => ({
					...zone,
					gateway: {
						...zone.gateway,
						imageProfile: 'default',
					},
				})),
			},
			{ systemConfigPath: path.join(temporaryDirectory, 'config', 'system.json') },
		);
		const dockerBuilds: string[] = [];

		await runBuildCommand(
			{ systemConfig },
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options.imageTag);
				},
				buildManagedVmImage: async (options) => {
					const imagePath = path.join(options.cacheDir, '9999999999999999');
					await writeFakeImageAssets(imagePath, options.cacheDir);
					return {
						built: true,
						fingerprint: '9999999999999999',
						imagePath,
					};
				},
				resolveOciImageTag: async (buildConfigPath) =>
					buildConfigPath.includes('/tool-vms/')
						? 'agent-vm-tool-default:latest'
						: 'agent-vm-gateway-default:latest',
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(dockerBuilds).toEqual([
			'agent-vm-gateway-default:latest',
			'agent-vm-tool-default:latest',
		]);
	});

	it('passes fullReset to shared Gondolin builds when forceRebuild is enabled', async () => {
		const gondolinBuilds: { cacheDir: string; fullReset: boolean | undefined }[] = [];
		const taskTitles: string[] = [];
		const systemConfig = createTestSystemConfig();

		await runBuildCommand(
			{
				forceRebuild: true,
				systemConfig,
			},
			{
				buildDockerImage: async () => {},
				buildManagedVmImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fullReset: options.fullReset,
					});
					return { built: true, fingerprint: 'aaaaaaaaaaaaaaa1', imagePath: '/cache/force-fp' };
				},
				resolveOciImageTag: async () => 'tag:latest',
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
			},
		);

		expect(gondolinBuilds).toEqual([
			{ cacheDir: path.join(systemConfig.cacheDir, 'vm-images'), fullReset: true },
			{ cacheDir: path.join(systemConfig.cacheDir, 'vm-images'), fullReset: true },
		]);
		expect(taskTitles).toContain('Gondolin: gateway/hermes');
		expect(taskTitles).toContain('Gondolin: toolVm/default');
	});

	it('keeps interactive build task output compact while deriving Gondolin phase status', async () => {
		const taskStreamPreview = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const dockerBuildOptions: {
			readonly quiet: boolean | undefined;
			readonly streamPreview: unknown;
		}[] = [];
		const gondolinStreamPreviews: unknown[] = [];
		const taskStatuses: (string | undefined)[] = [];
		const taskOutputLines: string[] = [];

		await runBuildCommand(
			{
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async (options) => {
					dockerBuildOptions.push({
						quiet: options.quiet,
						streamPreview: options.streamPreview,
					});
					options.streamPreview?.write('#1 [internal] load build definition\n');
					options.streamPreview?.write(
						'View build details: docker-desktop://dashboard/build/orbstack/orbstack/test-build\n',
					);
				},
				buildManagedVmImage: async (options) => {
					gondolinStreamPreviews.push(options.streamPreview);
					options.streamPreview?.write(
						'Extracting OCI rootfs from agent-vm-gateway:latest (docker)...\n',
					);
					options.streamPreview?.write('Creating rootfs ext4 image...\n');
					return { built: true, fingerprint: 'aaaaaaaaaaaaaaa2', imagePath: '/cache/interactive' };
				},
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: true,
						setOutput: (output) => {
							taskOutputLines.push(typeof output === 'string' ? output : output.message);
						},
						setStatus: (status) => {
							taskStatuses.push(status);
						},
						streamPreview: taskStreamPreview,
					});
				},
			},
		);

		expect(dockerBuildOptions).toEqual([{ quiet: true, streamPreview: expect.any(Object) }]);
		expect(gondolinStreamPreviews).toEqual([expect.any(Object), expect.any(Object)]);
		expect(taskStatuses).toContain('docker build');
		expect(taskStatuses).toContain('docker image ready');
		expect(taskStatuses).toContain('checking vm assets');
		expect(taskStatuses).toContain('extracting OCI rootfs · 1s elapsed');
		expect(taskStatuses).toContain('creating rootfs image · 1s elapsed');
		expect(taskStatuses).toContain('vm assets ready');
		expect(taskOutputLines[0]).toBe('dockerfile Dockerfile');
		expect(taskOutputLines.at(-1)).toContain('View build details: docker-desktop://');
		expect(taskOutputLines.every((line) => !line.includes('\n'))).toBe(true);
	});

	it('keeps Gondolin task status alive while VM assets are building quietly', async () => {
		vi.useFakeTimers();
		const taskStatuses: (string | undefined)[] = [];
		let finishGondolinBuild: (() => void) | undefined;
		let signalGondolinBuildStarted: (() => void) | undefined;
		const gondolinBuildStarted = new Promise<void>((resolve) => {
			signalGondolinBuildStarted = resolve;
		});
		const baseSystemConfig = createTestSystemConfig();

		const buildPromise = runBuildCommand(
			{
				forceRebuild: true,
				systemConfig: {
					...baseSystemConfig,
					imageProfiles: {
						gateways: {},
						toolVms: baseSystemConfig.imageProfiles.toolVms,
					},
				},
			},
			{
				buildManagedVmImage: async () => {
					signalGondolinBuildStarted?.();
					await new Promise<void>((resolve) => {
						finishGondolinBuild = resolve;
					});
					return { built: true, fingerprint: 'aaaaaaaaaaaaaaa2', imagePath: '/cache/interactive' };
				},
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: true,
						setOutput: () => {},
						setStatus: (status) => {
							taskStatuses.push(status);
						},
						streamPreview: new Writable({
							write(_chunk, _encoding, callback) {
								callback();
							},
						}),
					});
				},
			},
		);

		await gondolinBuildStarted;
		await vi.advanceTimersByTimeAsync(16_000);
		finishGondolinBuild?.();
		await buildPromise;
		vi.useRealTimers();

		expect(taskStatuses).toContain('building vm assets');
		expect(taskStatuses).toContain('building vm assets · 8s elapsed');
		expect(taskStatuses).toContain('building vm assets · 16s elapsed');
		expect(taskStatuses).toContain('vm assets ready');
	});

	it('shows Gondolin cache-hit status when VM assets are already built', async () => {
		const taskStatuses: (string | undefined)[] = [];
		const baseSystemConfig = createTestSystemConfig();
		const systemConfig = {
			...baseSystemConfig,
			imageProfiles: {
				...baseSystemConfig.imageProfiles,
				gateways: {},
			},
		} satisfies LoadedSystemConfig;

		await runBuildCommand(
			{
				systemConfig,
			},
			{
				buildDockerImage: async () => {},
				buildManagedVmImage: async () => ({
					built: false,
					fingerprint: 'aaaaaaaaaaaaaaa3',
					imagePath: '/cache/cached',
				}),
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: true,
						setOutput: () => {},
						setStatus: (status) => {
							taskStatuses.push(status);
						},
					});
				},
			},
		);

		expect(taskStatuses).toContain('checking vm assets');
		expect(taskStatuses).toContain('vm assets cache hit');
	});

	it('rejects legacy controller record evidence before any build mutation', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const stateDirectory = path.join(temporaryDirectory, 'state', 'test');
		fs.mkdirSync(stateDirectory, { recursive: true });
		fs.writeFileSync(path.join(stateDirectory, 'gateway-runtime.json'), '{}\n', 'utf8');
		const buildDockerImage = vi.fn(async () => {});
		const buildManagedVmImageForLegacyRejection = vi.fn(async () => ({
			built: false,
			fingerprint: 'unreachable',
			imagePath: path.join(temporaryDirectory, 'unreachable'),
		}));
		const systemConfig = createTestSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (!baseZone || baseZone.gateway.type !== 'hermes') {
			throw new Error('Expected a Hermes test zone.');
		}

		await expect(
			runBuildCommand(
				{
					systemConfig: {
						...systemConfig,
						zones: [
							{
								...baseZone,
								gateway: { ...baseZone.gateway, stateDir: stateDirectory },
							},
						],
					},
				},
				{
					buildDockerImage,
					buildManagedVmImage: buildManagedVmImageForLegacyRejection,
					computeManagedVmFingerprint: async () => 'aaaaaaaaaaaaaaa4',
				},
			),
		).rejects.toThrow(
			`Legacy controller record evidence exists under Gateway state for zone 'test-zone': gateway-runtime:file:${path.join(stateDirectory, 'gateway-runtime.json')}`,
		);
		expect(buildDockerImage).not.toHaveBeenCalled();
		expect(buildManagedVmImageForLegacyRejection).not.toHaveBeenCalled();
	});

	it('does not require Zig for the normal published-helper Gondolin path', async () => {
		const dockerBuilds: string[] = [];
		const gondolinBuilds: string[] = [];
		const resolveRequiredZigVersion = vi.fn(async () => '0.15.2');
		const resolveZigVersion = vi.fn(async () => undefined);
		const systemConfig = createTestSystemConfig();

		await runBuildCommandDefault(
			{
				systemConfig,
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options.imageTag);
				},
				buildManagedVmImage: async (options) => {
					gondolinBuilds.push(options.buildConfigPath);
					const fingerprint = 'aaaaaaaaaaaaaaa5';
					const imagePath = path.join(options.cacheDir, fingerprint);
					await writeFakeImageAssets(imagePath, 'zig');
					return { built: true, fingerprint, imagePath };
				},
				computeManagedVmFingerprint: async () => 'aaaaaaaaaaaaaaa5',
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				resolveDockerRootfsIdentity: async () => ({
					architecture: 'arm64',
					layers: ['sha256:test-layer'],
					os: 'linux',
				}),
				resolveRequiredZigVersion,
				resolveZigVersion,
				runTask: async (_title, fn) => {
					await fn();
				},
			},
		);

		expect(resolveRequiredZigVersion).not.toHaveBeenCalled();
		expect(resolveZigVersion).not.toHaveBeenCalled();
		expect(dockerBuilds).toEqual(['agent-vm-gateway:latest']);
		expect(gondolinBuilds).toEqual([systemConfig.imageProfiles.gateways.hermes?.buildConfig]);
	});

	it('fails before image builds when source-built sandbox helpers need Zig and Zig is missing', async () => {
		const dockerBuilds: string[] = [];
		const gondolinBuilds: string[] = [];
		const originalBuildHelpersFromSource = process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE;
		process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE = '1';

		try {
			await expect(
				runBuildCommandDefault(
					{
						systemConfig: createTestSystemConfig(),
					},
					{
						buildDockerImage: async (options) => {
							dockerBuilds.push(options.imageTag);
						},
						buildManagedVmImage: async (options) => {
							gondolinBuilds.push(options.buildConfigPath);
							return { built: true, fingerprint: 'aaaaaaaaaaaaaaa5', imagePath: '/cache/zig' };
						},
						resolveRequiredZigVersion: async () => '0.15.2',
						resolveZigVersion: async () => undefined,
						runTask: async (_title, fn) => {
							await fn();
						},
					},
				),
			).rejects.toThrow('Install Zig >= 0.15.2. On macOS: brew install zig.');
		} finally {
			if (originalBuildHelpersFromSource === undefined) {
				delete process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE;
			} else {
				process.env.GONDOLIN_BUILD_SANDBOX_HELPERS_FROM_SOURCE = originalBuildHelpersFromSource;
			}
		}

		expect(dockerBuilds).toEqual([]);
		expect(gondolinBuilds).toEqual([]);
	});
});

describe('resolveOciImageTagFromConfig', () => {
	it('reads the oci.image tag from build-config.json', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayBuildConfigPath = path.join(temporaryDirectory, 'gateway-build-config.json');
		fs.writeFileSync(
			gatewayBuildConfigPath,
			JSON.stringify({
				oci: {
					image: 'agent-vm-gateway:latest',
				},
			}),
			'utf8',
		);
		const dockerBuilds: { imageTag: string }[] = [];

		await runBuildCommand(
			{
				systemConfig: {
					...createTestSystemConfig(),
					imageProfiles: {
						...createTestSystemConfig().imageProfiles,
						gateways: {
							...createTestSystemConfig().imageProfiles.gateways,
							hermes: {
								type: 'hermes',
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/vm-images/gateways/hermes/Dockerfile',
							},
						},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push({ imageTag: options.imageTag });
				},
				buildManagedVmImage: async () => ({
					built: true,
					fingerprint: 'aaaaaaaaaaaaaaa6',
					imagePath: '/cache/fp',
				}),
				computeManagedVmFingerprint: async () => 'aaaaaaaaaaaaaaa6',
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:latest');
	});

	it('reads the oci.image tag from build-config.jsonc', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayBuildConfigPath = path.join(temporaryDirectory, 'gateway-build-config.jsonc');
		fs.writeFileSync(
			gatewayBuildConfigPath,
			[
				'{',
				'  // Human-authored image tag',
				'  "oci": {',
				'    "image": "agent-vm-gateway:jsonc",',
				'  },',
				'}',
			].join('\n'),
			'utf8',
		);
		const dockerBuilds: { imageTag: string }[] = [];

		await runBuildCommand(
			{
				systemConfig: {
					...createTestSystemConfig(),
					imageProfiles: {
						...createTestSystemConfig().imageProfiles,
						gateways: {
							...createTestSystemConfig().imageProfiles.gateways,
							hermes: {
								type: 'hermes',
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/vm-images/gateways/hermes/Dockerfile',
							},
						},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push({ imageTag: options.imageTag });
				},
				buildManagedVmImage: async () => ({
					built: true,
					fingerprint: 'aaaaaaaaaaaaaaa6',
					imagePath: '/cache/fp',
				}),
				computeManagedVmFingerprint: async () => 'aaaaaaaaaaaaaaa6',
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:jsonc');
	});

	it('throws when build-config.json is missing oci.image', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayBuildConfigPath = path.join(temporaryDirectory, 'gateway-build-config.json');
		fs.writeFileSync(gatewayBuildConfigPath, JSON.stringify({ oci: {} }), 'utf8');

		await expect(
			runBuildCommand(
				{
					systemConfig: {
						...createTestSystemConfig(),
						imageProfiles: {
							...createTestSystemConfig().imageProfiles,
							gateways: {
								...createTestSystemConfig().imageProfiles.gateways,
								hermes: {
									type: 'hermes',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/hermes/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildManagedVmImage: async () => ({
						built: true,
						fingerprint: 'aaaaaaaaaaaaaaa6',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toThrow(
			[
				`Invalid build-config.json at ${gatewayBuildConfigPath}:`,
				'  oci.image: Invalid input: expected string, received undefined',
			].join('\n'),
		);
	});

	it('throws when oci.image is an empty string', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayBuildConfigPath = path.join(temporaryDirectory, 'gateway-build-config.json');
		fs.writeFileSync(
			gatewayBuildConfigPath,
			JSON.stringify({
				oci: {
					image: '',
				},
			}),
			'utf8',
		);

		await expect(
			runBuildCommand(
				{
					systemConfig: {
						...createTestSystemConfig(),
						imageProfiles: {
							...createTestSystemConfig().imageProfiles,
							gateways: {
								...createTestSystemConfig().imageProfiles.gateways,
								hermes: {
									type: 'hermes',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/hermes/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildManagedVmImage: async () => ({
						built: true,
						fingerprint: 'aaaaaaaaaaaaaaa6',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toThrow(
			[
				`Invalid build-config.json at ${gatewayBuildConfigPath}:`,
				'  oci.image: Too small: expected string to have >=1 characters',
			].join('\n'),
		);
	});

	it('throws when a Docker-backed profile build config is missing', async () => {
		const missingBuildConfigPath = path.join(
			createTemporaryDirectory(),
			'missing-build-config.json',
		);

		await expect(
			runBuildCommand(
				{
					systemConfig: {
						...createTestSystemConfig(),
						imageProfiles: {
							...createTestSystemConfig().imageProfiles,
							gateways: {
								...createTestSystemConfig().imageProfiles.gateways,
								hermes: {
									type: 'hermes',
									buildConfig: missingBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/hermes/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildManagedVmImage: async () => ({
						built: true,
						fingerprint: 'aaaaaaaaaaaaaaa6',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toThrow(/ENOENT|no such file or directory/u);
	});

	it('throws when build-config.json is malformed JSON', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayBuildConfigPath = path.join(temporaryDirectory, 'gateway-build-config.json');
		fs.writeFileSync(gatewayBuildConfigPath, '{"oci":', 'utf8');

		await expect(
			runBuildCommand(
				{
					systemConfig: {
						...createTestSystemConfig(),
						imageProfiles: {
							...createTestSystemConfig().imageProfiles,
							gateways: {
								...createTestSystemConfig().imageProfiles.gateways,
								hermes: {
									type: 'hermes',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/hermes/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildManagedVmImage: async () => ({
						built: true,
						fingerprint: 'aaaaaaaaaaaaaaa6',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toThrow();
	});

	it('formats invalid build-config schema errors clearly', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayBuildConfigPath = path.join(temporaryDirectory, 'gateway-build-config.json');
		fs.writeFileSync(gatewayBuildConfigPath, JSON.stringify({ oci: {} }), 'utf8');

		await expect(
			runBuildCommand(
				{
					systemConfig: {
						...createTestSystemConfig(),
						imageProfiles: {
							...createTestSystemConfig().imageProfiles,
							gateways: {
								...createTestSystemConfig().imageProfiles.gateways,
								hermes: {
									type: 'hermes',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/hermes/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildManagedVmImage: async () => ({
						built: true,
						fingerprint: 'aaaaaaaaaaaaaaa6',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toThrow(
			[
				`Invalid build-config.json at ${gatewayBuildConfigPath}:`,
				'  oci.image: Invalid input: expected string, received undefined',
			].join('\n'),
		);
	});
});
