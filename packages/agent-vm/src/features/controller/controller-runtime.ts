import fs from 'node:fs/promises';

import {
	buildImage as buildImageFromCore,
	createManagedVm as createManagedVmFromCore,
	createSecretResolver,
	type BuildConfig,
	type ManagedVm,
	type SecretResolver,
} from 'gondolin-core';

import { createControllerService } from './controller-service.js';
import { startGatewayZone } from './gateway-manager.js';
import { createIdleReaper } from './idle-reaper.js';
import { createLeaseManager, type ToolProfile } from './lease-manager.js';
import type { SystemConfig } from './system-config.js';
import { createTcpPool } from './tcp-pool.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly gateway: {
		readonly ingress: {
			readonly host: string;
			readonly port: number;
		};
		readonly vm: Pick<ManagedVm, 'close' | 'id'>;
	};
	close(): Promise<void>;
}

interface ControllerRuntimeDependencies {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly createManagedToolVm?: (options: {
		readonly profile: ToolProfile;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly createSecretResolver?: typeof createSecretResolver;
	readonly now?: () => number;
	readonly setIntervalImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
	readonly startGatewayZone?: typeof startGatewayZone;
	readonly startHttpServer?: (options: {
		readonly app: ReturnType<typeof createControllerService>;
		readonly port: number;
	}) => Promise<{
		close(): Promise<void>;
	}>;
}

async function defaultStartHttpServer(options: {
	readonly app: ReturnType<typeof createControllerService>;
	readonly port: number;
}): Promise<{
	close(): Promise<void>;
}> {
	const honoNodeServer = await import('@hono/node-server');
	const server = honoNodeServer.serve({
		fetch: options.app.fetch,
		port: options.port,
	});

	return {
		async close(): Promise<void> {
			await new Promise<void>((resolve, reject) => {
				server.close((error?: Error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
	};
}

async function createResolverFromEnv(
	systemConfig: SystemConfig,
	createSecretResolverImpl: typeof createSecretResolver,
): Promise<SecretResolver> {
	const serviceAccountTokenEnv = systemConfig.host.secretsProvider.serviceAccountTokenEnv;
	const serviceAccountToken = process.env[serviceAccountTokenEnv];
	if (!serviceAccountToken) {
		throw new Error(`Missing required env var '${serviceAccountTokenEnv}'.`);
	}

	return await createSecretResolverImpl({
		serviceAccountToken,
	});
}

async function loadBuildConfig(buildConfigPath: string): Promise<BuildConfig> {
	return JSON.parse(await fs.readFile(buildConfigPath, 'utf8')) as BuildConfig;
}

function findZone(systemConfig: SystemConfig, zoneId: string): SystemConfig['zones'][number] {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${zoneId}'.`);
	}

	return zone;
}

export async function startControllerRuntime(
	options: {
		readonly pluginSourceDir: string;
		readonly systemConfig: SystemConfig;
		readonly zoneId: string;
	},
	dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
	const now = dependencies.now ?? Date.now;
	const zone = findZone(options.systemConfig, options.zoneId);
	const secretResolver = await createResolverFromEnv(
		options.systemConfig,
		dependencies.createSecretResolver ?? createSecretResolver,
	);
	const createManagedToolVm =
		dependencies.createManagedToolVm ??
		(async (toolVmOptions): Promise<ManagedVm> => {
			const toolBuildConfig = await loadBuildConfig(options.systemConfig.images.tool.buildConfig);
			const toolImage = await buildImageFromCore({
				buildConfig: toolBuildConfig,
				cacheDir: `${zone.gateway.stateDir}/images/tool`,
			});
			return await createManagedVmFromCore({
				allowedHosts: [],
				cpus: toolVmOptions.profile.cpus,
				imagePath: toolImage.imagePath,
				memory: toolVmOptions.profile.memory,
				rootfsMode: 'memory',
				sessionLabel: `${toolVmOptions.zoneId}-tool-${toolVmOptions.tcpSlot}`,
				secrets: {},
				vfsMounts: {
					'/workspace': {
						hostPath: toolVmOptions.workspaceDir,
						kind: 'realfs',
					},
				},
			});
		});
	const tcpPool = createTcpPool(options.systemConfig.tcpPool);
	const leaseManager = createLeaseManager({
		createManagedVm: async (leaseOptions) =>
			await createManagedToolVm({
				profile: leaseOptions.profile,
				tcpSlot: leaseOptions.tcpSlot,
				workspaceDir: leaseOptions.workspaceDir,
				zoneId: leaseOptions.zoneId,
			}),
		now,
		tcpPool,
	});
	const idleReaper = createIdleReaper({
		getLeases: () => leaseManager.listLeases(),
		now,
		releaseLease: async (leaseId: string) => {
			await leaseManager.releaseLease(leaseId);
		},
		ttlMs: 30 * 60 * 1000,
	});
	const reaperTimer = (dependencies.setIntervalImpl ?? setInterval)(() => {
		void idleReaper.reapExpiredLeases();
	}, 60_000);
	const gateway = await (dependencies.startGatewayZone ?? startGatewayZone)({
		pluginSourceDir: options.pluginSourceDir,
		secretResolver,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	const controllerApp = createControllerService({
		leaseManager,
		systemConfig: options.systemConfig,
	});
	const server = await (dependencies.startHttpServer ?? defaultStartHttpServer)({
		app: controllerApp,
		port: options.systemConfig.host.controllerPort,
	});

	await idleReaper.reapExpiredLeases();

	return {
		async close(): Promise<void> {
			(dependencies.clearIntervalImpl ?? clearInterval)(reaperTimer);
			await gateway.vm.close();
			await server.close();
		},
		controllerPort: options.systemConfig.host.controllerPort,
		gateway: {
			ingress: gateway.ingress,
			vm: gateway.vm,
		},
	};
}
