import fs from 'node:fs/promises';
import path from 'node:path';

import type {
	GatewayHealthCheck,
	GatewayLifecycle,
	GatewayZoneConfig,
} from '@shravansunder/gateway-interface';
import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
} from '@shravansunder/gondolin-core';

import { runTaskWithResult } from '../shared/run-task.js';
import { resolveZoneSecrets } from './credential-manager.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import {
	findGatewayZone,
	type GatewayManagedVmFactoryOptions,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';

export interface GatewayManagerDependencies extends GatewayImageBuilderDependencies {
	readonly createManagedVm?: (options: GatewayManagedVmFactoryOptions) => Promise<ManagedVm>;
	readonly loadGatewayLifecycle?: (type: GatewayZoneConfig['gateway']['type']) => GatewayLifecycle;
}

async function waitForHealth(
	managedVm: ManagedVm,
	healthCheck: GatewayHealthCheck,
	attempt: number = 0,
	maxAttempts: number = 30,
	lastObservation: string = 'none',
): Promise<void> {
	if (attempt >= maxAttempts) {
		throw new Error(
			`Gateway readiness check failed after ${maxAttempts} attempts. Last observation: ${lastObservation}.`,
		);
	}

	const healthCommand =
		healthCheck.type === 'http'
			? `curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:${healthCheck.port}${healthCheck.path} 2>/dev/null || echo 000`
			: healthCheck.command;
	const result = await managedVm.exec(healthCommand);
	const currentObservation =
		healthCheck.type === 'http'
			? `http ${result.stdout.trim() || '(empty)'}`
			: `exit ${result.exitCode}`;
	if (
		(healthCheck.type === 'http' && result.stdout.trim().startsWith('2')) ||
		(healthCheck.type === 'command' && result.exitCode === 0)
	) {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, 500));
	await waitForHealth(managedVm, healthCheck, attempt + 1, maxAttempts, currentObservation);
}

export async function startGatewayZone(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
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
	const vmSpec = lifecycle.buildVmSpec(
		zone,
		resolvedSecrets,
		options.systemConfig.host.controllerPort,
		options.systemConfig.tcpPool,
	);
	const mergedTcpHosts = {
		...vmSpec.tcpHosts,
		...options.tcpHostsOverride,
	};
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
				tcpHosts: mergedTcpHosts,
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
		await waitForHealth(managedVm, processSpec.healthCheck);
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

	return {
		image,
		ingress,
		processSpec,
		vm: managedVm,
		zone,
	};
}
