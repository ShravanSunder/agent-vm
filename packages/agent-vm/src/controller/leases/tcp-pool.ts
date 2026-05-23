export interface TcpPool {
	allocate(): number;
	getAllMappings(): Record<string, string>;
	portForSlot(slot: number): number;
	// Mark a slot free for re-allocation. Caller must have proven the slot's
	// previous VM is no longer holding the host port (vm.close() returned
	// successfully OR the recorded PID has been verified dead).
	release(slot: number): void;
	// Move a slot into quarantine. Use when vm.close() failed and the VM may
	// still be alive on the host port. Quarantined slots are skipped by
	// allocate() until releaseQuarantined() proves the slot is reusable.
	quarantine(slot: number): void;
	// Promote a quarantined slot back to free after external proof of liveness
	// (e.g., a background poller observed the recorded PID is gone). No-op if
	// the slot is not quarantined.
	releaseQuarantined(slot: number): void;
	isQuarantined(slot: number): boolean;
}

export function createTcpPool(options: {
	readonly basePort: number;
	readonly size: number;
}): TcpPool {
	const allocatedSlots = new Set<number>();
	const quarantinedSlots = new Set<number>();

	return {
		allocate(): number {
			for (let slot = 0; slot < options.size; slot += 1) {
				if (!allocatedSlots.has(slot) && !quarantinedSlots.has(slot)) {
					allocatedSlots.add(slot);
					return slot;
				}
			}

			throw new Error('No TCP slots available');
		},
		getAllMappings(): Record<string, string> {
			return Object.fromEntries(
				[...allocatedSlots]
					.toSorted((leftSlot, rightSlot) => leftSlot - rightSlot)
					.map((slot) => [`tool-${slot}.vm.host:22`, `127.0.0.1:${options.basePort + slot}`]),
			);
		},
		portForSlot(slot: number): number {
			return options.basePort + slot;
		},
		release(slot: number): void {
			allocatedSlots.delete(slot);
		},
		quarantine(slot: number): void {
			allocatedSlots.delete(slot);
			quarantinedSlots.add(slot);
		},
		releaseQuarantined(slot: number): void {
			quarantinedSlots.delete(slot);
		},
		isQuarantined(slot: number): boolean {
			return quarantinedSlots.has(slot);
		},
	};
}
