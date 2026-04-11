import { describe, expect, it } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { runBuildCommand, type BuildCommandDependencies } from './build-command.js';

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
});
