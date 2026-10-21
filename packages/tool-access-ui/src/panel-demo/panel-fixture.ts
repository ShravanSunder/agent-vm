import { initialAccess, connectedAccounts } from '@tool-access-ui/panel-demo/panel-fixture-data';
import { filterAssociations } from '@tool-access-ui/panel-state/association-filters';
import {
	allAccessFilters,
	type ToolAccessPanelPort,
	type PanelSnapshot,
	type ProposalDraft,
	type AccessRow,
	type AuditEntry,
} from '@tool-access-ui/panel-state/models/panel-view-types';
/** STAND-IN: browser-memory demonstration only. No auth, durable audit, provider or host.
 * Reload creates a new fixture. Never use this implementation to enforce access. */
export function createToolAccessPanelFixture(): ToolAccessPanelPort {
	let rows: readonly AccessRow[] = structuredClone(initialAccess);
	let audit: readonly AuditEntry[] = [];
	let revision = 1;
	let nextProposal = 0;
	const proposals = new Set<string>();
	function snapshot(filters = allAccessFilters): PanelSnapshot {
		return structuredClone({
			revision: String(revision),
			organization: 'Studio',
			person: 'Maya',
			sourceLabel: 'In-memory fixture · stand-in',
			associations: rows,
			visibleAssociations: filterAssociations(rows, filters),
			accounts: connectedAccounts,
			audit,
		});
	}
	return {
		async read(filters) {
			return snapshot(filters);
		},
		async proposeChange(intent) {
			const current = rows.find((row): boolean => row.id === intent.rowId);
			if (!current) return { kind: 'rejected', message: 'Tool is no longer available.' };
			nextProposal += 1;
			const id = `fixture-proposal-${nextProposal}`;
			proposals.add(id);
			return {
				kind: 'proposed',
				proposal: {
					...intent,
					id,
					baseRevision: String(revision),
					current: structuredClone(current),
				},
			};
		},
		async acceptProposal(draft: ProposalDraft) {
			if (!proposals.has(draft.id))
				return { kind: 'rejected', message: 'Proposal is no longer active.' };
			if (draft.baseRevision !== String(revision))
				return {
					kind: 'stale',
					snapshot: snapshot(),
					message: 'Current values changed. Review the refreshed scope before accepting again.',
				};
			const target = rows.find((row): boolean => row.id === draft.rowId);
			if (!target || draft.mode === 'auto' || !draft.reason.trim())
				return { kind: 'rejected', message: 'Choose an available mode and describe the change.' };
			rows = rows.map(
				(row): AccessRow => (row.id === draft.rowId ? { ...row, mode: draft.mode } : row),
			);
			revision += 1;
			audit = [
				{
					id: `fixture-event-${revision}`,
					when: 'Fixture session',
					who: 'Maya',
					change: 'Mode changed',
					target: target.tool,
					details: `${target.mode} → ${draft.mode} · ${target.profile} · ${target.account} · ${draft.reason}`,
				},
				...audit,
			];
			proposals.delete(draft.id);
			return { kind: 'accepted', snapshot: snapshot() };
		},
		async denyProposal(draft) {
			proposals.delete(draft.id);
		},
		async scan(filters) {
			const providers = new Set(
				filterAssociations(rows, filters).map((row): string => row.provider),
			);
			return {
				kind: 'example',
				checkedAt: 'Fixture session (no provider contacted)',
				entries: connectedAccounts
					.filter((account): boolean => providers.has(account.provider))
					.map((account) => ({
						integration: account.provider,
						status: account.status,
						nextStep:
							account.status === 'Needs key'
								? 'Review protected credential setup.'
								: 'Review account grants and rules.',
					})),
			};
		},
	};
}
