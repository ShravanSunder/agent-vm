export interface TcpPool {
	allocate(): number;
	getAllMappings(): Record<string, string>;
	portForSlot(slot: number): number;
	release(slot: number): void;
}

export function createTcpPool(options: {
	readonly basePort: number;
	readonly size: number;
}): TcpPool {
	const allocatedSlots = new Set<number>();

	return {
		allocate(): number {
			for (let slot = 0; slot < options.size; slot += 1) {
				if (!allocatedSlots.has(slot)) {
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
	};
}
