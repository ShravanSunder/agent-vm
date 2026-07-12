import type { ManagedVmFactory } from '@agent-vm/managed-vm';

export function misuseProjectedFactory(factory: ManagedVmFactory): void {
	void factory.images;
}
