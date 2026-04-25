import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { BuildConfig } from '@agent-vm/gondolin-adapter';
import { describe, expect, it } from 'vitest';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import { createLoadedSystemConfig } from '../../config/system-config.js';
import { isGatewayImageCached } from './controller-definition.js';

describe('isGatewayImageCached', () => {
	it('uses the system cache identifier when resolving the current gateway fingerprint', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-controller-cache-'),
		);
		const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
		const buildConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'config',
			'systemCacheIdentifier.json',
		);
		const cacheDir = path.join(temporaryDirectoryPath, 'cache');
		const buildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
		} satisfies Partial<BuildConfig>;
		const systemCacheIdentifier = {
			gitSha: 'controller-cache-sha',
			schemaVersion: 1,
		};
		await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
		await fs.writeFile(buildConfigPath, JSON.stringify(buildConfig), 'utf8');
		await fs.writeFile(systemCacheIdentifierPath, JSON.stringify(systemCacheIdentifier), 'utf8');

		const fingerprintWithSystemCacheIdentifier = await computeFingerprintFromConfigPath(
			buildConfigPath,
			systemCacheIdentifierPath,
		);
		const gatewayCachePath = path.join(
			cacheDir,
			'gateway-images',
			'worker',
			fingerprintWithSystemCacheIdentifier,
		);
		await fs.mkdir(gatewayCachePath, { recursive: true });
		await fs.writeFile(path.join(gatewayCachePath, 'manifest.json'), '{}\n', 'utf8');

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
				toolProfiles: {
					standard: {
						cpus: 1,
						imageProfile: 'default',
						memory: '1G',
						workspaceRoot: '/tmp/tools',
					},
				},
				zones: [
					{
						allowedHosts: ['api.openai.com'],
						gateway: {
							type: 'worker',
							imageProfile: 'worker',
							cpus: 2,
							config: '/tmp/gateway.json',
							memory: '2G',
							port: 18791,
							stateDir: '/tmp/state',
							workspaceDir: '/tmp/workspace',
						},
						id: 'coding-agent',
						secrets: {},
						toolProfile: 'standard',
						websocketBypass: [],
					},
				],
			},
			{ systemConfigPath },
		);

		await expect(isGatewayImageCached(systemConfig, 'coding-agent')).resolves.toBe(true);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});
});
