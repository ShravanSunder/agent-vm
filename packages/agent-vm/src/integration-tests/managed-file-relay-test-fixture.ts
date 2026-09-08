import { createHash } from 'node:crypto';

import type { ManagedVm, ManagedVmFileTransferCapability } from '@agent-vm/managed-vm';

import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';

export const fileRelayPythonExecutable = '/opt/hermes/.venv/bin/python';
export const fileRelayOperationDirectory = '/var/tmp/agent-vm-file-relay-proof';
export const fileRelayBytePattern = Uint8Array.from({ length: 65_536 }, (_, index) => index % 256);

export function requireManagedFileTransfer(vm: ManagedVm): ManagedVmFileTransferCapability {
	if (vm.fileTransfer === undefined) {
		throw new Error('The selected VM backend does not support streaming file writes.');
	}
	return vm.fileTransfer;
}

export function expectedFileRelayDigest(size: number): string {
	const hash = createHash('sha256');
	for (let remaining = size; remaining > 0; remaining -= fileRelayBytePattern.byteLength) {
		hash.update(
			fileRelayBytePattern.subarray(0, Math.min(remaining, fileRelayBytePattern.byteLength)),
		);
	}
	return hash.digest('hex');
}

/** Reuse an already-prepared managed image; never add a host data mount. */
export async function createManagedFileRelayDestinationVm(
	imageReference: string,
): Promise<ManagedVm> {
	const vm = await createManagedVmRuntimeComposition().managedVmFactory.createManagedVm({
		allowedHosts: [],
		environment: {},
		imageReference,
		mediatedSecrets: [],
		mounts: {},
		resources: { cpuCount: 1, memory: '512M' },
		rootfsMode: 'cow',
		sessionLabel: 'managed-file-relay-destination',
		tcpHosts: [],
	});
	try {
		await vm.start();
		await requireManagedFileTransfer(vm).createDirectory({
			guestPath: fileRelayOperationDirectory,
		});
		return vm;
	} catch (error) {
		await vm.close();
		throw error;
	}
}
