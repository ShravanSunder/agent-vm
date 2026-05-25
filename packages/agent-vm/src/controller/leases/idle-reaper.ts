export function createIdleReaper(options: {
	readonly getLeases: () => {
		readonly activeUseCount: number;
		readonly effectiveIdleTtlMs: number;
		readonly id: string;
		readonly lastUsedAt: number;
	}[];
	readonly now: () => number;
	readonly releaseLease: (
		leaseId: string,
		options?: { readonly ifLastUsedAtBeforeOrAt?: number },
	) => Promise<void>;
}): {
	reapExpiredLeases(): Promise<void>;
} {
	return {
		async reapExpiredLeases(): Promise<void> {
			const now = options.now();
			const expiredLeases = options.getLeases().flatMap((lease) => {
				if (lease.activeUseCount > 0) {
					return [];
				}
				const expirationCutoff = now - lease.effectiveIdleTtlMs;
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
					releaseErrors.push(
						new Error(
							`Failed to release expired lease '${expiredLease.leaseId}': ${
								error instanceof Error ? error.message : String(error)
							}`,
							{ cause: error },
						),
					);
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
