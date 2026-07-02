import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildImageAssetFileNames } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import { writePreparedGondolinImage } from '../../build/prepared-gondolin-image-cache.js';
import { createLoadedSystemConfig } from '../../config/system-config.js';
import { isGatewayImageCached } from './controller-definition.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-controller-cache-'));
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function writeFakeImageAssets(imagePath: string): Promise<void> {
	await fs.mkdir(imagePath, { recursive: true });
	await Promise.all(
		buildImageAssetFileNames.map(
			async (fileName) => await fs.writeFile(path.join(imagePath, fileName), '', 'utf8'),
		),
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directoryPath) => await fs.rm(directoryPath, { recursive: true, force: true })),
	);
});

describe('isGatewayImageCached', () => {
	it('accepts the build-prepared gateway image cache record', async () => {
		const temporaryDirectoryPath = await createTemporaryDirectory();
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const buildConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const cacheDir = path.join(temporaryDirectoryPath, 'cache');
		const gatewayProfileCacheDirectory = path.join(cacheDir, 'gateway-images', 'worker');
		const imagePath = path.join(gatewayProfileCacheDirectory, 'docker-backed-fingerprint');
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.writeFile(
			buildConfigPath,
			JSON.stringify({ arch: 'aarch64', distro: 'alpine' }),
			'utf8',
		);
		await writeFakeImageAssets(imagePath);
		await writePreparedGondolinImage({
			buildConfigPath,
			cacheDir: gatewayProfileCacheDirectory,
			fingerprint: 'docker-backed-fingerprint',
			fingerprintInput: {
				dockerRootfsIdentity: {
					architecture: 'arm64',
					layers: ['sha256:rootfs-layer'],
					os: 'linux',
				},
				schemaVersion: 1,
			},
			imagePath,
		});

		const systemConfig = createLoadedSystemConfig(
			{
				cacheDir,
				host: {
					controllerPort: 18800,
					projectNamespace: 'cache-test',
				},
				imageProfiles: {
					gateways: {
						worker: {
							type: 'worker',
							buildConfig: buildConfigPath,
						},
					},
					toolVms: {
						default: {
							type: 'toolVm',
							buildConfig: '/unused/tool-build-config.json',
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
						imageProfile: 'default',
						memory: '1G',
					},
				},
				zones: [
					{
						egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
						gateway: {
							type: 'worker',
							imageProfile: 'worker',
							cpus: 2,
							config: '/tmp/gateway.json',
							memory: '2G',
							port: 18791,
							stateDir: '/tmp/state',
						},
						id: 'coding-agent',
						secrets: {},
					},
				],
			},
			{ systemConfigPath },
		);

		await expect(isGatewayImageCached(systemConfig, 'coding-agent')).resolves.toBe(true);
	});
});
