import type { AccessRow, AccessFilters } from '@tool-access-ui/panel-state/models/panel-view-types';
export function filterAssociations(
	rows: readonly AccessRow[],
	filters: AccessFilters,
): readonly AccessRow[] {
	return rows.filter(
		(row): boolean =>
			(filters.tool === 'All' || row.tool === filters.tool) &&
			(filters.agent === 'All' || row.agents.includes(filters.agent)) &&
			(filters.account === 'All' || row.account === filters.account) &&
			(filters.profile === 'All' || row.profile === filters.profile),
	);
}
