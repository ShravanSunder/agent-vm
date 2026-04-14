import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
	buildGondolinImage,
	computeFingerprintFromConfigPath,
	type GondolinImageBuilderDependencies,
} from './gondolin-image-builder.js';

describe('buildGondolinImage', () => {
	it('passes cacheDir, configDir, and fullReset through to the core builder', async () => {
		const buildImageCalls: {
			readonly cacheDir: string;
			readonly configDir?: string;
			readonly fullReset?: boolean;
		}[] = [];
		const dependencies: GondolinImageBuilderDependencies = {
			loadBuildConfig: async () => ({
				arch: 'aarch64',
				distro: 'alpine',
			}),
			buildImage: async (options) => {
				buildImageCalls.push(
					{
						cacheDir: options.cacheDir,
						...(options.configDir ? { configDir: options.configDir } : {}),
						...(options.fullReset ? { fullReset: true } : {}),
					} satisfies {
						readonly cacheDir: string;
						readonly configDir?: string;
						readonly fullReset?: boolean;
					},
				);
				return {
					built: true,
					fingerprint: 'abc123',
					imagePath: '/cache/abc123',
				};
			},
		};

		const result = await buildGondolinImage(
			{
				buildConfigPath: '/project/images/gateway/build-config.json',
				cacheDir: '/cache/images/gateway',
				fullReset: true,
			},
			dependencies,
		);

		expect(result.fingerprint).toBe('abc123');
		expect(buildImageCalls).toEqual([
			{
				cacheDir: '/cache/images/gateway',
				configDir: '/project/images/gateway',
				fullReset: true,
			},
		]);
	});
});

describe('computeFingerprintFromConfigPath', () => {
	it('produces the same fingerprint for identical build configs', async () => {
		const temporaryConfigPath = `${process.cwd()}/packages/agent-vm/.tmp-build-config.json`;
		const fileContents = JSON.stringify({ arch: 'aarch64', distro: 'alpine' });
		await fs.writeFile(temporaryConfigPath, fileContents, 'utf8');

		const firstFingerprint = await computeFingerprintFromConfigPath(temporaryConfigPath);
		const secondFingerprint = await computeFingerprintFromConfigPath(temporaryConfigPath);

		await fs.rm(temporaryConfigPath, { force: true });

		expect(firstFingerprint).toBe(secondFingerprint);
	});
});
