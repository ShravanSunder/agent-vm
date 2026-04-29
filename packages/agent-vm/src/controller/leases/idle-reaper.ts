export function createIdleReaper(options: {
	readonly getLeases: () => {
		readonly id: string;
		readonly lastUsedAt: number;
	}[];
	readonly now: () => number;
	readonly releaseLease: (
		leaseId: string,
		options?: { readonly ifLastUsedAtBeforeOrAt?: number },
	) => Promise<void>;
	readonly ttlMs: number;
}): {
	reapExpiredLeases(): Promise<void>;
} {
	return {
		async reapExpiredLeases(): Promise<void> {
			const expirationCutoff = options.now() - options.ttlMs;
			const expiredLeaseIds = options
				.getLeases()
				.filter((lease) => lease.lastUsedAt < expirationCutoff)
				.map((lease) => lease.id);
			for (const leaseId of expiredLeaseIds) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- release must stay sequential to avoid TCP pool races
				await options.releaseLease(leaseId, { ifLastUsedAtBeforeOrAt: expirationCutoff });
			}
		},
	};
}
