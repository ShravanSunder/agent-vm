import path from 'node:path';

import { resolveZoneSecrets } from './credential-manager.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { startOpenClawInGateway } from './gateway-openclaw-lifecycle.js';
import {
	createGatewayVm,
	setupGatewayVmRuntime,
	type GatewayVmSetupDependencies,
} from './gateway-vm-setup.js';
import {
	findGatewayZone,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';

export interface GatewayManagerDependencies
	extends GatewayImageBuilderDependencies, GatewayVmSetupDependencies {}

export async function startGatewayZone(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = findGatewayZone(options.systemConfig, options.zoneId);
	let resolvedSecrets!: Awaited<ReturnType<typeof resolveZoneSecrets>>;
	await runTaskStep('Resolving zone secrets', async () => {
		resolvedSecrets = await resolveZoneSecrets({
			systemConfig: options.systemConfig,
			zoneId: zone.id,
			secretResolver: options.secretResolver,
		});
	});
	let image!: Awaited<ReturnType<typeof buildGatewayImage>>;
	await runTaskStep('Building gateway image', async () => {
		image = await buildGatewayImage(
			{
				buildConfigPath: options.systemConfig.images.gateway.buildConfig,
				cacheDir: path.join(options.systemConfig.cacheDir, 'images', 'gateway'),
			},
			{
				...(dependencies.buildImage ? { buildImage: dependencies.buildImage } : {}),
				...(dependencies.loadBuildConfig ? { loadBuildConfig: dependencies.loadBuildConfig } : {}),
			},
		);
	});
	let managedVm!: Awaited<ReturnType<typeof createGatewayVm>>;
	await runTaskStep('Booting gateway VM', async () => {
		managedVm = await createGatewayVm(
			{
				controllerPort: options.systemConfig.host.controllerPort,
				gatewayImagePath: image.imagePath,
				resolvedSecrets,
				secretResolver: options.secretResolver,
				systemConfig: options.systemConfig,
				zone,
			},
			dependencies.createManagedVm ? { createManagedVm: dependencies.createManagedVm } : {},
		);
	});
	await runTaskStep('Configuring gateway', async () => {
		await setupGatewayVmRuntime({
			...(resolvedSecrets.OPENCLAW_GATEWAY_TOKEN
				? { gatewayToken: resolvedSecrets.OPENCLAW_GATEWAY_TOKEN }
				: {}),
			managedVm,
			openClawConfigPath: zone.gateway.openclawConfig,
		});
	});
	let ingress!: Awaited<ReturnType<typeof startOpenClawInGateway>>;
	await runTaskStep('Starting OpenClaw', async () => {
		ingress = await startOpenClawInGateway({
			gatewayPort: zone.gateway.port,
			managedVm,
		});
	});

	return {
		image,
		ingress,
		vm: managedVm,
		zone,
	};
}
