import fs from 'node:fs/promises';
import path from 'node:path';

import type {
	GatewayHealthCheck,
	GatewayLifecycle,
	GatewayZoneConfig,
} from '@shravansunder/agent-vm-gateway-interface';
import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
} from '@shravansunder/agent-vm-gondolin-core';

import { runTaskWithResult } from '../shared/run-task.js';
import { resolveZoneSecrets } from './credential-manager.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import { cleanupOrphanedGatewayIfPresent } from './gateway-recovery.js';
import {
	buildGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
	type GatewayRuntimeRecord,
} from './gateway-runtime-record.js';
import {
	findGatewayZone,
	type GatewayManagedVmFactoryOptions,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';

export interface GatewayManagerDependencies extends GatewayImageBuilderDependencies {
	readonly cleanupOrphanedGatewayIfPresent?: typeof cleanupOrphanedGatewayIfPresent;
	readonly createManagedVm?: (options: GatewayManagedVmFactoryOptions) => Promise<ManagedVm>;
	readonly loadGatewayLifecycle?: (type: GatewayZoneConfig['gateway']['type']) => GatewayLifecycle;
	readonly writeGatewayRuntimeRecord?: (
		stateDirectory: string,
		record: GatewayRuntimeRecord,
	) => Promise<void>;
}

async function waitForHealth(options: {
	readonly attempt?: number;
	readonly healthCheck: GatewayHealthCheck;
	readonly lastObservation?: string;
	readonly managedVm: ManagedVm;
	readonly maxAttempts?: number;
}): Promise<void> {
	const attempt = options.attempt ?? 0;
	const maxAttempts = options.maxAttempts ?? 30;
	const lastObservation = options.lastObservation ?? 'none';
	if (attempt >= maxAttempts) {
		throw new Error(
			`Gateway readiness check failed after ${maxAttempts} attempts. Last observation: ${lastObservation}.`,
		);
	}

	const healthCommand =
		options.healthCheck.type === 'http'
			? `curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:${options.healthCheck.port}${options.healthCheck.path} 2>/dev/null || echo 000`
			: options.healthCheck.command;
	const result = await options.managedVm.exec(healthCommand);
	const currentObservation =
		options.healthCheck.type === 'http'
			? `http ${result.stdout.trim() || '(empty)'}`
			: `exit ${result.exitCode}`;
	if (
		(options.healthCheck.type === 'http' && result.stdout.trim().startsWith('2')) ||
		(options.healthCheck.type === 'command' && result.exitCode === 0)
	) {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, 500));
	await waitForHealth({
		attempt: attempt + 1,
		healthCheck: options.healthCheck,
		lastObservation: currentObservation,
		managedVm: options.managedVm,
		maxAttempts,
	});
}

export async function startGatewayZone(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = findGatewayZone(options.systemConfig, options.zoneId);
	await runTaskStep('Cleaning orphaned gateway runtime', async () => {
		await (dependencies.cleanupOrphanedGatewayIfPresent ?? cleanupOrphanedGatewayIfPresent)({
			stateDir: zone.gateway.stateDir,
			zoneId: zone.id,
		});
	});
	const lifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(zone.gateway.type);
	const resolvedSecrets = await runTaskWithResult(
		runTaskStep,
		'Resolving zone secrets',
		async () =>
			await resolveZoneSecrets({
				systemConfig: options.systemConfig,
				zoneId: zone.id,
				secretResolver: options.secretResolver,
			}),
	);
	const image = await runTaskWithResult(
		runTaskStep,
		'Building gateway image',
		async () =>
			await buildGatewayImage(
				{
					buildConfigPath: options.systemConfig.images.gateway.buildConfig,
					cacheDir: path.join(options.systemConfig.cacheDir, 'images', 'gateway'),
				},
				{
					...(dependencies.buildImage ? { buildImage: dependencies.buildImage } : {}),
					...(dependencies.loadBuildConfig
						? { loadBuildConfig: dependencies.loadBuildConfig }
						: {}),
				},
			),
	);
	await fs.mkdir(zone.gateway.stateDir, { recursive: true });
	await fs.mkdir(zone.gateway.workspaceDir, { recursive: true });
	await runTaskStep('Preparing host state', async () => {
		await lifecycle.prepareHostState?.(zone, options.secretResolver);
	});
	const vmSpec = lifecycle.buildVmSpec({
		controllerPort: options.systemConfig.host.controllerPort,
		projectNamespace: options.systemConfig.host.projectNamespace,
		resolvedSecrets,
		tcpPool: options.systemConfig.tcpPool,
		zone,
	});
	const processSpec = lifecycle.buildProcessSpec(zone, resolvedSecrets);
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	const managedVm = await runTaskWithResult(
		runTaskStep,
		'Booting gateway VM',
		async () =>
			await createManagedVm({
				allowedHosts: vmSpec.allowedHosts,
				cpus: zone.gateway.cpus,
				env: vmSpec.environment,
				imagePath: image.imagePath,
				memory: zone.gateway.memory,
				rootfsMode: vmSpec.rootfsMode,
				secrets: vmSpec.mediatedSecrets,
				sessionLabel: vmSpec.sessionLabel,
				tcpHosts: vmSpec.tcpHosts,
				vfsMounts: vmSpec.vfsMounts,
			}),
	);
	await runTaskStep('Configuring gateway', async () => {
		await managedVm.exec(processSpec.bootstrapCommand);
	});
	await runTaskStep('Starting gateway', async () => {
		await managedVm.exec(processSpec.startCommand);
	});
	await runTaskStep('Waiting for readiness', async () => {
		await waitForHealth({
			healthCheck: processSpec.healthCheck,
			managedVm,
		});
	});
	managedVm.setIngressRoutes([
		{
			port: processSpec.guestListenPort,
			prefix: '/',
			stripPrefix: true,
		},
	]);
	const ingress = await managedVm.enableIngress({
		listenPort: zone.gateway.port,
	});
	try {
		await runTaskStep('Recording gateway runtime', async () => {
			await (dependencies.writeGatewayRuntimeRecord ?? writeGatewayRuntimeRecord)(
				zone.gateway.stateDir,
				buildGatewayRuntimeRecord({
					gatewayType: zone.gateway.type,
					ingressPort: ingress.port,
					managedVm,
					processSpec,
					projectNamespace: options.systemConfig.host.projectNamespace,
					zoneId: zone.id,
				}),
			);
		});
	} catch (error) {
		await managedVm.close().catch((closeError: unknown) => {
			process.stderr.write(
				`[agent-vm] Failed to close gateway VM after runtime-record write failure: ${closeError instanceof Error ? closeError.message : JSON.stringify(closeError)}\n`,
			);
		});
		throw error;
	}

	return {
		image,
		ingress,
		processSpec,
		vm: managedVm,
		zone,
	};
}
