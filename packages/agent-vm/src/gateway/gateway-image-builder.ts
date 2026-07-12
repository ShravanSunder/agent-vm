import type { ManagedVmImageBuildResult, ManagedVmImageCapability } from '@agent-vm/managed-vm';

export interface GatewayImageBuilderDependencies {
	readonly managedVmImages: ManagedVmImageCapability;
}

export async function buildGatewayImage(
	options: {
		readonly buildConfigPath: string;
		readonly cacheDir: string;
	},
	dependencies: GatewayImageBuilderDependencies,
): Promise<ManagedVmImageBuildResult> {
	return await dependencies.managedVmImages.prepareImage({
		cacheDirectory: options.cacheDir,
		recipePath: options.buildConfigPath,
	});
}
