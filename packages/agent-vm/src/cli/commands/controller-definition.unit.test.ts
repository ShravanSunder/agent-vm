import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeImageArtifactFixture } from '../../../../../scripts/test-fixtures/image-artifact-fixture.js';
import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import type { ManagedGatewayImageBootProjection } from '../../build/gondolin-managed-vm-build-tooling.js';
import {
	configuredImageSelectionRecordPath,
	writePreparedManagedVmImage,
} from '../../build/prepared-gondolin-image-cache.js';
import {
	createLoadedSystemConfig,
	deploymentGeneratedDirForStorageRoot,
	sharedImageCacheDirForStorageRoot,
	type LoadedSystemConfig,
} from '../../config/system-config.js';
import {
	createProcessShutdownSignalWaiter,
	isGatewayImageCached,
	runControllerStartProcessLifecycle,
} from './controller-command-operation.js';

const temporaryDirectories: string[] = [];
const currentRuntimeFingerprint = '3333333333333333';

describe('controller process lifecycle', () => {
	it('closes the runtime before process logging and removes signal listeners', async () => {
		const events: string[] = [];
		const cleanup = vi.fn();

		await runControllerStartProcessLifecycle({
			io: { stderr: { write: () => true }, stdout: { write: () => true } },
			logging: {
				shutdown: async (): Promise<void> => {
					events.push('logging.shutdown');
				},
			},
			runtime: {
				close: async (): Promise<void> => {
					events.push('runtime.close');
				},
				controllerPort: 18_800,
				zones: [],
			},
			selectedZoneId: 'zone-1',
			shutdownSignalWaiter: { cleanup, signal: Promise.resolve() },
		});

		expect(events).toEqual(['runtime.close', 'logging.shutdown']);
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it('keeps product shutdown failure primary when logging disposal also fails', async () => {
		const productFailure = new Error('runtime close failed');
		const stderrChunks: string[] = [];

		await expect(
			runControllerStartProcessLifecycle({
				io: {
					stderr: {
						write: (chunk: string | Uint8Array): boolean => {
							stderrChunks.push(String(chunk));
							return true;
						},
					},
					stdout: { write: () => true },
				},
				logging: {
					shutdown: async (): Promise<void> => {
						throw new Error('logging shutdown failed');
					},
				},
				runtime: {
					close: async (): Promise<void> => {
						throw productFailure;
					},
					controllerPort: 18_800,
					zones: [],
				},
				selectedZoneId: 'zone-1',
				shutdownSignalWaiter: { cleanup: () => undefined, signal: Promise.resolve() },
			}),
		).rejects.toBe(productFailure);
		expect(stderrChunks).toEqual(['Controller process logging shutdown failed.\n']);
	});

	it('closes the runtime, logging, and signal waiter when readiness output fails', async () => {
		const readinessFailure = new Error('readiness writer failed');
		const runtimeClose = vi.fn(async (): Promise<void> => undefined);
		const loggingShutdown = vi.fn(async (): Promise<void> => undefined);
		const cleanup = vi.fn();

		await expect(
			runControllerStartProcessLifecycle({
				io: {
					stderr: { write: () => true },
					stdout: {
						write: (): never => {
							throw readinessFailure;
						},
					},
				},
				logging: { shutdown: loggingShutdown },
				runtime: {
					close: runtimeClose,
					controllerPort: 18_800,
					zones: [],
				},
				selectedZoneId: 'zone-1',
				shutdownSignalWaiter: { cleanup, signal: new Promise<never>(() => undefined) },
			}),
		).rejects.toBe(readinessFailure);

		expect(runtimeClose).toHaveBeenCalledOnce();
		expect(loggingShutdown).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it('resolves only once and cleans both process signal listeners', async () => {
		const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
		const waiter = createProcessShutdownSignalWaiter({
			off: (signal, listener): void => {
				if (listeners.get(signal) === listener) listeners.delete(signal);
			},
			on: (signal, listener): void => {
				listeners.set(signal, listener);
			},
		});

		listeners.get('SIGTERM')?.();
		listeners.get('SIGINT')?.();
		await waiter.signal;
		waiter.cleanup();

		expect(listeners).toHaveLength(0);
	});
});

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-vm-controller-cache-'));
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function writeFakeImageAssets(imagePath: string): Promise<void> {
	await writeImageArtifactFixture(imagePath);
}

async function createGatewayImageCacheFixture(
	options: {
		readonly gatewayType?: 'hermes' | 'worker';
		readonly preparedManagedGatewayBoot?: ManagedGatewayImageBootProjection;
	} = {},
): Promise<{ readonly fingerprint: string; readonly systemConfig: LoadedSystemConfig }> {
	const gatewayType = options.gatewayType ?? 'worker';
	const gatewayConfiguration =
		gatewayType === 'hermes'
			? {
					type: 'hermes' as const,
					profileSecretProjectionsByAgent: {
						'coding-agent': {
							API_SERVER_KEY: 'API_SERVER_KEY_CODING_AGENT',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_CODING_AGENT',
						},
					},
					profilesByAgent: { 'coding-agent': 'coding-agent' },
				}
			: { type: 'worker' as const };
	const temporaryDirectoryPath = await createTemporaryDirectory();
	const gatewayConfigDirectory = await createTemporaryDirectory();
	const systemConfigPath = path.join(temporaryDirectoryPath, 'config', 'system.json');
	const buildConfigPath = path.join(temporaryDirectoryPath, 'build-config.json');
	const gatewayImageConfiguration = {
		type: gatewayType,
		buildConfig: buildConfigPath,
	};
	const sharedImageCacheDir = sharedImageCacheDirForStorageRoot(temporaryDirectoryPath);
	const selectionRecordPath = configuredImageSelectionRecordPath({
		deploymentGeneratedDir: deploymentGeneratedDirForStorageRoot(temporaryDirectoryPath),
		family: 'gateway',
		profileName: 'worker',
	});
	await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
	await fs.writeFile(
		buildConfigPath,
		JSON.stringify({ arch: 'aarch64', distro: 'alpine' }),
		'utf8',
	);
	const fingerprintInput = {
		dockerRootfsIdentity: {
			architecture: 'arm64',
			layers: ['sha256:rootfs-layer'],
			os: 'linux',
		},
		schemaVersion: 1,
	};
	const fingerprint = await computeFingerprintFromConfigPath(buildConfigPath, {
		fingerprintInput,
		...(options.preparedManagedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.preparedManagedGatewayBoot }),
	});
	const imagePath = path.join(sharedImageCacheDir, fingerprint);
	await writeFakeImageAssets(imagePath);
	await writePreparedManagedVmImage({
		buildConfigPath,
		fingerprint,
		fingerprintInput,
		imagePath,
		selectionRecordPath,
		sharedImageCacheDir,
		...(options.preparedManagedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.preparedManagedGatewayBoot }),
	});

	const systemConfig = createLoadedSystemConfig(
		{
			storageRootDir: temporaryDirectoryPath,
			host: {
				controllerPort: 18800,
				projectNamespace: 'cache-test',
			},
			imageProfiles: {
				gateways: {
					worker: gatewayImageConfiguration,
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
					egressHosts: ['api.openai.com'].map((host) => ({
						host,
						audience: 'gateway' as const,
					})),
					gateway: {
						...gatewayConfiguration,
						imageProfile: 'worker',
						cpus: 2,
						config: path.join(gatewayConfigDirectory, 'gateway.json'),
						memory: '2G',
						port: 18791,
					},
					id: 'coding-agent',
					secrets:
						gatewayType === 'hermes'
							? {
									API_SERVER_KEY_CODING_AGENT: {
										source: 'environment',
										envVar: 'API_SERVER_KEY_CODING_AGENT',
										injection: 'env',
										audience: 'gateway',
									},
									DISCORD_BOT_TOKEN_CODING_AGENT: {
										source: 'environment',
										envVar: 'DISCORD_BOT_TOKEN_CODING_AGENT',
										injection: 'env',
										audience: 'gateway',
									},
								}
							: {},
					defaultToolVmProfile: gatewayType === 'hermes' ? 'standard' : undefined,
					agentToolVmProfiles: gatewayType === 'hermes' ? {} : undefined,
					agents: gatewayType === 'hermes' ? [{ id: 'coding-agent' }] : undefined,
				},
			],
		},
		{ systemConfigPath },
	);
	return { fingerprint, systemConfig };
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
		const { fingerprint, systemConfig } = await createGatewayImageCacheFixture();

		await expect(
			isGatewayImageCached(systemConfig, 'coding-agent', {
				computeManagedVmFingerprint: async () => fingerprint,
			}),
		).resolves.toBe(true);
	});

	it('rejects a prepared gateway image from a different runtime fingerprint', async () => {
		const { systemConfig } = await createGatewayImageCacheFixture();

		await expect(
			isGatewayImageCached(systemConfig, 'coding-agent', {
				computeManagedVmFingerprint: async () => currentRuntimeFingerprint,
			}),
		).resolves.toBe(false);
	});

	it('derives the managed Gateway boot projection from the current gateway type', async () => {
		const { fingerprint, systemConfig } = await createGatewayImageCacheFixture({
			gatewayType: 'hermes',
			preparedManagedGatewayBoot: {
				frameworkBootEntry: 'hermes-framework-service',
				kind: 'managed-gateway-exact-two-role',
			},
		});
		let observedManagedGatewayBoot: ManagedGatewayImageBootProjection | undefined;

		await expect(
			isGatewayImageCached(systemConfig, 'coding-agent', {
				computeManagedVmFingerprint: async (options) => {
					observedManagedGatewayBoot = options.managedGatewayBoot;
					return fingerprint;
				},
			}),
		).resolves.toBe(true);
		expect(observedManagedGatewayBoot).toEqual({
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		});
	});

	it('treats fingerprint computation failures as a cache miss', async () => {
		const { systemConfig } = await createGatewayImageCacheFixture();

		await expect(
			isGatewayImageCached(systemConfig, 'coding-agent', {
				computeManagedVmFingerprint: async () => {
					throw new Error('build config unavailable');
				},
			}),
		).resolves.toBe(false);
	});

	it('rejects a stale Hermes boot projection for a Worker image', async () => {
		const { systemConfig } = await createGatewayImageCacheFixture({
			gatewayType: 'worker',
		});
		const buildConfigPath = systemConfig.imageProfiles.gateways.worker?.buildConfig;
		if (buildConfigPath === undefined) {
			throw new Error('Expected gateway build config path.');
		}
		const sharedImageCacheDir = sharedImageCacheDirForStorageRoot(systemConfig.storageRootDir);
		const fingerprintInput = {
			dockerRootfsIdentity: {
				architecture: 'arm64',
				layers: ['sha256:rootfs-layer'],
				os: 'linux',
			},
			schemaVersion: 1,
		};
		const staleManagedGatewayBoot: ManagedGatewayImageBootProjection = {
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		};
		const staleFingerprint = await computeFingerprintFromConfigPath(buildConfigPath, {
			fingerprintInput,
			managedGatewayBoot: staleManagedGatewayBoot,
		});
		const imagePath = path.join(sharedImageCacheDir, staleFingerprint);
		await writeFakeImageAssets(imagePath);
		await writePreparedManagedVmImage({
			buildConfigPath,
			fingerprint: staleFingerprint,
			fingerprintInput,
			imagePath,
			managedGatewayBoot: staleManagedGatewayBoot,
			selectionRecordPath: configuredImageSelectionRecordPath({
				deploymentGeneratedDir: deploymentGeneratedDirForStorageRoot(systemConfig.storageRootDir),
				family: 'gateway',
				profileName: 'worker',
			}),
			sharedImageCacheDir,
		});

		await expect(isGatewayImageCached(systemConfig, 'coding-agent')).resolves.toBe(false);
	});
});
