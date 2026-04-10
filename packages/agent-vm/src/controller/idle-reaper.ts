export function createIdleReaper(options: {
	readonly getLeases: () => {
		readonly id: string;
		readonly lastUsedAt: number;
	}[];
	readonly now: () => number;
	readonly releaseLease: (leaseId: string) => Promise<void>;
	readonly ttlMs: number;
}): {
	reapExpiredLeases(): Promise<void>;
} {
	return {
		async reapExpiredLeases(): Promise<void> {
			const expiredLeaseIds = options
				.getLeases()
				.filter((lease) => options.now() - lease.lastUsedAt > options.ttlMs)
				.map((lease) => lease.id);
			await Promise.all(
				expiredLeaseIds.map(async (leaseId) => await options.releaseLease(leaseId)),
			);
		},
	};
}
