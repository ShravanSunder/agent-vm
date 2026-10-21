/** Browser view contracts. Hosts adapt their own identities and policy into these views. */
export type ApprovalMode = 'approved' | 'auto' | 'requires approval' | 'blocked';
export const approvalModes: readonly ApprovalMode[] = [
	'approved',
	'auto',
	'requires approval',
	'blocked',
];
export type ToolKind = 'Organization tools' | 'Per-user tools' | 'Computer tools';
export type RuleScope =
	| { readonly kind: 'profile'; readonly profile: string }
	| {
			readonly kind: 'account';
			readonly account: string;
			readonly agent: string;
			readonly application: string;
	  };
export interface AccessRow {
	readonly id: string;
	readonly tool: string;
	readonly toolKind: ToolKind;
	readonly provider: string;
	readonly profile: string;
	readonly agents: readonly string[];
	readonly account: string;
	readonly mode: ApprovalMode;
	readonly manager: string;
	readonly scope: RuleScope;
}
export interface ConnectedAccount {
	readonly name: string;
	readonly address: string;
	readonly provider: string;
	readonly kind: 'Personal' | 'Team' | 'Integration';
	readonly owner: string;
	readonly status: 'Connected' | 'Needs key' | 'Needs account' | 'Awaiting confirmation';
	readonly grants: string;
	readonly options: readonly string[];
}
export interface AuditEntry {
	readonly id: string;
	readonly when: string;
	readonly who: string;
	readonly change: string;
	readonly target: string;
	readonly details: string;
}
export interface AccessFilters {
	readonly tool: string;
	readonly agent: string;
	readonly account: string;
	readonly profile: string;
}
export const allAccessFilters: AccessFilters = {
	tool: 'All',
	agent: 'All',
	account: 'All',
	profile: 'All',
};
export interface PanelSnapshot {
	readonly revision: string;
	readonly organization: string;
	readonly person: string;
	readonly sourceLabel: string;
	readonly associations: readonly AccessRow[];
	readonly visibleAssociations: readonly AccessRow[];
	readonly accounts: readonly ConnectedAccount[];
	readonly audit: readonly AuditEntry[];
}
export interface ChangeIntent {
	readonly rowId: string;
	readonly mode: ApprovalMode;
	readonly reason: string;
}
export interface ProposalDraft extends ChangeIntent {
	readonly id: string;
	readonly baseRevision: string;
	readonly current: AccessRow;
}
export type ProposalResult =
	| { readonly kind: 'proposed'; readonly proposal: ProposalDraft }
	| { readonly kind: 'rejected'; readonly message: string };
export type AcceptResult =
	| { readonly kind: 'accepted'; readonly snapshot: PanelSnapshot }
	| { readonly kind: 'rejected'; readonly message: string }
	| { readonly kind: 'stale'; readonly snapshot: PanelSnapshot; readonly message: string }
	| { readonly kind: 'unconfirmed'; readonly message: string };
export interface ScanEntry {
	readonly integration: string;
	readonly status: string;
	readonly nextStep: string;
}
export interface ScanResult {
	readonly kind: 'example' | 'static' | 'live';
	readonly checkedAt: string;
	readonly entries: readonly ScanEntry[];
}
/** This port owns confirmed state. Implementations must authorize and audit writes themselves.
 * No browser edit, request classification or attribution grants authority. Wire adapters parse
 * untrusted payloads before producing these typed views. Rejections must not claim success.
 */
export interface ToolAccessPanelPort {
	read(filters: AccessFilters): Promise<PanelSnapshot>;
	proposeChange(intent: ChangeIntent): Promise<ProposalResult>;
	acceptProposal(draft: ProposalDraft): Promise<AcceptResult>;
	denyProposal(draft: ProposalDraft): Promise<void>;
	scan(filters: AccessFilters): Promise<ScanResult>;
}
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
export function assertNever(value: never): never {
	throw new Error(`Unexpected panel variant: ${String(value)}`);
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
