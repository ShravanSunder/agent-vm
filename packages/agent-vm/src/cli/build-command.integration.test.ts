import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { buildImageAssetFileNames } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	buildGondolinImage,
	computeFingerprintFromConfigPath,
} from '../build/gondolin-image-builder.js';
import type { ManagedImageRelease } from '../build/managed-image-dockerfile.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
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

function createFileSystemError(code: string, message: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function writeFakeImageAssets(imagePath: string, contentPrefix: string): void {
	fs.mkdirSync(imagePath, { recursive: true });
	for (const fileName of buildImageAssetFileNames) {
		fs.writeFileSync(path.join(imagePath, fileName), `${contentPrefix}:${fileName}\n`, 'utf8');
	}
}

interface PackageJson {
	readonly version?: unknown;
}

function readOpenClawAgentVmPluginVersion(): string {
	const packageJsonPath = path.join(
		process.cwd(),
		'packages',
		'openclaw-agent-vm-plugin',
		'package.json',
	);
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
	if (typeof packageJson.version !== 'string') {
		throw new Error(`Missing package version in ${packageJsonPath}.`);
	}
	return packageJson.version;
}

function createSharedToolVmSystemConfig(options: {
	readonly buildConfigPath: string;
	readonly cacheDirectory: string;
	readonly toolProfileNames: readonly string[];
}): LoadedSystemConfig {
	const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
	return createLoadedSystemConfig(
		{
			...baseConfig,
			cacheDir: options.cacheDirectory,
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
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

function createTestManagedImageRelease(): ManagedImageRelease {
	return {
		baseImages: {
			'openclaw-gateway': {
				packageOverrides: {
					npm: ['@openai/codex@0.139.0'],
					openclaw: ['openclaw@2026.6.8', '@openclaw/codex@2026.6.8'],
					pnpm: { undici: '8.5.0' },
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base',
				tag: '2026.05.27.1',
			},
			'worker-gateway': {
				packageOverrides: {
					npm: ['@openai/codex@0.139.0'],
					openclaw: [],
					pnpm: {},
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-worker-gateway-base',
				tag: '2026.05.27.1',
			},
			'tool-vm': {
				packageOverrides: {
					npm: [],
					openclaw: [],
					pnpm: {},
				},
				repository: 'ghcr.io/shravansunder/agent-vm-managed-tool-vm-base',
				tag: '2026.05.27.1',
			},
		},
	};
}

function createTestSystemConfig(): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: '/cache',
			runtimeDir: '/runtime',
			host: {
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				secretsProvider: { type: '1password', tokenSource: { type: 'env' } },
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: '/project/vm-images/gateways/openclaw/build-config.json',
						dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: '/project/vm-images/tool-vms/default/build-config.json',
					},
				},
			},
			zones: [
				{
					egressHosts: ['example.com'].map((host) => ({ host, audience: 'gateway' as const })),
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: './config/test/openclaw.json',
						port: 18791,
						stateDir: '/state/test',
						zoneFilesDir: '/zone-files/test',
					},
					id: 'test-zone',
					agents: [{ id: 'main' }],
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
		},
		{ systemConfigPath: '/project/config/system.json' },
	);
}

function createObservabilitySystemConfig(
	options: {
		readonly prepareOnBuild?: boolean;
		readonly stackMode?: 'external' | 'managed';
		readonly zoneEnabled?: boolean;
	} = {},
): LoadedSystemConfig {
	const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
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
								openclaw: {
									serviceName: `agent-vm-openclaw-${zone.id}`,
									traces: true,
									metrics: true,
									logs: true,
								},
							},
						}
					: {}),
			})),
		},
		{ systemConfigPath: '/project/config/system.json' },
	);
}

const noOpPluginSync: NonNullable<
	BuildCommandDependencies['syncBundledOpenClawPlugin']
> = async () => 'created';

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
	await runBuildCommandDefault(options, {
		computeGondolinFingerprint: async (fingerprintOptions) =>
			`test-fingerprint:${fingerprintOptions.buildConfigPath}`,
		resolveDockerRootfsIdentity: async (imageTag) => ({
			architecture: 'arm64',
			layers: [`sha256:test-layer:${imageTag}`],
			os: 'linux',
		}),
		resolveRequiredZigVersion: async () => '0.15.2',
		resolveZigVersion: async () => '0.15.2',
		...dependencies,
	});
}

describe('runBuildCommand', () => {
	it('builds Docker image when dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const pluginSyncs: string[] = [];
		const resolvedProjectRoots: string[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildGondolinImage: async () => ({
				built: true,
				fingerprint: 'abc123',
				imagePath: '/cache/abc123',
			}),
			resolveProjectRootFromDockerfile: async (dockerfilePath) => {
				resolvedProjectRoots.push(dockerfilePath);
				return '/project';
			},
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
			syncBundledOpenClawPlugin: async (targetDir) => {
				pluginSyncs.push(targetDir);
				return 'created';
			},
		};

		await runBuildCommand({ systemConfig: createTestSystemConfig() }, dependencies);

		expect(dockerBuilds).toHaveLength(1);
		expect(dockerBuilds[0]?.dockerfilePath).toBe('/project/vm-images/gateways/openclaw/Dockerfile');
		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:latest');
		expect(resolvedProjectRoots).toEqual(['/project/vm-images/gateways/openclaw/Dockerfile']);
		expect(pluginSyncs).toEqual(['/project']);
	});

	it('skips managed host observability preparation when no OpenClaw zone opted in', async () => {
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
			buildGondolinImage: async () => {
				events.push('gondolin');
				return {
					built: true,
					fingerprint: 'abc123',
					imagePath: '/cache/abc123',
				};
			},
			prepareObservabilityStack,
			resolveProjectRootFromDockerfile: async () => '/project',
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
			findPrunableImageDirectories: async () => [],
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
			buildGondolinImage: async () => ({
				built: true,
				fingerprint: 'abc123',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveProjectRootFromDockerfile: async () => '/project',
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
			findPrunableImageDirectories: async () => [],
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
			buildGondolinImage: async () => ({
				built: true,
				fingerprint: 'abc123',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveProjectRootFromDockerfile: async () => '/project',
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
			findPrunableImageDirectories: async () => [],
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
			buildGondolinImage: async () => ({
				built: true,
				fingerprint: 'abc123',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveProjectRootFromDockerfile: async () => '/project',
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
			findPrunableImageDirectories: async () => [],
		};

		const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
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
			buildGondolinImage: async () => ({
				built: true,
				fingerprint: 'abc123',
				imagePath: '/cache/abc123',
			}),
			prepareObservabilityStack,
			resolveProjectRootFromDockerfile: async () => '/project',
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
			findPrunableImageDirectories: async () => [],
		};

		await runBuildCommand(
			{ systemConfig: createObservabilitySystemConfig({ stackMode: 'external' }) },
			dependencies,
		);

		expect(prepareObservabilityStack).not.toHaveBeenCalled();
		expect(outputLines.join('\n')).toContain('external observability stack');
		expect(outputLines.join('\n')).toContain('not managed by this deployment');
	});

	it('builds Docker image from a managed base profile', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		fs.writeFileSync(
			overlayPath,
			JSON.stringify({
				schemaVersion: 1,
				extraAptPackages: ['ca-certificates'],
				packageOverrides: {
					openclaw: ['@openclaw/discord@2026.5.7'],
				},
				copy: [{ from: 'certs/strip-nonascii-certs.py', to: '/tmp/strip-nonascii-certs.py' }],
				runAfterBase: ['python3 /tmp/strip-nonascii-certs.py'],
			}),
			'utf8',
		);
		fs.mkdirSync(path.join(temporaryDirectory, 'certs'));
		fs.writeFileSync(path.join(temporaryDirectory, 'certs', 'strip-nonascii-certs.py'), 'pass\n');
		const gatewayConfigDirectory = path.join(temporaryDirectory, 'config', 'test');
		fs.mkdirSync(gatewayConfigDirectory, { recursive: true });
		const gatewayConfigPath = path.join(gatewayConfigDirectory, 'openclaw.json');
		fs.writeFileSync(gatewayConfigPath, JSON.stringify({ channels: {} }), 'utf8');
		const buildConfigPath = path.join(temporaryDirectory, 'build-config.json');
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-gateway:managed' } }),
			'utf8',
		);
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];

		await runBuildCommand(
			{
				systemConfig: {
					...createTestSystemConfig(),
					systemConfigPath: path.join(temporaryDirectory, 'config', 'system.jsonc'),
					cacheDir: temporaryDirectory,
					zones: createTestSystemConfig().zones.map((zone) => ({
						...zone,
						gateway:
							zone.gateway.type === 'openclaw'
								? { ...zone.gateway, config: gatewayConfigPath }
								: zone.gateway,
					})),
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: buildConfigPath,
								source: {
									kind: 'managedBase',
									base: 'openclaw-gateway',
									overlay: overlayPath,
								},
							},
						},
						toolVms: {},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options);
				},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'managed-fp',
					imagePath: '/cache/managed',
				}),
				resolveManagedImageRelease: async () => createTestManagedImageRelease(),
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(dockerBuilds).toHaveLength(1);
		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:managed');
		expect(dockerBuilds[0]?.dockerfilePath).toContain(
			path.join('generated-dockerfiles', 'gateway', 'openclaw', 'Dockerfile'),
		);
		const generatedDockerfile = fs.readFileSync(dockerBuilds[0]?.dockerfilePath ?? '', 'utf8');
		expect(generatedDockerfile).toContain(
			'FROM ghcr.io/shravansunder/agent-vm-managed-openclaw-gateway-base:2026.05.27.1',
		);
		expect(generatedDockerfile).toContain(
			`RUN pnpm add -g "@agent-vm/openclaw-agent-vm-plugin@${readOpenClawAgentVmPluginVersion()}"`,
		);
		expect(generatedDockerfile).not.toContain('@agent-vm/openclaw-agent-vm-plugin@0.0.52');
		expect(generatedDockerfile).not.toContain('@agent-vm/openclaw-agent-vm-plugin@0.0.45');
		expect(generatedDockerfile).toContain('package_root="$(pnpm root -g)"');
		expect(generatedDockerfile).toContain(
			'ln -sfn "$package_root/@agent-vm/openclaw-agent-vm-plugin/dist" /home/openclaw/.openclaw/extensions/gondolin',
		);
		expect(generatedDockerfile).toContain('pnpm store prune');
		expect(generatedDockerfile).toContain('rm -rf /root/.cache /root/.npm /tmp/*');
		expect(generatedDockerfile).toContain(
			'RUN apt-get update && apt-get install -y --no-install-recommends "ca-certificates"',
		);
		expect(generatedDockerfile).toContain('WORKDIR /opt/openclaw-runtime-packages');
		expect(generatedDockerfile).toContain('"@openclaw/discord": "2026.5.7"');
		expect(generatedDockerfile).toContain('"openclaw": "2026.6.8"');
		expect(generatedDockerfile).toContain('"undici": "8.5.0"');
		expect(generatedDockerfile).toContain('RUN pnpm install --prod --ignore-scripts');
		expect(generatedDockerfile).toContain(
			'COPY overlay/certs/strip-nonascii-certs.py /tmp/strip-nonascii-certs.py',
		);
		expect(generatedDockerfile).toContain('RUN python3 /tmp/strip-nonascii-certs.py');
	});

	it('prints the resolved managed Dockerfile plan before Docker build', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const buildConfigPath = path.join(temporaryDirectory, 'build-config.json');
		const gatewayConfigDirectory = path.join(temporaryDirectory, 'config', 'gateways', 'sunfam');
		fs.mkdirSync(gatewayConfigDirectory, { recursive: true });
		const gatewayConfigPath = path.join(gatewayConfigDirectory, 'openclaw.json');
		fs.writeFileSync(
			gatewayConfigPath,
			JSON.stringify({ channels: { discord: { enabled: true } } }),
		);
		fs.writeFileSync(
			overlayPath,
			JSON.stringify({
				schemaVersion: 1,
				extraAptPackages: [],
				runAfterBase: [],
			}),
			'utf8',
		);
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-gateway:latest' } }),
			'utf8',
		);
		const outputLines: string[] = [];
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const baseConfig = createTestSystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected an OpenClaw test zone.');
		}

		await runBuildCommand(
			{
				systemConfig: {
					...baseConfig,
					cacheDir: path.join(temporaryDirectory, 'cache'),
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: buildConfigPath,
								source: {
									kind: 'managedBase',
									base: 'openclaw-gateway',
									overlay: overlayPath,
								},
							},
						},
						toolVms: {},
					},
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								config: gatewayConfigPath,
							},
						},
					],
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options);
				},
				buildGondolinImage: async (options) => ({
					built: true,
					fingerprint: 'plan-fp',
					imagePath: path.join(options.cacheDir, 'plan-fp'),
				}),
				resolveManagedImageRelease: async () => createTestManagedImageRelease(),
				runTask: createRecordingRunTask(outputLines),
			},
		);

		expect(dockerBuilds).toHaveLength(1);
		expect(outputLines).toHaveLength(1);
		expect(outputLines[0]).not.toContain('\n');
		expect(outputLines[0]).toContain('base openclaw-gateway:2026.05.27.1');
		expect(outputLines[0]).toContain(
			'overrides undici@8.5.0[managed-images.json/packageOverrides.pnpm]',
		);
		expect(outputLines[0]).toContain('discord@2026.6.8[managed-default]');
		expect(outputLines[0]).toContain(
			'npm @openai/codex@0.139.0[managed-images.json/packageOverrides.npm]',
		);
	});

	it('prints OpenClaw package-version mismatch warnings in the managed Dockerfile plan', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const overlayPath = path.join(temporaryDirectory, 'overlay.jsonc');
		const buildConfigPath = path.join(temporaryDirectory, 'build-config.json');
		const gatewayConfigDirectory = path.join(temporaryDirectory, 'config', 'gateways', 'sunfam');
		fs.mkdirSync(gatewayConfigDirectory, { recursive: true });
		const gatewayConfigPath = path.join(gatewayConfigDirectory, 'openclaw.json');
		fs.writeFileSync(gatewayConfigPath, JSON.stringify({ channels: {} }), 'utf8');
		fs.writeFileSync(
			overlayPath,
			JSON.stringify({
				schemaVersion: 1,
				extraAptPackages: [],
				packageOverrides: {
					openclaw: ['openclaw@2026.5.7', '@openclaw/discord@2026.5.2'],
				},
				runAfterBase: [],
			}),
			'utf8',
		);
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-gateway:latest' } }),
			'utf8',
		);
		const outputLines: string[] = [];
		const baseConfig = createTestSystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected an OpenClaw test zone.');
		}

		await runBuildCommand(
			{
				systemConfig: {
					...baseConfig,
					cacheDir: path.join(temporaryDirectory, 'cache'),
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: buildConfigPath,
								source: {
									kind: 'managedBase',
									base: 'openclaw-gateway',
									overlay: overlayPath,
								},
							},
						},
						toolVms: {},
					},
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								config: gatewayConfigPath,
							},
						},
					],
				},
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => ({
					built: true,
					fingerprint: 'warning-fp',
					imagePath: path.join(options.cacheDir, 'warning-fp'),
				}),
				resolveManagedImageRelease: async () => createTestManagedImageRelease(),
				runTask: createRecordingRunTask(outputLines),
			},
		);

		expect(outputLines).toHaveLength(1);
		expect(outputLines[0]).not.toContain('\n');
		expect(outputLines[0]).toContain('warnings 2');
		expect(outputLines[0]).toContain('discord@2026.5.2[overlay.jsonc/packageOverrides.openclaw]');
		expect(outputLines[0]).not.toContain('OpenClaw package versions differ');
	});

	it('adds Discord OpenClaw package when a managed openclaw profile serves a Discord zone', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayConfigDirectory = path.join(temporaryDirectory, 'config', 'gateways', 'sunfam');
		fs.mkdirSync(gatewayConfigDirectory, { recursive: true });
		const gatewayConfigPath = path.join(gatewayConfigDirectory, 'openclaw.json');
		fs.writeFileSync(
			gatewayConfigPath,
			JSON.stringify({ channels: { discord: { enabled: true } } }),
			'utf8',
		);
		const buildConfigPath = path.join(temporaryDirectory, 'build-config.json');
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-gateway:discord' } }),
			'utf8',
		);
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const baseConfig = createTestSystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected an OpenClaw test zone.');
		}

		await runBuildCommand(
			{
				systemConfig: {
					...baseConfig,
					cacheDir: temporaryDirectory,
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								config: gatewayConfigPath,
							},
						},
					],
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: buildConfigPath,
								source: {
									kind: 'managedBase',
									base: 'openclaw-gateway',
								},
							},
						},
						toolVms: {},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options);
				},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'discord-fp',
					imagePath: '/cache/discord',
				}),
				resolveManagedImageRelease: async () => createTestManagedImageRelease(),
				runTask: async (_title, fn) => fn(),
			},
		);

		const generatedDockerfile = fs.readFileSync(dockerBuilds[0]?.dockerfilePath ?? '', 'utf8');
		expect(generatedDockerfile).toContain('WORKDIR /opt/openclaw-runtime-packages');
		expect(generatedDockerfile).toContain('"openclaw": "2026.6.8"');
		expect(generatedDockerfile).toContain('"@openclaw/codex": "2026.6.8"');
		expect(generatedDockerfile).toContain('"@openclaw/discord": "2026.6.8"');
		expect(generatedDockerfile).toContain('"undici": "8.5.0"');
		expect(generatedDockerfile).toContain('RUN pnpm install --prod --ignore-scripts');
		expect(generatedDockerfile).toContain(
			'ln -sfn /opt/openclaw-runtime-packages/node_modules/@openclaw/discord "$global_package_root/@openclaw/discord"',
		);
	});

	it('does not add diagnostics OTEL OpenClaw package without accepted zone telemetry', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayConfigDirectory = path.join(temporaryDirectory, 'config', 'gateways', 'sunfam');
		fs.mkdirSync(gatewayConfigDirectory, { recursive: true });
		const gatewayConfigPath = path.join(gatewayConfigDirectory, 'openclaw.json');
		fs.writeFileSync(gatewayConfigPath, JSON.stringify({ channels: {} }), 'utf8');
		const buildConfigPath = path.join(temporaryDirectory, 'build-config.json');
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-gateway:observability' } }),
			'utf8',
		);
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const baseConfig = createObservabilitySystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected an OpenClaw test zone.');
		}

		await runBuildCommand(
			{
				systemConfig: {
					...baseConfig,
					cacheDir: temporaryDirectory,
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								config: gatewayConfigPath,
							},
						},
					],
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: buildConfigPath,
								source: {
									kind: 'managedBase',
									base: 'openclaw-gateway',
								},
							},
						},
						toolVms: {},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options);
				},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'observability-fp',
					imagePath: '/cache/observability',
				}),
				prepareObservabilityStack: async () => ({
					collectorConfigPath: '/runtime/observability/otel-collector-config.yaml',
					composePath: '/runtime/observability/docker-compose.observability.yml',
					status: 'ready',
				}),
				resolveManagedImageRelease: async () => createTestManagedImageRelease(),
				runTask: async (_title, fn) => fn(),
			},
		);

		const generatedDockerfile = fs.readFileSync(dockerBuilds[0]?.dockerfilePath ?? '', 'utf8');
		expect(generatedDockerfile).toContain('WORKDIR /opt/openclaw-runtime-packages');
		expect(generatedDockerfile).toContain('"openclaw": "2026.6.8"');
		expect(generatedDockerfile).toContain('"@openclaw/codex": "2026.6.8"');
		expect(generatedDockerfile).not.toContain('"@openclaw/diagnostics-otel": "2026.6.8"');
		expect(generatedDockerfile).toContain('"undici": "8.5.0"');
		expect(generatedDockerfile).toContain('RUN pnpm install --prod --ignore-scripts');
		expect(generatedDockerfile).not.toContain(
			'ln -sfn /opt/openclaw-runtime-packages/node_modules/@openclaw/diagnostics-otel "$global_package_root/@openclaw/diagnostics-otel"',
		);
		expect(generatedDockerfile).not.toContain('openclaw-diagnostics-otel.tgz');
		expect(generatedDockerfile).not.toContain(
			'npm pack "$(pnpm root -g)/@openclaw/diagnostics-otel"',
		);
	});

	it('does not add disabled OpenClaw channel packages', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayConfigDirectory = path.join(temporaryDirectory, 'config', 'gateways', 'sunfam');
		fs.mkdirSync(gatewayConfigDirectory, { recursive: true });
		const gatewayConfigPath = path.join(gatewayConfigDirectory, 'openclaw.json');
		fs.writeFileSync(
			gatewayConfigPath,
			JSON.stringify({ channels: { discord: { enabled: false } } }),
			'utf8',
		);
		const buildConfigPath = path.join(temporaryDirectory, 'build-config.json');
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-gateway:no-discord' } }),
			'utf8',
		);
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const baseConfig = createTestSystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected an OpenClaw test zone.');
		}

		await runBuildCommand(
			{
				systemConfig: {
					...baseConfig,
					cacheDir: temporaryDirectory,
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								config: gatewayConfigPath,
							},
						},
					],
					imageProfiles: {
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: buildConfigPath,
								source: {
									kind: 'managedBase',
									base: 'openclaw-gateway',
								},
							},
						},
						toolVms: {},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options);
				},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'disabled-discord-fp',
					imagePath: '/cache/disabled-discord',
				}),
				resolveManagedImageRelease: async () => createTestManagedImageRelease(),
				runTask: async (_title, fn) => fn(),
			},
		);

		const generatedDockerfile = fs.readFileSync(dockerBuilds[0]?.dockerfilePath ?? '', 'utf8');
		expect(generatedDockerfile).toContain('WORKDIR /opt/openclaw-runtime-packages');
		expect(generatedDockerfile).toContain('"openclaw": "2026.6.8"');
		expect(generatedDockerfile).toContain('"@openclaw/codex": "2026.6.8"');
		expect(generatedDockerfile).toContain('"undici": "8.5.0"');
		expect(generatedDockerfile).toContain('RUN pnpm install --prod --ignore-scripts');
		expect(generatedDockerfile).not.toContain('@openclaw/discord');
	});

	it('finds the scaffold root by walking up to config/system.json instead of assuming dockerfile depth', async () => {
		const projectRootDirectory = createTemporaryDirectory();
		const dockerfileDirectory = path.join(projectRootDirectory, 'nested', 'images', 'gateway');
		const dockerfilePath = path.join(dockerfileDirectory, 'Dockerfile');
		const buildConfigPath = path.join(dockerfileDirectory, 'build-config.json');
		fs.mkdirSync(path.join(projectRootDirectory, 'config'), { recursive: true });
		fs.mkdirSync(dockerfileDirectory, { recursive: true });
		fs.writeFileSync(path.join(projectRootDirectory, 'config', 'system.json'), '{}\n');
		fs.writeFileSync(dockerfilePath, 'FROM scratch\n');
		fs.writeFileSync(
			buildConfigPath,
			JSON.stringify({ oci: { image: 'agent-vm-gateway:latest' } }),
		);

		const pluginSyncs: string[] = [];

		await runBuildCommand(
			{
				systemConfig: {
					...createTestSystemConfig(),
					imageProfiles: {
						...createTestSystemConfig().imageProfiles,
						gateways: {
							openclaw: {
								type: 'openclaw',
								buildConfig: buildConfigPath,
								dockerfile: dockerfilePath,
							},
						},
					},
				},
			},
			{
				runTask: async (_title, fn) => fn(),
				buildDockerImage: async () => {},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'abc123',
					imagePath: '/cache/abc123',
				}),
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				syncBundledOpenClawPlugin: async (targetDir) => {
					pluginSyncs.push(targetDir);
					return 'created';
				},
			},
		);

		expect(pluginSyncs).toEqual([projectRootDirectory]);
	});

	it('skips Docker build when no dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildGondolinImage: async () => ({
				built: false,
				fingerprint: 'cached',
				imagePath: '/cache/cached',
			}),
			resolveOciImageTag: async () => 'agent-vm-tool:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
		};

		await runBuildCommand({ systemConfig: createTestSystemConfig() }, dependencies);

		expect(dockerBuilds).toHaveLength(1);
	});

	it('does not sync the OpenClaw plugin bundle for worker-only projects', async () => {
		const pluginSyncs: string[] = [];
		const baseConfig = createTestSystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}

		await runBuildCommand(
			{
				systemConfig: {
					...baseConfig,
					imageProfiles: {
						...baseConfig.imageProfiles,
						gateways: {
							worker: {
								type: 'worker',
								buildConfig: '/project/vm-images/gateways/worker/build-config.json',
								dockerfile: '/project/vm-images/gateways/worker/Dockerfile',
							},
						},
					},
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								type: 'worker',
								imageProfile: 'worker',
							},
						},
					],
				},
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'abc123',
					imagePath: '/cache/abc123',
				}),
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => fn(),
				syncBundledOpenClawPlugin: async (targetDir) => {
					pluginSyncs.push(targetDir);
					return 'created';
				},
			},
		);

		expect(pluginSyncs).toEqual([]);
	});

	it('builds shared Gondolin assets once per image type into the shared cache dir', async () => {
		const gondolinBuilds: {
			cacheDir: string;
			fullReset: boolean | undefined;
		}[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async () => {},
			buildGondolinImage: async (options) => {
				gondolinBuilds.push({
					cacheDir: options.cacheDir,
					fullReset: options.fullReset,
				});
				return { built: true, fingerprint: 'f1', imagePath: '/cache/f1' };
			},
			resolveOciImageTag: async () => 'tag:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
		};

		await runBuildCommand({ systemConfig: createTestSystemConfig() }, dependencies);

		expect(gondolinBuilds).toHaveLength(2);
		expect(gondolinBuilds[0]).toEqual({
			cacheDir: '/cache/gateway-images/openclaw',
			fullReset: undefined,
		});
		expect(gondolinBuilds[1]).toEqual({
			cacheDir: '/cache/tool-vm-images/default',
			fullReset: undefined,
		});
	});

	it('uses Docker rootfs identity as fingerprint input for Docker-backed targets', async () => {
		const fingerprintInputs: unknown[] = [];
		const gondolinBuilds: {
			cacheDir: string;
			fingerprintInput: unknown;
			fullReset: boolean | undefined;
		}[] = [];
		const dockerRootfsIdentity = {
			architecture: 'arm64',
			layers: ['sha256:rootfs-a', 'sha256:rootfs-b'],
			os: 'linux',
		};

		await runBuildCommand(
			{ systemConfig: createTestSystemConfig() },
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fingerprintInput: options.fingerprintInput,
						fullReset: options.fullReset,
					});
					return {
						built: true,
						fingerprint: options.cacheDir.includes('gateway-images')
							? 'gateway-rootfs-fingerprint'
							: 'tool-fingerprint',
						imagePath: '/cache/docker-refresh',
					};
				},
				computeGondolinFingerprint: async (options) => {
					fingerprintInputs.push(options.fingerprintInput);
					return options.fingerprintInput === undefined
						? 'tool-fingerprint'
						: 'gateway-rootfs-fingerprint';
				},
				resolveOciImageTag: async () => 'tag:latest',
				resolveDockerRootfsIdentity: async () => dockerRootfsIdentity,
				runTask: async (_title, fn) => await fn(),
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(fingerprintInputs).toEqual([
			{
				dockerRootfsIdentity,
				schemaVersion: 1,
			},
			undefined,
		]);
		expect(gondolinBuilds).toEqual([
			{
				cacheDir: '/cache/gateway-images/openclaw',
				fingerprintInput: {
					dockerRootfsIdentity,
					schemaVersion: 1,
				},
				fullReset: undefined,
			},
			{
				cacheDir: '/cache/tool-vm-images/default',
				fingerprintInput: undefined,
				fullReset: undefined,
			},
		]);
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
			buildGondolinImage: async (options) => {
				gondolinBuilds.push({ cacheDir: options.cacheDir });
				return { built: true, fingerprint: 'zone-fp', imagePath: '/cache/zone-fp' };
			},
			resolveOciImageTag: async () => 'tag:latest',
			syncBundledOpenClawPlugin: noOpPluginSync,
		};

		await runBuildCommand({ systemConfig: multiZoneConfig }, dependencies);

		expect(gondolinBuilds).toHaveLength(2);
		expect(gondolinBuilds.map((build) => build.cacheDir)).toEqual([
			'/cache/gateway-images/openclaw',
			'/cache/tool-vm-images/default',
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
			'openclaw',
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
		const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
		const toolProfileNames = ['default', 'shravan', 'alevtina', 'sun'] as const;
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				cacheDir: cacheDirectory,
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
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
		const writeFakeAssets = (imagePath: string): void => {
			fs.mkdirSync(imagePath, { recursive: true });
			for (const fileName of buildImageAssetFileNames) {
				fs.writeFileSync(path.join(imagePath, fileName), `${fileName}\n`, 'utf8');
			}
		};

		await runBuildCommand(
			{
				systemConfig,
			},
			{
				buildGondolinImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fullReset: options.fullReset,
					});
					const fingerprint = options.cacheDir.includes('gateway-images')
						? 'gateway-fingerprint'
						: builtFingerprint;
					const imagePath = path.join(options.cacheDir, fingerprint);
					writeFakeAssets(imagePath);
					return { built: true, fingerprint, imagePath };
				},
				findPrunableImageDirectories: async (options) => {
					expect(options.currentFingerprints.gateways).toEqual({
						openclaw: 'gateway-fingerprint',
					});
					expect(options.currentFingerprints.toolVms).toEqual({
						default: builtFingerprint,
						shravan: builtFingerprint,
						alevtina: builtFingerprint,
						sun: builtFingerprint,
					});
					return [];
				},
				computeGondolinFingerprint: async (options) => {
					fingerprintComputations.push(options.buildConfigPath);
					return options.buildConfigPath === gatewayBuildConfigPath
						? 'gateway-fingerprint'
						: builtFingerprint;
				},
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(fingerprintComputations).toEqual([gatewayBuildConfigPath, buildConfigPath]);
		expect(gondolinBuilds).toEqual([
			{
				cacheDir: path.join(cacheDirectory, 'gateway-images', 'openclaw'),
				fullReset: undefined,
			},
			{
				cacheDir: path.join(cacheDirectory, 'tool-vm-images', 'default'),
				fullReset: undefined,
			},
		]);
		for (const profileName of toolProfileNames) {
			const imagePath = path.join(cacheDirectory, 'tool-vm-images', profileName, builtFingerprint);
			for (const fileName of buildImageAssetFileNames) {
				expect(fs.existsSync(path.join(imagePath, fileName))).toBe(true);
			}
		}
		const duplicateProfileCacheResult = await buildGondolinImage(
			{
				buildConfigPath,
				cacheDir: path.join(cacheDirectory, 'tool-vm-images', 'sun'),
			},
			{
				resolveRuntimeBuildVersionTag: async () => runtimeBuildVersionTag,
			},
		);
		expect(duplicateProfileCacheResult).toEqual({
			built: false,
			fingerprint: builtFingerprint,
			imagePath: path.join(cacheDirectory, 'tool-vm-images', 'sun', builtFingerprint),
		});
	});

	it('surfaces duplicate alias asset access failures', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const buildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'shared',
			'build-config.jsonc',
		);
		const fingerprint = 'shared-access-fingerprint';
		const deniedAssetPath = path.join(
			cacheDirectory,
			'tool-vm-images',
			'sun',
			fingerprint,
			'manifest.json',
		);
		const systemConfig = createSharedToolVmSystemConfig({
			buildConfigPath,
			cacheDirectory,
			toolProfileNames: ['default', 'sun'],
		});
		const originalAccess = fsPromises.access;
		vi.spyOn(fsPromises, 'access').mockImplementation(
			async (...accessArgs: Parameters<typeof fsPromises.access>): Promise<void> => {
				if (path.resolve(String(accessArgs[0])) === path.resolve(deniedAssetPath)) {
					throw createFileSystemError('EACCES', `permission denied: ${deniedAssetPath}`);
				}
				await originalAccess(...accessArgs);
			},
		);

		await expect(
			runBuildCommand(
				{ systemConfig },
				{
					buildGondolinImage: async (options) => {
						const imagePath = path.join(options.cacheDir, fingerprint);
						writeFakeImageAssets(imagePath, 'canonical');
						return { built: true, fingerprint, imagePath };
					},
					computeGondolinFingerprint: async () => fingerprint,
					findPrunableImageDirectories: async () => [],
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toMatchObject({ code: 'EACCES' });
	});

	it('falls back to copying duplicate aliases when hardlinking is unavailable', async () => {
		for (const hardlinkErrorCode of ['EXDEV', 'ENOTSUP'] as const) {
			vi.restoreAllMocks();
			const temporaryDirectory = createTemporaryDirectory();
			const cacheDirectory = path.join(temporaryDirectory, 'cache');
			const buildConfigPath = path.join(
				temporaryDirectory,
				'vm-images',
				`shared-${hardlinkErrorCode}`,
				'build-config.jsonc',
			);
			const fingerprint = `shared-copy-fingerprint-${hardlinkErrorCode}`;
			const duplicateImagePath = path.join(cacheDirectory, 'tool-vm-images', 'sun', fingerprint);
			const systemConfig = createSharedToolVmSystemConfig({
				buildConfigPath,
				cacheDirectory,
				toolProfileNames: ['default', 'sun'],
			});
			const copiedTargets: string[] = [];
			const originalCopyFile = fsPromises.copyFile;
			vi.spyOn(fsPromises, 'link').mockImplementation(async (): Promise<void> => {
				throw createFileSystemError(hardlinkErrorCode, `${hardlinkErrorCode}: hardlink denied`);
			});
			vi.spyOn(fsPromises, 'copyFile').mockImplementation(
				async (...copyFileArgs: Parameters<typeof fsPromises.copyFile>): Promise<void> => {
					copiedTargets.push(String(copyFileArgs[1]));
					await originalCopyFile(...copyFileArgs);
				},
			);

			// oxlint-disable-next-line no-await-in-loop -- each iteration installs process-wide fs spies
			await runBuildCommand(
				{ systemConfig },
				{
					buildGondolinImage: async (options) => {
						const imagePath = path.join(options.cacheDir, fingerprint);
						writeFakeImageAssets(imagePath, `canonical-${hardlinkErrorCode}`);
						return { built: true, fingerprint, imagePath };
					},
					computeGondolinFingerprint: async () => fingerprint,
					findPrunableImageDirectories: async () => [],
					runTask: async (_title, fn) => fn(),
				},
			);

			expect(copiedTargets.toSorted()).toEqual(
				buildImageAssetFileNames
					.map((fileName) => path.join(duplicateImagePath, fileName))
					.toSorted(),
			);
			expect(fs.readFileSync(path.join(duplicateImagePath, 'manifest.json'), 'utf8')).toBe(
				`canonical-${hardlinkErrorCode}:manifest.json\n`,
			);
		}
	});

	it('adds asset paths to duplicate alias materialization failures', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const buildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'shared',
			'build-config.jsonc',
		);
		const fingerprint = 'shared-link-error-fingerprint';
		const sourceAssetPath = path.join(
			cacheDirectory,
			'tool-vm-images',
			'default',
			fingerprint,
			'manifest.json',
		);
		const targetAssetPath = path.join(
			cacheDirectory,
			'tool-vm-images',
			'sun',
			fingerprint,
			'manifest.json',
		);
		const systemConfig = createSharedToolVmSystemConfig({
			buildConfigPath,
			cacheDirectory,
			toolProfileNames: ['default', 'sun'],
		});
		vi.spyOn(fsPromises, 'link').mockImplementation(async (): Promise<void> => {
			throw createFileSystemError('EIO', 'link failed');
		});

		let thrownError: unknown;
		try {
			await runBuildCommand(
				{ systemConfig },
				{
					buildGondolinImage: async (options) => {
						const imagePath = path.join(options.cacheDir, fingerprint);
						writeFakeImageAssets(imagePath, 'canonical');
						return { built: true, fingerprint, imagePath };
					},
					computeGondolinFingerprint: async () => fingerprint,
					findPrunableImageDirectories: async () => [],
					runTask: async (_title, fn) => fn(),
				},
			);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(Error);
		expect((thrownError as Error).message).toContain(sourceAssetPath);
		expect((thrownError as Error).message).toContain(targetAssetPath);
		expect((thrownError as Error & { readonly cause?: unknown }).cause).toMatchObject({
			code: 'EIO',
		});
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
					buildGondolinImage: async (options) => {
						const fingerprint = options.cacheDir.includes('gateway-images')
							? 'gateway-fingerprint'
							: 'actual-fingerprint';
						return {
							built: true,
							fingerprint,
							imagePath: path.join(options.cacheDir, fingerprint),
						};
					},
					computeGondolinFingerprint: async (options) =>
						options.buildConfigPath.includes('gateway-build-config')
							? 'gateway-fingerprint'
							: 'precomputed-fingerprint',
					findPrunableImageDirectories: async () => [],
					runTask: async (_title, fn) => fn(),
				},
			),
		).rejects.toThrow(
			"Fingerprint mismatch for image profile 'toolVm/default': precomputed 'precomputed-fingerprint' but build returned 'actual-fingerprint'.",
		);
	});

	it('replaces stale duplicate alias assets when forceRebuild dedupes profiles', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const buildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'shared',
			'build-config.jsonc',
		);
		const fingerprint = 'shared-force-fingerprint';
		const duplicateImagePath = path.join(cacheDirectory, 'tool-vm-images', 'sun', fingerprint);
		const staleOnlyPath = path.join(duplicateImagePath, 'stale-only.txt');
		fs.mkdirSync(duplicateImagePath, { recursive: true });
		writeFakeImageAssets(duplicateImagePath, 'stale');
		fs.writeFileSync(staleOnlyPath, 'remove me\n', 'utf8');
		const systemConfig = createSharedToolVmSystemConfig({
			buildConfigPath,
			cacheDirectory,
			toolProfileNames: ['default', 'sun'],
		});

		await runBuildCommand(
			{ forceRebuild: true, systemConfig },
			{
				buildGondolinImage: async (options) => {
					const imagePath = path.join(options.cacheDir, fingerprint);
					writeFakeImageAssets(imagePath, 'fresh-force');
					return { built: true, fingerprint, imagePath };
				},
				computeGondolinFingerprint: async () => fingerprint,
				findPrunableImageDirectories: async () => [],
				runTask: async (_title, fn) => fn(),
			},
		);

		for (const fileName of buildImageAssetFileNames) {
			expect(fs.readFileSync(path.join(duplicateImagePath, fileName), 'utf8')).toBe(
				`fresh-force:${fileName}\n`,
			);
		}
		expect(fs.existsSync(staleOnlyPath)).toBe(false);
	});

	it('rematerializes partial duplicate alias directories', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const cacheDirectory = path.join(temporaryDirectory, 'cache');
		const buildConfigPath = path.join(
			temporaryDirectory,
			'vm-images',
			'shared',
			'build-config.jsonc',
		);
		const fingerprint = 'shared-partial-fingerprint';
		const duplicateImagePath = path.join(cacheDirectory, 'tool-vm-images', 'sun', fingerprint);
		const staleOnlyPath = path.join(duplicateImagePath, 'stale-only.txt');
		fs.mkdirSync(duplicateImagePath, { recursive: true });
		fs.writeFileSync(path.join(duplicateImagePath, 'manifest.json'), 'stale manifest\n', 'utf8');
		fs.writeFileSync(staleOnlyPath, 'remove me\n', 'utf8');
		const systemConfig = createSharedToolVmSystemConfig({
			buildConfigPath,
			cacheDirectory,
			toolProfileNames: ['default', 'sun'],
		});

		await runBuildCommand(
			{ systemConfig },
			{
				buildGondolinImage: async (options) => {
					const imagePath = path.join(options.cacheDir, fingerprint);
					writeFakeImageAssets(imagePath, 'fresh-partial');
					return { built: true, fingerprint, imagePath };
				},
				computeGondolinFingerprint: async () => fingerprint,
				findPrunableImageDirectories: async () => [],
				runTask: async (_title, fn) => fn(),
			},
		);

		for (const fileName of buildImageAssetFileNames) {
			expect(fs.readFileSync(path.join(duplicateImagePath, fileName), 'utf8')).toBe(
				`fresh-partial:${fileName}\n`,
			);
		}
		expect(fs.existsSync(staleOnlyPath)).toBe(false);
	});

	it('does not dedupe identical fingerprints across different build config paths', async () => {
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
			'openclaw',
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
		const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				cacheDir: cacheDirectory,
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
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
				buildGondolinImage: async (options) => {
					gondolinBuilds.push(options.cacheDir);
					const fingerprint = options.cacheDir.includes('gateway-images')
						? 'gateway-fingerprint'
						: 'same-tool-fingerprint';
					const imagePath = path.join(options.cacheDir, fingerprint);
					fs.mkdirSync(imagePath, { recursive: true });
					for (const fileName of buildImageAssetFileNames) {
						fs.writeFileSync(path.join(imagePath, fileName), `${fileName}\n`, 'utf8');
					}
					return { built: true, fingerprint, imagePath };
				},
				computeGondolinFingerprint: async (options) =>
					options.buildConfigPath === gatewayBuildConfigPath
						? 'gateway-fingerprint'
						: 'same-tool-fingerprint',
				runTask: async (_title, fn) => fn(),
			},
		);

		expect(gondolinBuilds).toEqual([
			path.join(cacheDirectory, 'gateway-images', 'openclaw'),
			path.join(cacheDirectory, 'tool-vm-images', 'first'),
			path.join(cacheDirectory, 'tool-vm-images', 'second'),
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
		const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				cacheDir: cacheDirectory,
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
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
		const sharedFingerprint = 'shared-gateway-tool-fingerprint';
		const dockerBuilds: string[] = [];
		const gondolinBuilds: { cacheDir: string; fullReset: boolean | undefined }[] = [];

		await runBuildCommand(
			{ systemConfig },
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options.imageTag);
				},
				buildGondolinImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fullReset: options.fullReset,
					});
					const imagePath = path.join(options.cacheDir, sharedFingerprint);
					fs.mkdirSync(imagePath, { recursive: true });
					for (const fileName of buildImageAssetFileNames) {
						fs.writeFileSync(path.join(imagePath, fileName), `${fileName}\n`, 'utf8');
					}
					return { built: true, fingerprint: sharedFingerprint, imagePath };
				},
				computeGondolinFingerprint: async () => sharedFingerprint,
				findPrunableImageDirectories: async (options) => {
					expect(options.currentFingerprints).toEqual({
						gateways: { openclaw: sharedFingerprint },
						toolVms: { default: sharedFingerprint },
					});
					return [];
				},
				resolveOciImageTag: async () => 'agent-vm-shared:latest',
				resolveProjectRootFromDockerfile: async () => temporaryDirectory,
				runTask: async (_title, fn) => fn(),
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(dockerBuilds).toEqual(['agent-vm-shared:latest']);
		expect(gondolinBuilds).toEqual([
			{
				cacheDir: path.join(cacheDirectory, 'gateway-images', 'openclaw'),
				fullReset: undefined,
			},
		]);
		for (const imagePath of [
			path.join(cacheDirectory, 'gateway-images', 'openclaw', sharedFingerprint),
			path.join(cacheDirectory, 'tool-vm-images', 'default', sharedFingerprint),
		]) {
			for (const fileName of buildImageAssetFileNames) {
				expect(fs.existsSync(path.join(imagePath, fileName))).toBe(true);
			}
		}
	});

	it('builds multiple Docker-backed image targets concurrently before Gondolin asset builds', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayImageDirectory = path.join(
			temporaryDirectory,
			'vm-images',
			'gateways',
			'openclaw',
		);
		const toolVmImageDirectory = path.join(temporaryDirectory, 'vm-images', 'tool-vms', 'default');
		const gatewayDockerfilePath = path.join(gatewayImageDirectory, 'Dockerfile');
		const toolVmDockerfilePath = path.join(toolVmImageDirectory, 'Dockerfile');
		fs.mkdirSync(gatewayImageDirectory, { recursive: true });
		fs.mkdirSync(toolVmImageDirectory, { recursive: true });
		fs.writeFileSync(gatewayDockerfilePath, 'FROM scratch\n', 'utf8');
		fs.writeFileSync(toolVmDockerfilePath, 'FROM scratch\n', 'utf8');

		const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				cacheDir: path.join(temporaryDirectory, 'cache'),
				imageProfiles: {
					gateways: {
						openclaw: {
							type: 'openclaw',
							buildConfig: path.join(gatewayImageDirectory, 'build-config.json'),
							dockerfile: gatewayDockerfilePath,
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: path.join(toolVmImageDirectory, 'build-config.json'),
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
				buildGondolinImage: async (options) => {
					const imagePath = path.join(options.cacheDir, 'fingerprint');
					writeFakeImageAssets(imagePath, options.cacheDir);
					return {
						built: true,
						fingerprint: 'fingerprint',
						imagePath,
					};
				},
				resolveOciImageTag: async (buildConfigPath) =>
					buildConfigPath.includes('/tool-vms/')
						? 'agent-vm-tool-vm:latest'
						: 'agent-vm-gateway:latest',
				resolveProjectRootFromDockerfile: async () => temporaryDirectory,
				runTask: async (_title, fn) => fn(),
				syncBundledOpenClawPlugin: noOpPluginSync,
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
		fs.mkdirSync(gatewayImageDirectory, { recursive: true });
		fs.mkdirSync(toolVmImageDirectory, { recursive: true });
		fs.writeFileSync(gatewayDockerfilePath, 'FROM scratch\n', 'utf8');
		fs.writeFileSync(toolVmDockerfilePath, 'FROM scratch\n', 'utf8');

		const { systemConfigPath: _systemConfigPath, ...baseConfig } = createTestSystemConfig();
		const systemConfig = createLoadedSystemConfig(
			{
				...baseConfig,
				cacheDir: path.join(temporaryDirectory, 'cache'),
				imageProfiles: {
					gateways: {
						default: {
							type: 'openclaw',
							buildConfig: path.join(gatewayImageDirectory, 'build-config.json'),
							dockerfile: gatewayDockerfilePath,
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: path.join(toolVmImageDirectory, 'build-config.json'),
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
				buildGondolinImage: async (options) => {
					const imagePath = path.join(options.cacheDir, 'fingerprint');
					writeFakeImageAssets(imagePath, options.cacheDir);
					return {
						built: true,
						fingerprint: 'fingerprint',
						imagePath,
					};
				},
				resolveOciImageTag: async (buildConfigPath) =>
					buildConfigPath.includes('/tool-vms/')
						? 'agent-vm-tool-default:latest'
						: 'agent-vm-gateway-default:latest',
				resolveProjectRootFromDockerfile: async () => temporaryDirectory,
				runTask: async (_title, fn) => fn(),
				syncBundledOpenClawPlugin: noOpPluginSync,
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

		await runBuildCommand(
			{
				forceRebuild: true,
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fullReset: options.fullReset,
					});
					return { built: true, fingerprint: 'force-fp', imagePath: '/cache/force-fp' };
				},
				resolveOciImageTag: async () => 'tag:latest',
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(gondolinBuilds).toEqual([
			{ cacheDir: '/cache/gateway-images/openclaw', fullReset: true },
			{ cacheDir: '/cache/tool-vm-images/default', fullReset: true },
		]);
		expect(taskTitles).toContain('Gondolin: gateway/openclaw');
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
				buildGondolinImage: async (options) => {
					gondolinStreamPreviews.push(options.streamPreview);
					options.streamPreview?.write(
						'Extracting OCI rootfs from agent-vm-gateway:latest (docker)...\n',
					);
					options.streamPreview?.write('Creating rootfs ext4 image...\n');
					return { built: true, fingerprint: 'interactive-fp', imagePath: '/cache/interactive' };
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
				syncBundledOpenClawPlugin: noOpPluginSync,
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

		const buildPromise = runBuildCommand(
			{
				forceRebuild: true,
				systemConfig: {
					...createTestSystemConfig(),
					imageProfiles: {
						gateways: {},
						toolVms: {
							default: {
								type: 'toolVm',
								buildConfig: '/project/vm-images/tool-vms/default/build-config.json',
							},
						},
					},
				},
			},
			{
				buildGondolinImage: async () => {
					await new Promise<void>((resolve) => {
						finishGondolinBuild = resolve;
					});
					return { built: true, fingerprint: 'interactive-fp', imagePath: '/cache/interactive' };
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
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

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
				buildGondolinImage: async () => ({
					built: false,
					fingerprint: 'cached-fp',
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
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(taskStatuses).toContain('checking vm assets');
		expect(taskStatuses).toContain('vm assets cache hit');
	});

	it('auto-prunes old image generations after successful builds', async () => {
		const deleteStaleImageDirectories = vi.fn(async () => {});
		const findPrunableImageDirectories = vi.fn(async () => [
			{
				absolutePath: '/cache/gateway-images/openclaw/old',
				family: 'gateway' as const,
				fingerprint: 'old',
				modifiedAtMs: 1,
				profileName: 'openclaw',
				sizeBytes: 1024,
			},
		]);
		const statusMessages: string[] = [];

		await runBuildCommand(
			{
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => ({
					built: false,
					fingerprint: options.cacheDir.includes('gateway-images')
						? 'current-gateway'
						: 'current-tool',
					imagePath: path.join(options.cacheDir, 'current'),
				}),
				deleteStaleImageDirectories,
				findPrunableImageDirectories,
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: true,
						setOutput: () => {},
						setStatus: (status) => {
							if (status) {
								statusMessages.push(status);
							}
						},
					});
				},
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(findPrunableImageDirectories).toHaveBeenCalledWith({
			cacheDir: '/cache',
			currentFingerprints: {
				gateways: { openclaw: 'current-gateway' },
				toolVms: { default: 'current-tool' },
			},
			retainStaleGenerationsPerProfile: 2,
		});
		expect(deleteStaleImageDirectories).toHaveBeenCalledWith([
			expect.objectContaining({
				absolutePath: '/cache/gateway-images/openclaw/old',
			}),
		]);
		expect(statusMessages).toContain('deleted 1 old image generation');
	});

	it('waits for every Gondolin image target before auto-pruning', async () => {
		const buildOrder: string[] = [];

		await runBuildCommand(
			{
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => {
					buildOrder.push(`gondolin:${options.cacheDir}`);
					return {
						built: false,
						fingerprint: options.cacheDir.includes('gateway-images')
							? 'current-gateway'
							: 'current-tool',
						imagePath: path.join(options.cacheDir, 'current'),
					};
				},
				deleteStaleImageDirectories: async () => {},
				findPrunableImageDirectories: async () => {
					buildOrder.push('prune');
					return [];
				},
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: false,
						setOutput: () => {},
						setStatus: () => {},
					});
				},
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(buildOrder).toEqual([
			'gondolin:/cache/gateway-images/openclaw',
			'gondolin:/cache/tool-vm-images/default',
			'prune',
		]);
	});

	it('does not auto-prune when a Docker build fails', async () => {
		const deleteStaleImageDirectories = vi.fn(async () => {});
		const findPrunableImageDirectories = vi.fn(async () => []);

		await expect(
			runBuildCommand(
				{
					systemConfig: createTestSystemConfig(),
				},
				{
					buildDockerImage: async () => {
						throw new Error('docker failed');
					},
					buildGondolinImage: async () => ({
						built: false,
						fingerprint: 'current',
						imagePath: '/cache/current',
					}),
					deleteStaleImageDirectories,
					findPrunableImageDirectories,
					resolveOciImageTag: async () => 'agent-vm-gateway:latest',
					runTask: async (_title, fn) => {
						await fn({
							interactive: false,
							setOutput: () => {},
							setStatus: () => {},
						});
					},
					syncBundledOpenClawPlugin: noOpPluginSync,
				},
			),
		).rejects.toThrow('docker failed');

		expect(findPrunableImageDirectories).not.toHaveBeenCalled();
		expect(deleteStaleImageDirectories).not.toHaveBeenCalled();
	});

	it('does not auto-prune when a Gondolin build fails', async () => {
		const deleteStaleImageDirectories = vi.fn(async () => {});
		const findPrunableImageDirectories = vi.fn(async () => []);

		await expect(
			runBuildCommand(
				{
					systemConfig: createTestSystemConfig(),
				},
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => {
						throw new Error('gondolin failed');
					},
					deleteStaleImageDirectories,
					findPrunableImageDirectories,
					resolveOciImageTag: async () => 'agent-vm-gateway:latest',
					runTask: async (_title, fn) => {
						await fn({
							interactive: false,
							setOutput: () => {},
							setStatus: () => {},
						});
					},
					syncBundledOpenClawPlugin: noOpPluginSync,
				},
			),
		).rejects.toThrow('gondolin failed');

		expect(findPrunableImageDirectories).not.toHaveBeenCalled();
		expect(deleteStaleImageDirectories).not.toHaveBeenCalled();
	});

	it('warns without failing when post-build auto-prune deletion fails', async () => {
		const outputMessages: string[] = [];
		const statusMessages: string[] = [];

		await runBuildCommand(
			{
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => ({
					built: false,
					fingerprint: options.cacheDir.includes('gateway-images')
						? 'current-gateway'
						: 'current-tool',
					imagePath: path.join(options.cacheDir, 'current'),
				}),
				deleteStaleImageDirectories: async () => {
					throw new Error('file busy');
				},
				findPrunableImageDirectories: async () => [
					{
						absolutePath: '/cache/tool-vm-images/default/old',
						family: 'toolVm',
						fingerprint: 'old',
						modifiedAtMs: 1,
						profileName: 'default',
						sizeBytes: 1024,
					},
				],
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: true,
						setOutput: (output) => {
							outputMessages.push(typeof output === 'string' ? output : output.message);
						},
						setStatus: (status) => {
							if (status) {
								statusMessages.push(status);
							}
						},
					});
				},
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(outputMessages).toContain(
			'Image cache auto-prune failed after build succeeded: file busy',
		);
		expect(statusMessages).toContain('image cache auto-prune failed');
	});

	it('skips auto-prune when a gateway runtime record exists', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const stateDirectory = path.join(temporaryDirectory, 'state', 'test');
		fs.mkdirSync(stateDirectory, { recursive: true });
		fs.writeFileSync(path.join(stateDirectory, 'gateway-runtime.json'), '{}\n', 'utf8');
		const deleteStaleImageDirectories = vi.fn(async () => {});
		const findPrunableImageDirectories = vi.fn(async () => []);
		const outputMessages: string[] = [];
		const statusMessages: string[] = [];
		const systemConfig = createTestSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (!baseZone || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected an OpenClaw test zone.');
		}

		await runBuildCommand(
			{
				systemConfig: {
					...systemConfig,
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								stateDir: stateDirectory,
							},
						},
					],
				},
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => ({
					built: false,
					fingerprint: options.cacheDir.includes('gateway-images')
						? 'current-gateway'
						: 'current-tool',
					imagePath: path.join(options.cacheDir, 'current'),
				}),
				deleteStaleImageDirectories,
				findPrunableImageDirectories,
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: true,
						setOutput: (output) => {
							outputMessages.push(typeof output === 'string' ? output : output.message);
						},
						setStatus: (status) => {
							if (status) {
								statusMessages.push(status);
							}
						},
					});
				},
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(findPrunableImageDirectories).not.toHaveBeenCalled();
		expect(deleteStaleImageDirectories).not.toHaveBeenCalled();
		expect(outputMessages).toContain(
			'Image cache auto-prune skipped because gateway runtime records exist for zone(s): test-zone. Stop the controller before pruning old image generations.',
		);
		expect(statusMessages).toContain('image cache auto-prune skipped');
	});

	it('warns without failing when post-build auto-prune discovery fails', async () => {
		const outputMessages: string[] = [];
		const statusMessages: string[] = [];

		await runBuildCommand(
			{
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => ({
					built: false,
					fingerprint: options.cacheDir.includes('gateway-images')
						? 'current-gateway'
						: 'current-tool',
					imagePath: path.join(options.cacheDir, 'current'),
				}),
				deleteStaleImageDirectories: async () => {},
				findPrunableImageDirectories: async () => {
					throw new Error('cache scan failed');
				},
				resolveOciImageTag: async () => 'agent-vm-gateway:latest',
				runTask: async (_title, fn) => {
					await fn({
						interactive: true,
						setOutput: (output) => {
							outputMessages.push(typeof output === 'string' ? output : output.message);
						},
						setStatus: (status) => {
							if (status) {
								statusMessages.push(status);
							}
						},
					});
				},
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(outputMessages).toContain(
			'Image cache auto-prune failed after build succeeded: cache scan failed',
		);
		expect(statusMessages).toContain('image cache auto-prune failed');
	});

	it('does not require Zig for the normal published-helper Gondolin path', async () => {
		const dockerBuilds: string[] = [];
		const gondolinBuilds: string[] = [];
		const resolveRequiredZigVersion = vi.fn(async () => '0.15.2');
		const resolveZigVersion = vi.fn(async () => undefined);

		await runBuildCommandDefault(
			{
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push(options.imageTag);
				},
				buildGondolinImage: async (options) => {
					gondolinBuilds.push(options.buildConfigPath);
					return { built: true, fingerprint: 'zig-fp', imagePath: '/cache/zig' };
				},
				computeGondolinFingerprint: async () => 'zig-fp',
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
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(resolveRequiredZigVersion).not.toHaveBeenCalled();
		expect(resolveZigVersion).not.toHaveBeenCalled();
		expect(dockerBuilds).toEqual(['agent-vm-gateway:latest']);
		expect(gondolinBuilds).toEqual([
			'/project/vm-images/gateways/openclaw/build-config.json',
			'/project/vm-images/tool-vms/default/build-config.json',
		]);
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
						buildGondolinImage: async (options) => {
							gondolinBuilds.push(options.buildConfigPath);
							return { built: true, fingerprint: 'zig-fp', imagePath: '/cache/zig' };
						},
						resolveRequiredZigVersion: async () => '0.15.2',
						resolveZigVersion: async () => undefined,
						runTask: async (_title, fn) => {
							await fn();
						},
						syncBundledOpenClawPlugin: noOpPluginSync,
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
							openclaw: {
								type: 'openclaw',
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
							},
						},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push({ imageTag: options.imageTag });
				},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/cache/fp',
				}),
				runTask: async (_title, fn) => fn(),
				syncBundledOpenClawPlugin: noOpPluginSync,
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
							openclaw: {
								type: 'openclaw',
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
							},
						},
					},
				},
			},
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push({ imageTag: options.imageTag });
				},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/cache/fp',
				}),
				runTask: async (_title, fn) => fn(),
				syncBundledOpenClawPlugin: noOpPluginSync,
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
								openclaw: {
									type: 'openclaw',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
					syncBundledOpenClawPlugin: noOpPluginSync,
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
								openclaw: {
									type: 'openclaw',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
					syncBundledOpenClawPlugin: noOpPluginSync,
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
								openclaw: {
									type: 'openclaw',
									buildConfig: missingBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
					syncBundledOpenClawPlugin: noOpPluginSync,
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
								openclaw: {
									type: 'openclaw',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/cache/fp',
					}),
					runTask: async (_title, fn) => fn(),
					syncBundledOpenClawPlugin: noOpPluginSync,
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
								openclaw: {
									type: 'openclaw',
									buildConfig: gatewayBuildConfigPath,
									dockerfile: '/project/vm-images/gateways/openclaw/Dockerfile',
								},
							},
						},
					},
				},
				{
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
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
