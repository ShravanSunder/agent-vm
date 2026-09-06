import type { ManagedVmImageBuildResult, ManagedVmImageCapability } from '@agent-vm/managed-vm';

export interface GatewayImageBuilderDependencies {
	readonly managedVmImages: ManagedVmImageCapability;
}

export async function buildGatewayImage(
	options: {
		readonly artifactCacheDirectory: string;
		readonly buildConfigPath: string;
		readonly expectedBootRole?: 'hermes-gateway' | 'standard';
		readonly selectionRecordPath: string;
	},
	dependencies: GatewayImageBuilderDependencies,
): Promise<ManagedVmImageBuildResult> {
	return await dependencies.managedVmImages.prepareImage({
		artifactCacheDirectory: options.artifactCacheDirectory,
		recipePath: options.buildConfigPath,
		...(options.expectedBootRole === undefined
			? {}
			: { expectedBootRole: options.expectedBootRole }),
		selectionRecordPath: options.selectionRecordPath,
	});
}
