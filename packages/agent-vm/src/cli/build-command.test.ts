import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import {
	runBuildCommand as runBuildCommandDefault,
	type BuildCommandDependencies,
} from './build-command.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-build-command-'));
	createdDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

function createTestSystemConfig(): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			cacheDir: '/cache',
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
					allowedHosts: ['example.com'],
					gateway: {
						type: 'openclaw',
						imageProfile: 'openclaw',
						cpus: 2,
						memory: '2G',
						config: './config/test/openclaw.json',
						port: 18791,
						stateDir: '/state/test',
						workspaceDir: '/workspaces/test',
					},
					id: 'test-zone',
					secrets: {},
					toolProfile: 'standard',
					websocketBypass: [],
				},
			],
			toolProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
					workspaceRoot: '/workspaces/tools',
				},
			},
			tcpPool: { basePort: 19000, size: 5 },
		},
		{ systemConfigPath: '/project/config/system.json' },
	);
}

const noOpPluginSync: NonNullable<
	BuildCommandDependencies['syncBundledOpenClawPlugin']
> = async () => 'created';

async function runBuildCommand(
	options: Parameters<typeof runBuildCommandDefault>[0],
	dependencies: BuildCommandDependencies = {},
): Promise<void> {
	await runBuildCommandDefault(options, {
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
			systemCacheIdentifierPath: string;
			fullReset: boolean | undefined;
		}[] = [];
		const dependencies: BuildCommandDependencies = {
			runTask: async (_title, fn) => fn(),
			buildDockerImage: async () => {},
			buildGondolinImage: async (options) => {
				gondolinBuilds.push({
					cacheDir: options.cacheDir,
					systemCacheIdentifierPath: options.systemCacheIdentifierPath,
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
			systemCacheIdentifierPath: '/project/config/systemCacheIdentifier.json',
			fullReset: true,
		});
		expect(gondolinBuilds[1]).toEqual({
			cacheDir: '/cache/tool-vm-images/default',
			systemCacheIdentifierPath: '/project/config/systemCacheIdentifier.json',
			fullReset: undefined,
		});
	});

	it('forces a Gondolin reset for any target rebuilt from a Dockerfile in this invocation', async () => {
		const gondolinBuilds: { cacheDir: string; fullReset: boolean | undefined }[] = [];

		await runBuildCommand(
			{ systemConfig: createTestSystemConfig() },
			{
				buildDockerImage: async () => {},
				buildGondolinImage: async (options) => {
					gondolinBuilds.push({
						cacheDir: options.cacheDir,
						fullReset: options.fullReset,
					});
					return { built: true, fingerprint: 'docker-refresh', imagePath: '/cache/docker-refresh' };
				},
				resolveOciImageTag: async () => 'tag:latest',
				runTask: async (_title, fn) => await fn(),
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(gondolinBuilds).toEqual([
			{ cacheDir: '/cache/gateway-images/openclaw', fullReset: true },
			{ cacheDir: '/cache/tool-vm-images/default', fullReset: undefined },
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

	it('routes Tasuku task status and stream preview into Docker and Gondolin builds', async () => {
		const taskStreamPreview = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const dockerStreamPreviews: unknown[] = [];
		const gondolinStreamPreviews: unknown[] = [];
		const taskStatuses: (string | undefined)[] = [];

		await runBuildCommand(
			{
				systemConfig: createTestSystemConfig(),
			},
			{
				buildDockerImage: async (options) => {
					dockerStreamPreviews.push(options.streamPreview);
				},
				buildGondolinImage: async (options) => {
					gondolinStreamPreviews.push(options.streamPreview);
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
						streamPreview: taskStreamPreview,
					});
				},
				syncBundledOpenClawPlugin: noOpPluginSync,
			},
		);

		expect(dockerStreamPreviews).toEqual([taskStreamPreview]);
		expect(gondolinStreamPreviews).toEqual([taskStreamPreview, taskStreamPreview]);
		expect(taskStatuses).toContain('docker build');
		expect(taskStatuses).toContain('docker image ready');
		expect(taskStatuses).toContain('vm assets');
		expect(taskStatuses).toContain('vm assets ready');
	});

	it('fails before image builds when Zig is missing', async () => {
		const dockerBuilds: string[] = [];
		const gondolinBuilds: string[] = [];

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
