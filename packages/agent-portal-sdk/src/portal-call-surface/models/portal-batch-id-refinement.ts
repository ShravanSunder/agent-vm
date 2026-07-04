import type { z } from 'zod';

export interface PortalBatchItemWithId {
	readonly id: string;
}

export function addDuplicateItemIdIssues(
	items: readonly PortalBatchItemWithId[],
	context: z.RefinementCtx,
): void {
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	for (const item of items) {
		if (seenIds.has(item.id)) {
			duplicateIds.add(item.id);
		}
		seenIds.add(item.id);
	}
	for (const duplicateId of [...duplicateIds].toSorted()) {
		context.addIssue({
			code: 'custom',
			message: `Duplicate portal item id "${duplicateId}".`,
			path: ['id'],
		});
	}
}
