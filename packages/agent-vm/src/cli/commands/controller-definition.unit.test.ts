import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import { managedVmImageAssetFileNames } from '../../build/gondolin-managed-vm-build-tooling.js';
import type { ManagedGatewayImageBootProjection } from '../../build/gondolin-managed-vm-build-tooling.js';
import { writePreparedManagedVmImage } from '../../build/prepared-gondolin-image-cache.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../../config/system-config.js';
import {
	createProcessShutdownSignalWaiter,
	isGatewayImageCached,
	runControllerStartProcessLifecycle,
} from './controller-command-operation.js';

const temporaryDirectories: string[] = [];

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
	await fs.mkdir(imagePath, { recursive: true });
	await Promise.all(
		managedVmImageAssetFileNames.map(
			async (fileName) => await fs.writeFile(path.join(imagePath, fileName), '', 'utf8'),
		),
	);
}

async function createGatewayImageCacheFixture(
	fingerprint: string,
	options: {
		readonly gatewayType?: 'openclaw' | 'worker';
		readonly preparedManagedGatewayBoot?: ManagedGatewayImageBootProjection;
	} = {},
): Promise<LoadedSystemConfig> {
	const gatewayType = options.gatewayType ?? 'worker';
	const gatewayConfiguration =
		gatewayType === 'openclaw'
			? {
					type: 'openclaw' as const,
					controlAuth: {
						mode: 'token' as const,
						secret: 'OPENCLAW_GATEWAY_TOKEN',
					},
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
	const cacheDir = path.join(temporaryDirectoryPath, 'cache');
	const gatewayProfileCacheDirectory = path.join(cacheDir, 'gateway-images', 'worker');
	const imagePath = path.join(gatewayProfileCacheDirectory, fingerprint);
	await fs.mkdir(path.dirname(systemConfigPath), { recursive: true });
	await fs.writeFile(
		buildConfigPath,
		JSON.stringify({ arch: 'aarch64', distro: 'alpine' }),
		'utf8',
	);
	await writeFakeImageAssets(imagePath);
	await writePreparedManagedVmImage({
		buildConfigPath,
		cacheDir: gatewayProfileCacheDirectory,
		fingerprint,
		fingerprintInput: {
			dockerRootfsIdentity: {
				architecture: 'arm64',
				layers: ['sha256:rootfs-layer'],
				os: 'linux',
			},
			schemaVersion: 1,
		},
		imagePath,
		...(options.preparedManagedGatewayBoot === undefined
			? {}
			: { managedGatewayBoot: options.preparedManagedGatewayBoot }),
	});

	return createLoadedSystemConfig(
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
						gatewayType === 'openclaw'
							? {
									OPENCLAW_GATEWAY_TOKEN: {
										audience: 'gateway' as const,
										envVar: 'OPENCLAW_GATEWAY_TOKEN',
										injection: 'env' as const,
										source: 'environment' as const,
									},
								}
							: {},
					defaultToolVmProfile: gatewayType === 'openclaw' ? 'standard' : undefined,
					agentToolVmProfiles: gatewayType === 'openclaw' ? {} : undefined,
					agents: gatewayType === 'openclaw' ? [{ id: 'coding-agent' }] : undefined,
				},
			],
		},
		{ systemConfigPath },
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
		const systemConfig = await createGatewayImageCacheFixture('docker-backed-fingerprint');

		await expect(
			isGatewayImageCached(systemConfig, 'coding-agent', {
				computeManagedVmFingerprint: async () => 'docker-backed-fingerprint',
			}),
		).resolves.toBe(true);
	});

	it('rejects a prepared gateway image from a different runtime fingerprint', async () => {
		const systemConfig = await createGatewayImageCacheFixture('previous-runtime-fingerprint');

		await expect(
			isGatewayImageCached(systemConfig, 'coding-agent', {
				computeManagedVmFingerprint: async () => 'current-runtime-fingerprint',
			}),
		).resolves.toBe(false);
	});

	it('derives the managed Gateway boot projection from the current gateway type', async () => {
		const systemConfig = await createGatewayImageCacheFixture('current-fingerprint', {
			gatewayType: 'openclaw',
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
					return 'current-fingerprint';
				},
			}),
		).resolves.toBe(true);
		expect(observedManagedGatewayBoot).toEqual({
			frameworkBootEntry: 'openclaw-framework-service',
			kind: 'managed-gateway-exact-two-role',
		});
	});

	it('treats fingerprint computation failures as a cache miss', async () => {
		const systemConfig = await createGatewayImageCacheFixture('current-fingerprint');

		await expect(
			isGatewayImageCached(systemConfig, 'coding-agent', {
				computeManagedVmFingerprint: async () => {
					throw new Error('build config unavailable');
				},
			}),
		).resolves.toBe(false);
	});

	it('rejects a stale boot projection through the default fingerprint computation', async () => {
		const systemConfig = await createGatewayImageCacheFixture('placeholder-fingerprint', {
			gatewayType: 'openclaw',
		});
		const buildConfigPath = systemConfig.imageProfiles.gateways.worker?.buildConfig;
		if (buildConfigPath === undefined) {
			throw new Error('Expected gateway build config path.');
		}
		const cacheDir = path.join(systemConfig.cacheDir, 'gateway-images', 'worker');
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
		const imagePath = path.join(cacheDir, staleFingerprint);
		await writeFakeImageAssets(imagePath);
		await writePreparedManagedVmImage({
			buildConfigPath,
			cacheDir,
			fingerprint: staleFingerprint,
			fingerprintInput,
			imagePath,
			managedGatewayBoot: staleManagedGatewayBoot,
		});

		await expect(isGatewayImageCached(systemConfig, 'coding-agent')).resolves.toBe(false);
	});
});
