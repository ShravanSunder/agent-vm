import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeFingerprintFromConfigPath } from '../../build/gondolin-image-builder.js';
import { managedVmImageAssetFileNames } from '../../build/gondolin-managed-vm-build-tooling.js';
import type { ManagedGatewayImageBootProjection } from '../../build/gondolin-managed-vm-build-tooling.js';
import { writePreparedManagedVmImage } from '../../build/prepared-gondolin-image-cache.js';
import { createLoadedSystemConfig, type LoadedSystemConfig } from '../../config/system-config.js';
import type { ControllerRuntime } from '../../controller/controller-runtime-types.js';
import type { ProcessLoggingHandle } from '../../observability/process-logging.js';
import type { ControllerOfflineCleanupResult } from '../../operations/controller-offline-cleanup.js';
import { defaultCliDependencies } from '../agent-vm-cli-support.js';
import {
	createProcessShutdownSignalWaiter,
	isGatewayImageCached,
	resolveControllerProcessLoggingStderr,
	runControllerCommand,
	runControllerStartLifecycle,
	type ProcessShutdownSignalWaiter,
	type ProcessShutdownSignalTarget,
} from './controller-definition.js';

const temporaryDirectories: string[] = [];

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

function createCompleteCleanupResult(
	systemConfig: LoadedSystemConfig,
): ControllerOfflineCleanupResult {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === 'coding-agent');
	if (zone === undefined) {
		throw new Error('Expected the coding-agent fixture zone.');
	}
	return {
		results: [
			{
				ownershipDisposition: 'complete',
				stateDir: zone.gateway.stateDir,
				zoneId: zone.id,
			},
		],
	};
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

function createLifecycleRuntime(close: () => Promise<void>): ControllerRuntime {
	return {
		close,
		controllerPort: 18_800,
		zones: [],
	};
}

function createLifecycleLoggingHandle(shutdown: () => Promise<void>): ProcessLoggingHandle {
	return { shutdown };
}

function createResolvedShutdownSignalWaiter(): ProcessShutdownSignalWaiter {
	return {
		signal: Promise.resolve(),
		cleanup: vi.fn(),
	};
}

describe('runControllerStartLifecycle', () => {
	it('uses the injected full stderr stream for process-root logging', () => {
		const injectedStderr = new Writable({
			write: (_chunk, _encoding, callback) => {
				callback();
			},
		});

		expect(
			resolveControllerProcessLoggingStderr(
				{ stderr: injectedStderr, stdout: { write: () => true } },
				{},
			),
		).toBe(injectedStderr);
	});

	it('prints readiness, closes the product once, then disposes logging once', async () => {
		const events: string[] = [];
		const stdoutChunks: string[] = [];
		const stdout = {
			write: vi.fn((chunk: string | Uint8Array) => {
				stdoutChunks.push(String(chunk));
				return true;
			}),
		};

		await runControllerStartLifecycle({
			io: { stderr: { write: () => true }, stdout },
			logging: createLifecycleLoggingHandle(async () => {
				events.push('logging.shutdown');
			}),
			runtime: createLifecycleRuntime(async () => {
				events.push('runtime.close');
			}),
			selectedZoneId: 'zone-1',
			shutdownSignalWaiter: {
				signal: Promise.resolve().then(() => {
					events.push('signal');
				}),
				cleanup: vi.fn(),
			},
		});

		expect(events).toEqual(['signal', 'runtime.close', 'logging.shutdown']);
		expect(stdoutChunks).toHaveLength(1);
		expect(JSON.parse(stdoutChunks[0] ?? '{}')).toEqual({
			controllerPort: 18_800,
			ingress: null,
			vmId: null,
			zoneId: 'zone-1',
		});
	});

	it('shares the close promise when shutdown is requested more than once', async () => {
		let resolveClose: (() => void) | undefined;
		const close = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveClose = resolve;
				}),
		);
		let resolveSignal: (() => void) | undefined;
		const shutdownSignalWaiter: ProcessShutdownSignalWaiter = {
			signal: new Promise<void>((resolve) => {
				resolveSignal = resolve;
			}),
			cleanup: vi.fn(),
		};
		const lifecycle = runControllerStartLifecycle({
			io: { stderr: { write: () => true }, stdout: { write: () => true } },
			logging: createLifecycleLoggingHandle(async () => {}),
			runtime: createLifecycleRuntime(close),
			selectedZoneId: 'zone-1',
			shutdownSignalWaiter,
		});

		resolveSignal?.();
		await Promise.resolve();
		resolveClose?.();
		await lifecycle;

		expect(close).toHaveBeenCalledOnce();
		expect(shutdownSignalWaiter.cleanup).toHaveBeenCalledOnce();
	});

	it('keeps a product close error primary when logging disposal also fails', async () => {
		const productError = new Error('product close failed');
		const stderrChunks: string[] = [];

		await expect(
			runControllerStartLifecycle({
				io: {
					stderr: {
						write: (chunk: string | Uint8Array) => {
							stderrChunks.push(String(chunk));
							return true;
						},
					},
					stdout: { write: () => true },
				},
				logging: createLifecycleLoggingHandle(async () => {
					throw new Error('logging close failed');
				}),
				runtime: createLifecycleRuntime(async () => {
					throw productError;
				}),
				selectedZoneId: 'zone-1',
				shutdownSignalWaiter: createResolvedShutdownSignalWaiter(),
			}),
		).rejects.toBe(productError);

		expect(stderrChunks).toEqual(['Controller process logging shutdown failed.\n']);
	});

	it('shares one close path across a second signal while product shutdown is pending', async () => {
		const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
		const target: ProcessShutdownSignalTarget = {
			on: (signal, listener) => {
				listeners.set(signal, listener);
			},
			off: (signal, listener) => {
				if (listeners.get(signal) === listener) {
					listeners.delete(signal);
				}
			},
		};
		let resolveClose: (() => void) | undefined;
		const close = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveClose = resolve;
				}),
		);
		const loggingShutdown = vi.fn(async () => {});
		const lifecycle = runControllerStartLifecycle({
			io: { stderr: { write: () => true }, stdout: { write: () => true } },
			logging: createLifecycleLoggingHandle(loggingShutdown),
			runtime: createLifecycleRuntime(close),
			selectedZoneId: 'zone-1',
			shutdownSignalWaiter: createProcessShutdownSignalWaiter({ target }),
		});

		listeners.get('SIGTERM')?.();
		await Promise.resolve();
		listeners.get('SIGINT')?.();
		expect(close).toHaveBeenCalledOnce();
		expect(loggingShutdown).not.toHaveBeenCalled();
		expect(listeners).toHaveProperty('size', 2);

		resolveClose?.();
		await lifecycle;

		expect(loggingShutdown).toHaveBeenCalledOnce();
		expect(listeners).toHaveProperty('size', 0);
	});

	it('resolves and cleans an injected process shutdown signal waiter', async () => {
		const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
		const target: ProcessShutdownSignalTarget = {
			on: (signal, listener) => {
				listeners.set(signal, listener);
			},
			off: (signal, listener) => {
				if (listeners.get(signal) === listener) {
					listeners.delete(signal);
				}
			},
		};
		const waiter = createProcessShutdownSignalWaiter({ target });

		listeners.get('SIGTERM')?.();
		await waiter.signal;
		waiter.cleanup();

		expect(listeners).toHaveProperty('size', 0);
	});

	it('registers the shutdown waiter before startup and handles a signal during startup', async () => {
		const events: string[] = [];
		const systemConfig = await createGatewayImageCacheFixture('signal-during-startup-fingerprint');
		const shutdownSignalWaiter = createResolvedShutdownSignalWaiter();
		const createShutdownSignalWaiter = vi.fn(() => {
			events.push('create-waiter');
			return shutdownSignalWaiter;
		});
		const startControllerRuntime = vi.fn(async () => {
			events.push('start-runtime');
			return createLifecycleRuntime(async () => {
				events.push('runtime.close');
			});
		});
		const loggingShutdown = vi.fn(async () => {
			events.push('logging.shutdown');
		});

		await runControllerCommand({
			commandValue: {
				command: 'controller.start',
				options: { config: systemConfig.systemConfigPath, zone: 'coding-agent' },
			},
			dependencies: {
				...defaultCliDependencies,
				isGatewayImageCached: async () => true,
				loadSystemConfig: async () => systemConfig,
				startControllerRuntime,
			},
			executionOptions: {
				configureProcessLogging: async () => createLifecycleLoggingHandle(loggingShutdown),
				createShutdownSignalWaiter,
				processRoot: true,
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
		});

		expect(events).toEqual(['create-waiter', 'start-runtime', 'runtime.close', 'logging.shutdown']);
		expect(createShutdownSignalWaiter).toHaveBeenCalledOnce();
		expect(shutdownSignalWaiter.cleanup).toHaveBeenCalledOnce();
	});

	it('cleans the shutdown waiter when runtime startup fails', async () => {
		const systemConfig = await createGatewayImageCacheFixture('startup-failure-waiter-fingerprint');
		const shutdownSignalWaiter = createResolvedShutdownSignalWaiter();
		const startError = new Error('runtime startup failed');

		await expect(
			runControllerCommand({
				commandValue: {
					command: 'controller.start',
					options: { config: systemConfig.systemConfigPath, zone: 'coding-agent' },
				},
				dependencies: {
					...defaultCliDependencies,
					isGatewayImageCached: async () => true,
					loadSystemConfig: async () => systemConfig,
					startControllerRuntime: async () => {
						throw startError;
					},
				},
				executionOptions: {
					configureProcessLogging: async () => createLifecycleLoggingHandle(async () => {}),
					createShutdownSignalWaiter: () => shutdownSignalWaiter,
					processRoot: true,
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
			}),
		).rejects.toBe(startError);

		expect(shutdownSignalWaiter.cleanup).toHaveBeenCalledOnce();
	});
});

describe('controller process-root setup', () => {
	it('configures and shuts down process logging around controller cleanup', async () => {
		const systemConfig = await createGatewayImageCacheFixture('cleanup-logging-fingerprint');
		const events: string[] = [];
		const stdoutChunks: string[] = [];
		const configureProcessLogging = vi.fn(async () => ({
			shutdown: async () => {
				events.push('logging.shutdown');
			},
		}));
		const cleanupResult = createCompleteCleanupResult(systemConfig);

		await runControllerCommand({
			commandValue: {
				command: 'controller.cleanup',
				options: {
					config: systemConfig.systemConfigPath,
					force: false,
					zone: 'coding-agent',
				},
			},
			dependencies: {
				...defaultCliDependencies,
				loadSystemConfig: async () => systemConfig,
				runControllerOfflineCleanup: async () => {
					events.push('cleanup');
					return cleanupResult;
				},
			},
			executionOptions: {
				configureProcessLogging,
				processRoot: true,
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						stdoutChunks.push(String(chunk));
						return true;
					},
				},
			},
		});

		expect(events).toEqual(['cleanup', 'logging.shutdown']);
		expect(configureProcessLogging).toHaveBeenCalledOnce();
		expect(stdoutChunks).toEqual([`${JSON.stringify(cleanupResult, null, 2)}\n`]);
	});

	it('preserves cleanup results when process logging setup fails', async () => {
		const systemConfig = await createGatewayImageCacheFixture(
			'cleanup-logging-failure-fingerprint',
		);
		const stderrChunks: string[] = [];
		const cleanupResult = createCompleteCleanupResult(systemConfig);
		const configureProcessLogging = vi.fn(async () => {
			throw new Error('logging setup failed');
		});

		await runControllerCommand({
			commandValue: {
				command: 'controller.cleanup',
				options: {
					config: systemConfig.systemConfigPath,
					force: false,
					zone: 'coding-agent',
				},
			},
			dependencies: {
				...defaultCliDependencies,
				loadSystemConfig: async () => systemConfig,
				runControllerOfflineCleanup: async () => cleanupResult,
			},
			executionOptions: {
				configureProcessLogging,
				processRoot: true,
			},
			io: {
				stderr: {
					write: (chunk: string | Uint8Array) => {
						stderrChunks.push(String(chunk));
						return true;
					},
				},
				stdout: { write: () => true },
			},
		});

		expect(configureProcessLogging).toHaveBeenCalledOnce();
		expect(stderrChunks).toEqual(['Controller process logging setup failed.\n']);
	});

	it('reports a bounded startup failure when process logging setup rejects', async () => {
		const systemConfig = await createGatewayImageCacheFixture('setup-failure-fingerprint');
		const stderrChunks: string[] = [];
		const rawSetupError = new Error(
			'connect https://collector.invalid/v1/logs with Authorization: secret-value',
		);

		await expect(
			runControllerCommand({
				commandValue: {
					command: 'controller.start',
					options: { config: systemConfig.systemConfigPath, zone: 'coding-agent' },
				},
				dependencies: {
					...defaultCliDependencies,
					isGatewayImageCached: async () => true,
					loadSystemConfig: async () => systemConfig,
				},
				executionOptions: {
					configureProcessLogging: async () => {
						throw rawSetupError;
					},
					processRoot: true,
				},
				io: {
					stderr: {
						write: (chunk: string | Uint8Array): boolean => {
							stderrChunks.push(String(chunk));
							return true;
						},
					},
					stdout: { write: () => true },
				},
			}),
		).rejects.toThrow('Controller process logging setup failed.');

		expect(stderrChunks).toEqual([]);
	});
});
