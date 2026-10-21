import { filterAssociations } from '@tool-access-ui/panel-state/association-filters';
import {
	allAccessFilters,
	type AccessFilters,
	type AccessRow,
	type ChangeIntent,
	type PanelSnapshot,
	type ProposalDraft,
	type ScanResult,
	type ToolAccessPanelPort,
} from '@tool-access-ui/panel-state/models/panel-view-types';
import { routePanelRequest } from '@tool-access-ui/panel-state/panel-request-router';
import { assertNever } from '@tool-access-ui/panel-state/panel-state-exhaustiveness';
import type { Destination } from '@tool-access-ui/panel-views/organization-navigation';
import type { ProposalActivity } from '@tool-access-ui/panel-views/proposal-form';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
type PanelLoad =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready'; readonly snapshot: PanelSnapshot }
	| { readonly kind: 'failed'; readonly message: string };
type ProposalState =
	| { readonly kind: 'none' }
	| { readonly kind: 'preparing' }
	| { readonly kind: 'failed'; readonly intent: ChangeIntent; readonly message: string }
	| { readonly kind: 'open'; readonly draft: ProposalDraft; readonly activity: ProposalActivity };
type ScanState =
	| { readonly kind: 'hidden' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready'; readonly result: ScanResult }
	| { readonly kind: 'failed'; readonly message: string };
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'The host could not complete this request.';
}
interface PanelModel {
	readonly load: PanelLoad;
	readonly filters: AccessFilters;
	readonly destination: Destination;
	readonly proposal: ProposalState;
	readonly scan: ScanState;
	readonly feedback: string;
	readonly setFilters: (filters: AccessFilters) => void;
	readonly setDestination: (destination: Destination) => void;
	readonly submitRequest: (request: string) => void;
	readonly proposeRow: (row: AccessRow) => void;
	readonly editProposal: (draft: ProposalDraft) => void;
	readonly acceptProposal: () => Promise<void>;
	readonly denyProposal: () => Promise<void>;
	readonly readCurrent: () => Promise<void>;
	readonly showScan: () => Promise<void>;
	readonly retryRead: () => void;
	readonly retryProposal: () => void;
}
export function usePanelModel(port: ToolAccessPanelPort): PanelModel {
	const [load, setLoad] = useState<PanelLoad>({ kind: 'loading' });
	const [filters, setFilters] = useState<AccessFilters>(allAccessFilters);
	// Async write results need the selection made while the host was pending.
	const latestFilters = useRef(allAccessFilters);
	const [destination, setDestination] = useState<Destination>('access');
	const [proposal, setProposal] = useState<ProposalState>({ kind: 'none' });
	const [scan, setScan] = useState<ScanState>({ kind: 'hidden' });
	const [feedback, setFeedback] = useState('');
	const [reload, setReload] = useState(0);
	const pendingWrite = useRef(false);
	const proposalActive = useRef(false);
	const readSequence = useRef(0);
	useEffect((): (() => void) => {
		let active = true;
		const sequence = ++readSequence.current;
		void port.read(filters).then(
			(snapshot): void => {
				if (active && readSequence.current === sequence) setLoad({ kind: 'ready', snapshot });
			},
			(error: unknown): void => {
				if (active && readSequence.current === sequence)
					setLoad({ kind: 'failed', message: errorMessage(error) });
			},
		);
		return (): void => {
			active = false;
		};
	}, [port, filters, reload]);
	function selectFilters(nextFilters: AccessFilters): void {
		latestFilters.current = nextFilters;
		setFilters(nextFilters);
	}
	async function propose(intent: ChangeIntent): Promise<void> {
		if (proposalActive.current) {
			setFeedback('Accept or deny the current proposal before making another.');
			return;
		}
		proposalActive.current = true;
		setProposal({ kind: 'preparing' });
		try {
			const result = await port.proposeChange(intent);
			switch (result.kind) {
				case 'proposed':
					setProposal({ kind: 'open', draft: result.proposal, activity: { kind: 'editing' } });
					setDestination('access');
					setFeedback('Draft proposal ready. Review the form below.');
					break;
				case 'rejected':
					proposalActive.current = false;
					setProposal({ kind: 'failed', intent, message: result.message });
					break;
				default:
					assertNever(result);
			}
		} catch (error) {
			proposalActive.current = false;
			setProposal({ kind: 'failed', intent, message: errorMessage(error) });
		}
	}
	function clearFailedProposal(): void {
		setProposal(
			(current): ProposalState => (current.kind === 'failed' ? { kind: 'none' } : current),
		);
	}
	async function showScan(): Promise<void> {
		clearFailedProposal();
		setScan({ kind: 'loading' });
		setDestination('access');
		try {
			setScan({ kind: 'ready', result: await port.scan(filters) });
		} catch (error) {
			setScan({ kind: 'failed', message: errorMessage(error) });
		}
	}
	function submitRequest(request: string): void {
		if (proposalActive.current) {
			setFeedback('Accept or deny the current proposal before making another.');
			return;
		}
		if (load.kind !== 'ready') return;
		clearFailedProposal();
		const route = routePanelRequest(request, load.snapshot.associations);
		switch (route.kind) {
			case 'show':
				selectFilters(route.filters);
				setDestination('access');
				setScan({ kind: 'hidden' });
				setFeedback('View updated. No settings changed.');
				break;
			case 'scan':
				void showScan();
				break;
			case 'propose':
				void propose(route.intent);
				break;
			case 'clarify':
				setDestination('access');
				setFeedback(route.message);
				break;
			case 'unsupported':
				setFeedback(route.message);
				break;
			default:
				assertNever(route);
		}
	}
	function proposeRow(row: AccessRow): void {
		void propose({
			rowId: row.id,
			mode: row.mode === 'blocked' ? 'requires approval' : 'blocked',
			reason: `Change ${row.tool.toLowerCase()} for ${row.profile}.`,
		});
	}
	function editProposal(draft: ProposalDraft): void {
		if (!pendingWrite.current) setProposal({ kind: 'open', draft, activity: { kind: 'editing' } });
	}
	async function acceptProposal(): Promise<void> {
		if (
			proposal.kind !== 'open' ||
			pendingWrite.current ||
			proposal.activity.kind === 'unconfirmed'
		)
			return;
		const draft = proposal.draft;
		if (draft.mode === 'auto' || draft.mode === draft.current.mode || !draft.reason.trim()) return;
		pendingWrite.current = true;
		// Invalidate in-flight reads so older views cannot overwrite a confirmed acceptance.
		readSequence.current += 1;
		setProposal({ ...proposal, activity: { kind: 'saving' } });
		try {
			const result = await port.acceptProposal(draft);
			// Reads begun during the write also precede this confirmed result.
			readSequence.current += 1;
			// Reload uses the current render's filters, including changes made while awaiting the host.
			setReload((value): number => value + 1);
			switch (result.kind) {
				case 'accepted':
					setLoad({
						kind: 'ready',
						snapshot: {
							...result.snapshot,
							visibleAssociations: filterAssociations(
								result.snapshot.associations,
								latestFilters.current,
							),
						},
					});
					proposalActive.current = false;
					setProposal({ kind: 'none' });
					setFeedback('Change confirmed by host.');
					toast('Change accepted');
					break;
				case 'rejected':
					setProposal({
						kind: 'open',
						draft,
						activity: { kind: 'failed', message: result.message },
					});
					break;
				case 'unconfirmed':
					setProposal({
						kind: 'open',
						draft,
						activity: { kind: 'unconfirmed', message: result.message },
					});
					break;
				case 'stale': {
					setLoad({
						kind: 'ready',
						snapshot: {
							...result.snapshot,
							visibleAssociations: filterAssociations(
								result.snapshot.associations,
								latestFilters.current,
							),
						},
					});
					const current = result.snapshot.associations.find(
						(row): boolean => row.id === draft.rowId,
					);
					// Keep the old revision if the target vanished; the host must refuse a retry.
					setProposal({
						kind: 'open',
						draft: current ? { ...draft, baseRevision: result.snapshot.revision, current } : draft,
						activity: { kind: 'failed', message: result.message },
					});
					break;
				}
				default:
					assertNever(result);
			}
		} catch (error) {
			setProposal({
				kind: 'open',
				draft,
				activity: { kind: 'unconfirmed', message: errorMessage(error) },
			});
		} finally {
			pendingWrite.current = false;
		}
	}
	async function denyProposal(): Promise<void> {
		if (
			proposal.kind !== 'open' ||
			pendingWrite.current ||
			proposal.activity.kind === 'unconfirmed'
		)
			return;
		pendingWrite.current = true;
		const draft = proposal.draft;
		setProposal({ ...proposal, activity: { kind: 'saving' } });
		try {
			await port.denyProposal(draft);
			proposalActive.current = false;
			setProposal({ kind: 'none' });
			setFeedback('Proposal denied. No settings changed.');
		} catch (error) {
			setProposal({
				kind: 'open',
				draft,
				activity: { kind: 'failed', message: errorMessage(error) },
			});
		} finally {
			pendingWrite.current = false;
		}
	}
	async function readCurrent(): Promise<void> {
		if (proposal.kind !== 'open' || pendingWrite.current) return;
		pendingWrite.current = true;
		const draft = proposal.draft;
		try {
			const snapshot = await port.read(filters);
			setLoad({ kind: 'ready', snapshot });
			const current = snapshot.associations.find((row): boolean => row.id === draft.rowId);
			setProposal({
				kind: 'open',
				draft: current ? { ...draft, baseRevision: snapshot.revision, current } : draft,
				activity: {
					kind: 'failed',
					message: 'Current state read. Review it before deciding again.',
				},
			});
		} catch (error) {
			setProposal({
				kind: 'open',
				draft,
				activity: { kind: 'unconfirmed', message: errorMessage(error) },
			});
		} finally {
			pendingWrite.current = false;
		}
	}
	return {
		retryProposal: (): void => {
			if (proposal.kind === 'failed') void propose(proposal.intent);
		},
		load,
		filters,
		destination,
		proposal,
		scan,
		feedback,
		setFilters: selectFilters,
		setDestination,
		submitRequest,
		proposeRow,
		editProposal,
		acceptProposal,
		denyProposal,
		readCurrent,
		showScan,
		retryRead: (): void => setReload((value): number => value + 1),
	};
}
