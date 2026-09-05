import {
	configureHostNetworkDefaults,
	createGondolinManagedVmProvider,
} from '@agent-vm/gondolin-vm-adapter';
import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmImageBuildRequest,
	ManagedVmImageBuildResult,
	ManagedVmImageCapability,
	ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';

import { readPreparedManagedVmImage } from '../build/prepared-gondolin-image-cache.js';

export interface ManagedVmHostNetworkDefaults {
	readonly autoSelectFamily: false | 'unavailable';
	readonly dnsResultOrder: 'ipv4first' | 'unavailable';
}

export type ConfigureManagedVmHostNetworkDefaults = () => ManagedVmHostNetworkDefaults;

/** Neutral runtime capabilities selected by the application composition root. */
export interface ManagedVmRuntimeComposition {
	readonly configureManagedVmHostNetworkDefaults: ConfigureManagedVmHostNetworkDefaults;
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmFactory: ManagedVmFactory;
	readonly managedVmImages: ManagedVmImageCapability;
	readonly managedVmOwnedDirectories: ManagedVmOwnedDirectoryCapability;
}

function createAuthoritativeManagedVmImageCapability(
	providerImages: ManagedVmImageCapability,
): ManagedVmImageCapability {
	return {
		async prepareImage(request: ManagedVmImageBuildRequest): Promise<ManagedVmImageBuildResult> {
			if (request.selectionRecordPath !== undefined) {
				const preparedImage = await readPreparedManagedVmImage({
					buildConfigPath: request.recipePath,
					...(request.expectedBootRole === 'hermes-gateway'
						? {
								expectedManagedGatewayBoot: {
									kind: 'managed-gateway-exact-two-role',
									frameworkBootEntry: 'hermes-framework-service',
								} as const,
							}
						: {}),
					selectionRecordPath: request.selectionRecordPath,
					sharedImageCacheDir: request.artifactCacheDirectory,
				});
				if (preparedImage !== undefined) {
					return {
						built: preparedImage.built,
						fingerprint: preparedImage.fingerprint,
						imageReference: preparedImage.imagePath,
					};
				}
				throw new Error(
					`Managed VM image selection is missing or invalid for '${request.recipePath}'. Run agent-vm build before starting the controller.`,
				);
			}
			return await providerImages.prepareImage(request);
		},
	};
}

/** Select the configured backend once while keeping its aggregate provider inside composition. */
export function createManagedVmRuntimeComposition(): ManagedVmRuntimeComposition {
	const provider = createGondolinManagedVmProvider();
	return {
		configureManagedVmHostNetworkDefaults: configureHostNetworkDefaults,
		managedVmExactProcessTermination: provider.exactProcessTermination,
		managedVmFactory: provider.factory,
		managedVmImages: createAuthoritativeManagedVmImageCapability(provider.images),
		managedVmOwnedDirectories: provider.ownedDirectories,
	};
}
