import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	buildGondolinImage,
	computeFingerprintFromConfigPath,
	runGondolinBuildChildProcess,
	runGondolinImageBuildRequest,
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

	it('resolves when the child sends a result even if the child stays alive briefly', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-gondolin-child-'),
		);
		const childModulePath = path.join(temporaryDirectoryPath, 'sticky-gondolin-child.mjs');
		await fs.writeFile(
			childModulePath,
			`
process.on('message', () => {
	process.send({
		type: 'result',
		result: { built: true, fingerprint: 'sticky-fp', imagePath: '/cache/sticky-fp' },
	});
	setInterval(() => {}, 1000);
});
`,
			'utf8',
		);

		const result = await runGondolinBuildChildProcess({
			childModuleUrl: pathToFileURL(childModulePath),
			request: {
				buildConfigPath: '/project/build-config.json',
				cacheDir: '/cache/gateway-images/openclaw',
			},
			streamPreview: {
				write() {
					return true;
				},
			},
		});

		expect(result).toEqual({
			built: true,
			fingerprint: 'sticky-fp',
			imagePath: '/cache/sticky-fp',
		});

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('includes stderr tail when the child exits before sending a structured result', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-gondolin-child-'),
		);
		const childModulePath = path.join(temporaryDirectoryPath, 'failing-gondolin-child.mjs');
		await fs.writeFile(
			childModulePath,
			`
process.stderr.write('exploded before ipc\\n');
process.exit(1);
`,
			'utf8',
		);

		await expect(
			runGondolinBuildChildProcess({
				childModuleUrl: pathToFileURL(childModulePath),
				request: {
					buildConfigPath: '/project/build-config.json',
					cacheDir: '/cache/gateway-images/openclaw',
				},
				streamPreview: {
					write() {
						return true;
					},
				},
			}),
		).rejects.toThrow('exploded before ipc');

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('delegates interactive builds to the child-process runner', async () => {
		const childBuildRequests: {
			readonly request: GondolinImageBuildRequest;
			readonly streamPreviewChunks: readonly string[];
		}[] = [];
		const streamPreviewChunks: string[] = [];
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
					previewOutput: true,
				},
				streamPreviewChunks: ['building rootfs\n'],
			},
		]);
	});

	it('delegates production builds to the child-process runner without rendering child output', async () => {
		const childBuildRequests: GondolinImageBuildRequest[] = [];
		let childStreamWriteResult: boolean | undefined;
		const dependencies: GondolinImageBuilderDependencies = {
			runBuildChildProcess: async (options) => {
				childBuildRequests.push(options.request);
				childStreamWriteResult = options.streamPreview.write('hidden rootfs progress\n');
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
				cacheDir: '/cache/gateway-images/openclaw',
			},
			dependencies,
		);

		expect(result.fingerprint).toBe('child-fp');
		expect(childStreamWriteResult).toBe(true);
		expect(childBuildRequests).toEqual([
			{
				buildConfigPath: '/project/vm-images/gateways/openclaw/build-config.json',
				cacheDir: '/cache/gateway-images/openclaw',
			},
		]);
	});

	it('passes cacheDir, configDir, and fullReset through to the core builder', async () => {
		const buildImageCalls: {
			readonly cacheDir: string;
			readonly configDir?: string;
			readonly fullReset?: boolean;
			readonly gondolinVersion?: string;
			readonly hasOutput: boolean;
		}[] = [];
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
						...(options.configDir ? { configDir: options.configDir } : {}),
						...(options.fullReset ? { fullReset: true } : {}),
						...(buildDependencies?.gondolinVersion
							? { gondolinVersion: buildDependencies.gondolinVersion }
							: {}),
						hasOutput: options.output !== undefined,
					} satisfies {
						readonly cacheDir: string;
						readonly configDir?: string;
						readonly fullReset?: boolean;
						readonly gondolinVersion?: string;
						readonly hasOutput: boolean;
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
				cacheDir: '/cache/gateway-images/openclaw',
				fullReset: true,
			},
			dependencies,
		);

		expect(result.fingerprint).toBe('abc123');
		expect(buildImageCalls).toEqual([
			{
				cacheDir: '/cache/gateway-images/openclaw',
				configDir: '/project/vm-images/gateways/openclaw',
				fullReset: true,
				gondolinVersion: 'runtime@1',
				hasOutput: false,
			},
		]);
	});

	it('passes an output stream to the core builder for preview requests', async () => {
		const outputPresence: boolean[] = [];
		const dependencies: GondolinImageBuilderDependencies = {
			loadBuildConfig: async () => ({
				arch: 'aarch64',
				distro: 'alpine',
			}),
			resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			buildImage: async (options) => {
				outputPresence.push(options.output !== undefined);
				return {
					built: true,
					fingerprint: 'preview-fp',
					imagePath: '/cache/preview-fp',
				};
			},
		};

		const result = await runGondolinImageBuildRequest(
			{
				buildConfigPath: '/project/vm-images/gateways/openclaw/build-config.json',
				cacheDir: '/cache/gateway-images/openclaw',
				previewOutput: true,
			},
			dependencies,
		);

		expect(result.fingerprint).toBe('preview-fp');
		expect(outputPresence).toEqual([true]);
	});

	it('uses the original stderr writer for preview output after stderr is redirected', async () => {
		const stderrChunks: string[] = [];
		const originalStderrWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrChunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		const dependencies: GondolinImageBuilderDependencies = {
			loadBuildConfig: async () => ({
				arch: 'aarch64',
				distro: 'alpine',
			}),
			resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			buildImage: async (options) => {
				process.stderr.write = (() => {
					throw new Error('preview output used redirected stderr');
				}) as typeof process.stderr.write;
				try {
					options.output?.write('preview phase\n');
				} finally {
					process.stderr.write = originalStderrWrite;
				}
				return {
					built: true,
					fingerprint: 'preview-fp',
					imagePath: '/cache/preview-fp',
				};
			},
		};

		const result = await (async () => {
			try {
				return await runGondolinImageBuildRequest(
					{
						buildConfigPath: '/project/vm-images/gateways/openclaw/build-config.json',
						cacheDir: '/cache/gateway-images/openclaw',
						previewOutput: true,
					},
					dependencies,
				);
			} finally {
				process.stderr.write = originalStderrWrite;
			}
		})();

		expect(result.fingerprint).toBe('preview-fp');
		expect(stderrChunks).toEqual(['preview phase\n']);
	});
});

describe('computeFingerprintFromConfigPath', () => {
	it('produces the same fingerprint for identical build configs', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-build-config-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const fileContents = JSON.stringify({ arch: 'aarch64', distro: 'alpine' });
		await fs.writeFile(temporaryConfigPath, fileContents, 'utf8');

		const firstFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);
		const secondFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });

		expect(firstFingerprint).toBe(secondFingerprint);
	});

	it('includes the build config path when the build config is missing', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');

		await expect(
			computeFingerprintFromConfigPath(temporaryConfigPath, {
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
		await fs.writeFile(temporaryConfigPath, '{broken', 'utf8');

		await expect(
			computeFingerprintFromConfigPath(temporaryConfigPath, {
				resolveRuntimeBuildVersionTag: async () => 'runtime@1',
			}),
		).rejects.toThrow(`Failed to parse build config '${temporaryConfigPath}'`);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
	});

	it('changes fingerprints when the runtime build version tag changes', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		await fs.writeFile(temporaryConfigPath, JSON.stringify(baseBuildConfig()), 'utf8');

		const firstFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);
		const secondFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@2' },
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });

		expect(firstFingerprint).not.toBe(secondFingerprint);
	});

	it('computes fingerprints from the build config and runtime build tag', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const ignoredSidecarPath = path.join(temporaryDirectoryPath, 'ignored-sidecar.json');
		await fs.writeFile(
			temporaryConfigPath,
			JSON.stringify(baseBuildConfig()),
			'utf8',
		);
		await fs.writeFile(ignoredSidecarPath, JSON.stringify({ gitSha: 'abc123' }), 'utf8');

		const firstFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);
		await fs.writeFile(ignoredSidecarPath, JSON.stringify({ gitSha: 'def456' }), 'utf8');
		const secondFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });

		expect(firstFingerprint).toBe(secondFingerprint);
	});

	it('changes fingerprints when rootfs init extra contents change', async () => {
		const temporaryDirectoryPath = await fs.mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-image-'),
		);
		const temporaryConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
		const rootfsInitExtraPath = path.join(temporaryDirectoryPath, 'rootfs-init-extra.sh');
		await fs.writeFile(
			temporaryConfigPath,
			JSON.stringify({
				...baseBuildConfig(),
				init: { rootfsInitExtra: './rootfs-init-extra.sh' },
			}),
			'utf8',
		);

		await fs.writeFile(rootfsInitExtraPath, 'echo init-extra-v1\n', 'utf8');
		const firstFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);
		await fs.writeFile(rootfsInitExtraPath, 'echo init-extra-v2\n', 'utf8');
		const secondFingerprint = await computeFingerprintFromConfigPath(
			temporaryConfigPath,
			{ resolveRuntimeBuildVersionTag: async () => 'runtime@1' },
		);

		await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });

		expect(firstFingerprint).not.toBe(secondFingerprint);
	});
});

function baseBuildConfig(): { readonly arch: string; readonly distro: string } {
	return { arch: 'aarch64', distro: 'alpine' };
}
