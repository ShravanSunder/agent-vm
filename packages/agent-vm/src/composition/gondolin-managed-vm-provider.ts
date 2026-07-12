import {
	configureHostNetworkDefaults,
	createGondolinManagedVmProvider,
} from '@agent-vm/gondolin-vm-adapter';
import type {
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
	readonly managedVmFactory: ManagedVmFactory;
	readonly managedVmImages: ManagedVmImageCapability;
	readonly managedVmOwnedDirectories: ManagedVmOwnedDirectoryCapability;
}

function createAuthoritativeManagedVmImageCapability(
	providerImages: ManagedVmImageCapability,
): ManagedVmImageCapability {
	return {
		async prepareImage(request: ManagedVmImageBuildRequest): Promise<ManagedVmImageBuildResult> {
			if (request.forceRebuild !== true) {
				const preparedImage = await readPreparedManagedVmImage({
					buildConfigPath: request.recipePath,
					cacheDir: request.cacheDirectory,
				});
				if (preparedImage !== undefined) {
					return {
						built: preparedImage.built,
						fingerprint: preparedImage.fingerprint,
						imageReference: preparedImage.imagePath,
					};
				}
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
		managedVmFactory: provider.factory,
		managedVmImages: createAuthoritativeManagedVmImageCapability(provider.images),
		managedVmOwnedDirectories: provider.ownedDirectories,
	};
}
