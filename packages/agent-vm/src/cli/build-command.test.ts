import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { runBuildCommand, type BuildCommandDependencies } from './build-command.js';

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

function createTestSystemConfig(): SystemConfig {
	return {
		cacheDir: '/cache',
		host: {
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
			secretsProvider: { type: '1password', tokenSource: { type: 'env' } },
		},
		images: {
			gateway: {
				buildConfig: '/project/images/gateway/build-config.json',
				dockerfile: '/project/images/gateway/Dockerfile',
			},
			tool: {
				buildConfig: '/project/images/tool/build-config.json',
			},
		},
		zones: [
			{
				allowedHosts: ['example.com'],
				gateway: {
					type: 'openclaw',
					cpus: 2,
					memory: '2G',
					gatewayConfig: './config/test/openclaw.json',
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
			standard: { cpus: 1, memory: '1G', workspaceRoot: '/workspaces/tools' },
		},
		tcpPool: { basePort: 19000, size: 5 },
	};
}

const noOpPluginSync: NonNullable<
	BuildCommandDependencies['syncBundledOpenClawPlugin']
> = async () => 'created';

describe('runBuildCommand', () => {
	it('builds Docker image when dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const pluginSyncs: string[] = [];
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
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
			syncBundledOpenClawPlugin: async (targetDir) => {
				pluginSyncs.push(targetDir);
				return 'created';
			},
		};

		await runBuildCommand({ systemConfig: createTestSystemConfig() }, dependencies);

		expect(dockerBuilds).toHaveLength(1);
		expect(dockerBuilds[0]?.dockerfilePath).toBe('/project/images/gateway/Dockerfile');
		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:latest');
		expect(pluginSyncs).toEqual(['/project']);
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
					zones: [
						{
							...baseZone,
							gateway: {
								...baseZone.gateway,
								type: 'worker',
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
		const gondolinBuilds: { cacheDir: string; fullReset: boolean | undefined }[] = [];
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
			cacheDir: '/cache/images/gateway',
			fullReset: true,
		});
		expect(gondolinBuilds[1]).toEqual({
			cacheDir: '/cache/images/tool',
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
			{ cacheDir: '/cache/images/gateway', fullReset: true },
			{ cacheDir: '/cache/images/tool', fullReset: undefined },
		]);
	});

	it('reuses the same shared Gondolin cache directories across multiple zones', async () => {
		const gondolinBuilds: { cacheDir: string }[] = [];
		const baseConfig = createTestSystemConfig();
		const baseZone = baseConfig.zones[0];
		if (!baseZone) {
			throw new Error('Expected base test zone');
		}
		const multiZoneConfig: SystemConfig = {
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
			'/cache/images/gateway',
			'/cache/images/tool',
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
			{ cacheDir: '/cache/images/gateway', fullReset: true },
			{ cacheDir: '/cache/images/tool', fullReset: true },
		]);
		expect(taskTitles).toContain('Gondolin: gateway');
		expect(taskTitles).toContain('Gondolin: tool');
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
					images: {
						...createTestSystemConfig().images,
						gateway: {
							buildConfig: gatewayBuildConfigPath,
							dockerfile: '/project/images/gateway/Dockerfile',
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
						images: {
							...createTestSystemConfig().images,
							gateway: {
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/images/gateway/Dockerfile',
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
						images: {
							...createTestSystemConfig().images,
							gateway: {
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/images/gateway/Dockerfile',
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

	it('throws when build-config.json is malformed JSON', async () => {
		const temporaryDirectory = createTemporaryDirectory();
		const gatewayBuildConfigPath = path.join(temporaryDirectory, 'gateway-build-config.json');
		fs.writeFileSync(gatewayBuildConfigPath, '{"oci":', 'utf8');

		await expect(
			runBuildCommand(
				{
					systemConfig: {
						...createTestSystemConfig(),
						images: {
							...createTestSystemConfig().images,
							gateway: {
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/images/gateway/Dockerfile',
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
						images: {
							...createTestSystemConfig().images,
							gateway: {
								buildConfig: gatewayBuildConfigPath,
								dockerfile: '/project/images/gateway/Dockerfile',
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
