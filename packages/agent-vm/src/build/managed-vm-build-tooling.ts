import {
	resolveManagedVmBackendPackageSpec as resolveBackendPackageSpec,
	resolveManagedVmMinimumZigVersion as resolveMinimumZigVersion,
} from './gondolin-managed-vm-build-tooling.js';

/** Backend-neutral build metadata used by CLI composition. */
export async function resolveManagedVmBackendPackageSpec(): Promise<string> {
	return await resolveBackendPackageSpec();
}

export async function resolveManagedVmMinimumZigVersion(): Promise<string> {
	return await resolveMinimumZigVersion();
}
