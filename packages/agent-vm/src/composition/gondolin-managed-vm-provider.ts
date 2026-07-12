import {
	configureHostNetworkDefaults,
	createGondolinManagedVmProvider,
} from '@agent-vm/gondolin-vm-adapter';
import type {
	ManagedVmFactory,
	ManagedVmImageCapability,
	ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';

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

/** Select Gondolin once while keeping its aggregate provider inside composition. */
export function createGondolinManagedVmRuntimeComposition(): ManagedVmRuntimeComposition {
	const provider = createGondolinManagedVmProvider();
	return {
		configureManagedVmHostNetworkDefaults: configureHostNetworkDefaults,
		managedVmFactory: provider.factory,
		managedVmImages: provider.images,
		managedVmOwnedDirectories: provider.ownedDirectories,
	};
}
