import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
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
		host: {
			controllerPort: 18800,
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
					cpus: 2,
					memory: '2G',
					openclawConfig: './config/test/openclaw.json',
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

describe('runBuildCommand', () => {
	it('builds Docker image when dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const dependencies: BuildCommandDependencies = {
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildGondolinImage: async () => ({
				built: true,
				fingerprint: 'abc123',
				imagePath: '/cache/abc123',
			}),
			resolveOciImageTag: async () => 'agent-vm-gateway:latest',
		};

		await runBuildCommand(
			{ systemConfig: createTestSystemConfig() },
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			dependencies,
		);

		expect(dockerBuilds).toHaveLength(1);
		expect(dockerBuilds[0]?.dockerfilePath).toBe('/project/images/gateway/Dockerfile');
		expect(dockerBuilds[0]?.imageTag).toBe('agent-vm-gateway:latest');
	});

	it('skips Docker build when no dockerfile is configured', async () => {
		const dockerBuilds: { dockerfilePath: string; imageTag: string }[] = [];
		const dependencies: BuildCommandDependencies = {
			buildDockerImage: async (options) => {
				dockerBuilds.push(options);
			},
			buildGondolinImage: async () => ({
				built: false,
				fingerprint: 'cached',
				imagePath: '/cache/cached',
			}),
			resolveOciImageTag: async () => 'agent-vm-tool:latest',
		};

		await runBuildCommand(
			{ systemConfig: createTestSystemConfig() },
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			dependencies,
		);

		expect(dockerBuilds).toHaveLength(1);
	});

	it('builds Gondolin assets for each zone into the zone state dir', async () => {
		const gondolinBuilds: { cacheDir: string }[] = [];
		const dependencies: BuildCommandDependencies = {
			buildDockerImage: async () => {},
			buildGondolinImage: async (options) => {
				gondolinBuilds.push({ cacheDir: options.cacheDir });
				return { built: true, fingerprint: 'f1', imagePath: '/cache/f1' };
			},
			resolveOciImageTag: async () => 'tag:latest',
		};

		await runBuildCommand(
			{ systemConfig: createTestSystemConfig() },
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			dependencies,
		);

		expect(gondolinBuilds).toHaveLength(2);
		expect(gondolinBuilds[0]?.cacheDir).toBe('/state/test/images/gateway');
		expect(gondolinBuilds[1]?.cacheDir).toBe('/state/test/images/tool');
	});

	it('builds Gondolin assets for multiple zones into distinct cache directories', async () => {
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
			buildDockerImage: async () => {},
			buildGondolinImage: async (options) => {
				gondolinBuilds.push({ cacheDir: options.cacheDir });
				return { built: true, fingerprint: 'zone-fp', imagePath: '/cache/zone-fp' };
			},
			resolveOciImageTag: async () => 'tag:latest',
		};

		await runBuildCommand(
			{ systemConfig: multiZoneConfig },
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			dependencies,
		);

		expect(gondolinBuilds).toHaveLength(4);
		expect(gondolinBuilds.map((build) => build.cacheDir)).toEqual([
			'/state/zone-a/images/gateway',
			'/state/zone-a/images/tool',
			'/state/zone-b/images/gateway',
			'/state/zone-b/images/tool',
		]);
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
			{ stderr: { write: () => true }, stdout: { write: () => true } },
			{
				buildDockerImage: async (options) => {
					dockerBuilds.push({ imageTag: options.imageTag });
				},
				buildGondolinImage: async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/cache/fp',
				}),
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
				{ stderr: { write: () => true }, stdout: { write: () => true } },
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/cache/fp',
					}),
				},
			),
		).rejects.toThrow('has no valid oci.image tag');
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
				{ stderr: { write: () => true }, stdout: { write: () => true } },
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/cache/fp',
					}),
				},
			),
		).rejects.toThrow('has no valid oci.image tag');
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
				{ stderr: { write: () => true }, stdout: { write: () => true } },
				{
					buildDockerImage: async () => {},
					buildGondolinImage: async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/cache/fp',
					}),
				},
			),
		).rejects.toThrow();
	});
});
