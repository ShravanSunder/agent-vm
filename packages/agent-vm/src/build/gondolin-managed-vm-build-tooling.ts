import {
	buildImageAssetFileNames as gondolinImageAssetFileNames,
	createGondolinImageBuildTooling,
	hasBuiltImageAssets as hasGondolinImageAssets,
	resolveGondolinMinimumZigVersion as resolveMinimumZigVersion,
	resolveGondolinPackageSpec as resolvePackageSpec,
} from '@agent-vm/gondolin-vm-adapter';

export interface ManagedVmBackendImageBuildOptions {
	readonly buildConfig: unknown;
	readonly cacheDir: string;
	readonly configDir?: string;
	readonly fullReset?: boolean;
	readonly fingerprintInput?: unknown;
	readonly output?: { write(chunk: string | Uint8Array): boolean };
}

export interface ManagedVmBackendImageBuildResult {
	readonly built: boolean;
	readonly fingerprint: string;
	readonly imagePath: string;
}

export interface ManagedVmBackendImageBuildTooling {
	buildImage(
		options: ManagedVmBackendImageBuildOptions,
		dependencies?: { readonly gondolinVersion?: string },
	): Promise<ManagedVmBackendImageBuildResult>;
	computeFingerprint(options: {
		readonly buildConfig: unknown;
		readonly configDir?: string;
		readonly fingerprintInput?: unknown;
		readonly gondolinVersion?: string;
	}): Promise<string>;
}

/**
 * Gondolin-specific build metadata projected as backend-neutral primitive values.
 *
 * This module is the sole build/tooling composition boundary for the selected
 * managed-VM backend. Runtime provider construction belongs to the separate
 * application composition root.
 */
export const managedVmImageAssetFileNames: readonly string[] = gondolinImageAssetFileNames;

export function createManagedVmBackendImageBuildTooling(): ManagedVmBackendImageBuildTooling {
	return createGondolinImageBuildTooling();
}

export async function hasManagedVmImageAssets(imageDirectoryPath: string): Promise<boolean> {
	return await hasGondolinImageAssets(imageDirectoryPath);
}

export async function resolveManagedVmMinimumZigVersion(): Promise<string> {
	return await resolveMinimumZigVersion();
}

export async function resolveManagedVmBackendPackageSpec(): Promise<string> {
	return await resolvePackageSpec();
}

export function resolveManagedVmBackendModuleUrl(): URL {
	return new URL(import.meta.resolve('@agent-vm/gondolin-vm-adapter'));
}
