export function createIdleReaper(options: {
	readonly getLeases: () => {
		readonly id: string;
		readonly lastUsedAt: number;
		readonly scopeKey: string;
	}[];
	readonly now: () => number;
	readonly releaseLease: (
		leaseId: string,
		options?: { readonly ifLastUsedAtBeforeOrAt?: number },
	) => Promise<void>;
	readonly ttlForLease: (lease: { readonly scopeKey: string }) => number;
}): {
	reapExpiredLeases(): Promise<void>;
} {
	return {
		async reapExpiredLeases(): Promise<void> {
			const now = options.now();
			const expiredLeases = options.getLeases().flatMap((lease) => {
				const expirationCutoff = now - options.ttlForLease(lease);
				return lease.lastUsedAt < expirationCutoff ? [{ expirationCutoff, leaseId: lease.id }] : [];
			});
			const releaseErrors: Error[] = [];
			for (const expiredLease of expiredLeases) {
				try {
					// oxlint-disable-next-line eslint/no-await-in-loop -- release must stay sequential to avoid TCP pool races
					await options.releaseLease(expiredLease.leaseId, {
						ifLastUsedAtBeforeOrAt: expiredLease.expirationCutoff,
					});
				} catch (error) {
					releaseErrors.push(error instanceof Error ? error : new Error(String(error)));
				}
			}
			if (releaseErrors.length > 0) {
				throw new AggregateError(
					releaseErrors,
					`Failed to release ${String(releaseErrors.length)} expired lease(s).`,
				);
			}
		},
	};
}
