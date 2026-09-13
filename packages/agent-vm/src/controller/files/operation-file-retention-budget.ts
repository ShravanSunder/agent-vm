export interface OperationFileRetentionOwner {
	reserve(reservationId: string, maximumBytes: number): boolean;
	resize(reservationId: string, actualBytes: number): boolean;
	releaseAfterCleanup(reservationId: string): void;
	releaseAllAfterCleanup(): void;
	retainedBytes(): number;
}

export interface OperationFileRetentionBudget {
	forOwner(props: {
		readonly agentId: string;
		readonly zoneId: string;
		readonly ownerId: string;
	}): OperationFileRetentionOwner;
}

/** Metadata only. Owners release their own reservations after proven cleanup or VM containment. */
export function createOperationFileRetentionBudget(): OperationFileRetentionBudget {
	const agents = new Map<string, Map<string, Map<string, number>>>();
	const sum = (reservations: ReadonlyMap<string, number> | undefined): number =>
		[...(reservations?.values() ?? [])].reduce((total, bytes) => total + bytes, 0);
	return {
		forOwner: ({ agentId, zoneId, ownerId }) => {
			const agentKey = JSON.stringify([zoneId, agentId]);
			const prune = (): void => {
				const owners = agents.get(agentKey);
				if (owners?.get(ownerId)?.size === 0) owners.delete(ownerId);
				if (owners?.size === 0) agents.delete(agentKey);
			};
			return {
				reserve: (reservationId, maximumBytes) => {
					if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return false;
					const owners = agents.get(agentKey) ?? new Map<string, Map<string, number>>();
					const reservations = owners.get(ownerId) ?? new Map<string, number>();
					const retained = [...owners.values()].reduce((total, owner) => total + sum(owner), 0);
					if (reservations.has(reservationId) || retained + maximumBytes > 64 * 1024 * 1024)
						return false;
					reservations.set(reservationId, maximumBytes);
					owners.set(ownerId, reservations);
					agents.set(agentKey, owners);
					return true;
				},
				resize: (reservationId, actualBytes) => {
					const reservations = agents.get(agentKey)?.get(ownerId);
					const maximum = reservations?.get(reservationId);
					if (
						maximum === undefined ||
						!Number.isSafeInteger(actualBytes) ||
						actualBytes < 0 ||
						actualBytes > maximum
					)
						return false;
					reservations?.set(reservationId, actualBytes);
					return true;
				},
				releaseAfterCleanup: (reservationId) => {
					agents.get(agentKey)?.get(ownerId)?.delete(reservationId);
					prune();
				},
				releaseAllAfterCleanup: () => {
					agents.get(agentKey)?.delete(ownerId);
					prune();
				},
				retainedBytes: () => sum(agents.get(agentKey)?.get(ownerId)),
			};
		},
	};
}
