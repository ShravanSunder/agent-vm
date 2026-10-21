import type { ApprovalMode, AccessRow } from '@tool-access-ui/panel-state/models/panel-view-types';
import { assertNever } from '@tool-access-ui/panel-state/panel-state-exhaustiveness';
export function modeBadgeVariant(
	mode: ApprovalMode,
): 'default' | 'secondary' | 'outline' | 'destructive' {
	switch (mode) {
		case 'approved':
			return 'default';
		case 'auto':
			return 'secondary';
		case 'requires approval':
			return 'outline';
		case 'blocked':
			return 'destructive';
		default:
			return assertNever(mode);
	}
}
export function describeRuleScope(row: AccessRow): string {
	switch (row.scope.kind) {
		case 'profile':
			return `${row.scope.profile} profile`;
		case 'account':
			return `${row.scope.account} · ${row.scope.agent} · ${row.scope.application}`;
		default:
			return assertNever(row.scope);
	}
}
