import type { ManagedVm, ManagedVmCreateRequest, OwnedHostDirectory } from '@agent-vm/managed-vm';

export function misuseNativeVmEscape(vm: ManagedVm): void {
	void vm.getVmInstance();
	void vm.fs;
}

export function misuseBackendPayload(request: ManagedVmCreateRequest): void {
	void request.nativeOptions;
	void request.backendData;
}

export function misuseOwnedDirectoryHandle(directory: OwnedHostDirectory): void {
	void directory.fd;
	void directory.hostPath;
}
