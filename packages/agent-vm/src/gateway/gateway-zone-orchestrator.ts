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
	const zone = findGatewayZone(options.systemConfig, options.zoneId);
	const resolvedSecrets = await resolveZoneSecrets({
		systemConfig: options.systemConfig,
		zoneId: zone.id,
		secretResolver: options.secretResolver,
	});
	const image = await buildGatewayImage(
		{
			buildConfigPath: options.systemConfig.images.gateway.buildConfig,
			cacheDir: `${zone.gateway.stateDir}/images/gateway`,
		},
		{
			...(dependencies.buildImage ? { buildImage: dependencies.buildImage } : {}),
			...(dependencies.loadBuildConfig ? { loadBuildConfig: dependencies.loadBuildConfig } : {}),
		},
	);
	const managedVm = await createGatewayVm(
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
	await setupGatewayVmRuntime({
		...(resolvedSecrets.OPENCLAW_GATEWAY_TOKEN
			? { gatewayToken: resolvedSecrets.OPENCLAW_GATEWAY_TOKEN }
			: {}),
		managedVm,
		openClawConfigPath: zone.gateway.openclawConfig,
	});
	const ingress = await startOpenClawInGateway({
		gatewayPort: zone.gateway.port,
		managedVm,
	});

	return {
		image,
		ingress,
		vm: managedVm,
		zone,
	};
}
