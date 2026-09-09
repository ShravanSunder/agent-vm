import { createHash } from 'node:crypto';

import type { ManagedVm } from '@agent-vm/managed-vm';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';

export const fileRelayPythonExecutable = '/opt/hermes/.venv/bin/python';
export const fileRelayBytePattern = Uint8Array.from({ length: 65_536 }, (_, index) => index % 256);

export function expectedFileRelayDigest(size: number): string {
	const hash = createHash('sha256');
	for (let remaining = size; remaining > 0; remaining -= fileRelayBytePattern.byteLength) {
		hash.update(
			fileRelayBytePattern.subarray(0, Math.min(remaining, fileRelayBytePattern.byteLength)),
		);
	}
	return hash.digest('hex');
}

/** Match production attachment delivery through the existing Gateway cache mount. */
export async function createManagedFileRelayDestinationVm(
	imageReference: string,
	cacheDirectory: string,
): Promise<ManagedVm> {
	const composition = createManagedVmRuntimeComposition();
	const vm = await composition.managedVmFactory.createManagedVm({
		allowedHosts: [],
		environment: {},
		imageReference,
		mediatedSecrets: [],
		mounts: {
			'/home/hermes/.cache': {
				kind: 'owned-host-directory',
				access: 'read-write',
				directory: composition.managedVmOwnedDirectories.openHostDirectory(cacheDirectory),
			},
		},
		resources: { cpuCount: 1, memory: '512M' },
		rootfsMode: 'cow',
		sessionLabel: 'managed-file-relay-destination',
		tcpHosts: [],
	});
	try {
		await vm.start();
		return vm;
	} catch (error) {
		await vm.close();
		throw error;
	}
}
