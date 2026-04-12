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
			for (const leaseId of expiredLeaseIds) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- release must stay sequential to avoid TCP pool races
				await options.releaseLease(leaseId);
			}
		},
	};
}
