import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	buildGondolinImage,
	computeFingerprintFromConfigPath,
	runGondolinBuildChildProcess,
	type GondolinImageBuilderDependencies,
	type GondolinImageBuildRequest,
} from './gondolin-image-builder.js';

describe('buildGondolinImage', () => {
	it('streams child-process output while waiting for the Gondolin build result', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-gondolin-child-'),
		);
		const childModulePath = path.join(temporaryDirectoryPath, 'fake-gondolin-child.mjs');
		await fs.writeFile(
			childModulePath,
			`
process.on('message', () => {
	process.stdout.write('stdout progress\\n');
	process.stderr.write('stderr progress\\n');
	process.send({
		type: 'result',
		result: { built: true, fingerprint: 'child-fp', imagePath: '/cache/child-fp' },
	});
	process.disconnect();
});
`,
			'utf8',
		);
		const streamPreviewChunks: string[] = [];

		const result = await runGondolinBuildChildProcess({
			childModuleUrl: pathToFileURL(childModulePath),
			request: {
				buildConfigPath: '/project/build-config.json',
				cacheDir: '/cache/gateway-images/openclaw',
				systemCacheIdentifierPath: '/project/system-cache-identifier.json',
			},
			streamPreview: {
				write(chunk) {
					streamPreviewChunks.push(String(chunk));
					return true;
				},
			},
		});

		expect(result).toEqual({
			built: true,
			fingerprint: 'child-fp',
			imagePath: '/cache/child-fp',
		});
		expect(streamPreviewChunks.join('')).toContain('stdout progress\n');
		expect(streamPreviewChunks.join('')).toContain('stderr progress\n');

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('delegates interactive builds to the child-process runner', async () => {
		const childBuildRequests: {
			readonly request: GondolinImageBuildRequest;
			readonly streamPreviewChunks: readonly string[];
		}[] = [];
		const streamPreviewChunks: string[] = [];
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-system-cache-id-'),
		);
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		await fs.writeFile(
			systemCacheIdentifierPath,
			JSON.stringify({ gitSha: 'abc123', schemaVersion: 1 }),
			'utf8',
		);
		const dependencies: GondolinImageBuilderDependencies = {
			loadBuildConfig: async () => ({
				arch: 'aarch64',
				distro: 'alpine',
			}),
			runBuildChildProcess: async (options) => {
				options.streamPreview.write('building rootfs\n');
				childBuildRequests.push({
					request: options.request,
					streamPreviewChunks: [...streamPreviewChunks],
				});
				return {
					built: true,
					fingerprint: 'child-fp',
					imagePath: '/cache/child-fp',
				};
			},
		};

		const result = await buildGondolinImage(
			{
				buildConfigPath: '/project/vm-images/gateways/openclaw/build-config.json',
				systemCacheIdentifierPath,
				cacheDir: '/cache/gateway-images/openclaw',
				fullReset: true,
				streamPreview: {
					write(chunk) {
						streamPreviewChunks.push(String(chunk));
						return true;
					},
				},
			},
			dependencies,
		);

		expect(result.fingerprint).toBe('child-fp');
		expect(streamPreviewChunks).toEqual(['building rootfs\n']);
		expect(childBuildRequests).toEqual([
			{
				request: {
					buildConfigPath: '/project/vm-images/gateways/openclaw/build-config.json',
					cacheDir: '/cache/gateway-images/openclaw',
					fullReset: true,
					systemCacheIdentifierPath,
				},
				streamPreviewChunks: ['building rootfs\n'],
			},
		]);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('passes cacheDir, configDir, and fullReset through to the core builder', async () => {
		const buildImageCalls: {
			readonly fingerprintInput: unknown;
			readonly cacheDir: string;
			readonly configDir?: string;
			readonly fullReset?: boolean;
			readonly gondolinVersion?: string;
		}[] = [];
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-system-cache-id-'),
		);
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		await fs.writeFile(
			systemCacheIdentifierPath,
			JSON.stringify({ gitSha: 'abc123', schemaVersion: 1 }),
			'utf8',
		);
		const dependencies: GondolinImageBuilderDependencies = {
			loadBuildConfig: async () => ({
				arch: 'aarch64',
				distro: 'alpine',
			}),
			resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			buildImage: async (options, buildDependencies) => {
				buildImageCalls.push(
					{
						cacheDir: options.cacheDir,
						fingerprintInput: options.fingerprintInput,
						...(options.configDir ? { configDir: options.configDir } : {}),
						...(options.fullReset ? { fullReset: true } : {}),
						...(buildDependencies?.gondolinVersion
							? { gondolinVersion: buildDependencies.gondolinVersion }
							: {}),
					} satisfies {
						readonly fingerprintInput: unknown;
						readonly cacheDir: string;
						readonly configDir?: string;
						readonly fullReset?: boolean;
						readonly gondolinVersion?: string;
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
				buildConfigPath: '/project/vm-images/gateways/openclaw/build-config.json',
				systemCacheIdentifierPath,
				cacheDir: '/cache/gateway-images/openclaw',
				fullReset: true,
			},
			dependencies,
		);

		expect(result.fingerprint).toBe('abc123');
		expect(buildImageCalls).toEqual([
			{
				fingerprintInput: {
					gitSha: 'abc123',
					schemaVersion: 1,
				},
				cacheDir: '/cache/gateway-images/openclaw',
				configDir: '/project/vm-images/gateways/openclaw',
				fullReset: true,
				gondolinVersion: 'runtime@1',
			},
		]);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});
});

describe('computeFingerprintFromConfigPath', () => {
	it('produces the same fingerprint for identical build configs', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-build-config-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const systemCacheIdentifierPath = path.join(
			temporaryDirectoryPath,
			'systemCacheIdentifier.json',
		);
		const fileContents = JSON.stringify({ arch: 'aarch64', distro: 'alpine' });
		await fs.writeFile(temporaryConfigPath, fileContents, 'utf8');
		await fs.writeFile(
			systemCacheIdentifierPath,
			JSON.stringify({ gitSha: 'abc123', schemaVersion: 1 }),
			'utf8',
		);

		const firstFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			systemCacheIdentifierPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);
		const secondFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			systemCacheIdentifierPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });

		expect(firstFingerprint).toBe(secondFingerprint);
	});

	it('fails when system cache identifier is missing while computing fingerprints', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const identifierPath = path.join(temporaryDirectoryPath, 'systemCacheIdentifier.json');
		await fs.writeFile(temporaryConfigPath, JSON.stringify(baseBuildConfig()), 'utf8');

		await expect(
			computeFingerprintFromConfigPath(temporaryConfigPath, identifierPath, {
				resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			}),
		).rejects.toThrow(`Missing system cache identifier '${identifierPath}'`);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('includes the build config path when the build config is missing', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const identifierPath = path.join(temporaryDirectoryPath, 'systemCacheIdentifier.json');

		await expect(
			computeFingerprintFromConfigPath(temporaryConfigPath, identifierPath, {
				resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			}),
		).rejects.toThrow(`Failed to read build config '${temporaryConfigPath}'`);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('includes the build config path when the build config is malformed', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const identifierPath = path.join(temporaryDirectoryPath, 'systemCacheIdentifier.json');
		await fs.writeFile(temporaryConfigPath, '{broken', 'utf8');

		await expect(
			computeFingerprintFromConfigPath(temporaryConfigPath, identifierPath, {
				resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			}),
		).rejects.toThrow(`Failed to parse build config '${temporaryConfigPath}'`);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('fails when system cache identifier is malformed while computing fingerprints', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const identifierPath = path.join(temporaryDirectoryPath, 'systemCacheIdentifier.json');
		await fs.writeFile(temporaryConfigPath, JSON.stringify(baseBuildConfig()), 'utf8');
		await fs.writeFile(identifierPath, '{broken', 'utf8');

		await expect(
			computeFingerprintFromConfigPath(temporaryConfigPath, identifierPath, {
				resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			}),
		).rejects.toThrow(`Failed to parse system cache identifier '${identifierPath}'`);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('changes fingerprints when the runtime build version tag changes', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const identifierPath = path.join(temporaryDirectoryPath, 'systemCacheIdentifier.json');
		await fs.writeFile(temporaryConfigPath, JSON.stringify(baseBuildConfig()), 'utf8');
		await fs.writeFile(identifierPath, JSON.stringify({ schemaVersion: 1, gitSha: 'abc123' }), 'utf8');

		const firstFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			identifierPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);
		const secondFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			identifierPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@2' },
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });

		expect(firstFingerprint).not.toBe(secondFingerprint);
	});

	it('changes fingerprints when the system cache identifier contents change', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const firstIdentifierPath = path.join(temporaryDirectoryPath, 'systemCacheIdentifier-a.json');
		const secondIdentifierPath = path.join(temporaryDirectoryPath, 'systemCacheIdentifier-b.json');
		await fs.writeFile(
			temporaryConfigPath,
			JSON.stringify(baseBuildConfig()),
			'utf8',
		);
		await fs.writeFile(
			firstIdentifierPath,
			JSON.stringify({ schemaVersion: 1, gitSha: 'abc123' }),
			'utf8',
		);
		await fs.writeFile(
			secondIdentifierPath,
			JSON.stringify({ schemaVersion: 1, gitSha: 'def456' }),
			'utf8',
		);

		const firstFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			firstIdentifierPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);
		const secondFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			secondIdentifierPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });

		expect(firstFingerprint).not.toBe(secondFingerprint);
	});
});

function baseBuildConfig(): { readonly arch: string; readonly distro: string } {
	return { arch: 'aarch64', distro: 'alpine' };
}
