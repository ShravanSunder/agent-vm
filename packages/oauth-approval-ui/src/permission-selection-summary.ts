import type { OAuthApplicationChoiceModel } from './contracts.js';

export function resolvePermissionSelectionMode(
	application: OAuthApplicationChoiceModel,
): 'off' | 'recommended' | 'custom' {
	if (application.selectionMode !== undefined) return application.selectionMode;
	if (application.selectedGroupIds.length === 0) return 'off';
	const recommended = new Set(application.recommendedGroupIds);
	return application.selectedGroupIds.length === recommended.size &&
		application.selectedGroupIds.every((groupId) => recommended.has(groupId))
		? 'recommended'
		: 'custom';
}

/** Counts groups selected by each active mode, not the dormant Custom controls. */
export function permissionSelectionSummary(groupCounts: readonly number[]): string {
	const applicationCount = groupCounts.filter((count) => count > 0).length;
	const groupCount = groupCounts.reduce((total, count) => total + count, 0);
	return groupCount === 0
		? 'No Google access selected.'
		: `${String(groupCount)} permission ${groupCount === 1 ? 'group' : 'groups'} selected across ${String(applicationCount)} ${applicationCount === 1 ? 'application' : 'applications'}.`;
}
