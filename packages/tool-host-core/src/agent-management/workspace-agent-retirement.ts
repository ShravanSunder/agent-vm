import {
	disableResultSchema,
	type AgentClientManagementPort,
	type ManagementFailure,
} from '#tool-host-core/agent-management/agent-client-management-port';
import type {
	AgentManagementAuthority,
	AgentRemoval,
} from '#tool-host-core/workspace-authority/agent-retirement';

export type RemovalOutcome =
	| { readonly kind: 'complete' }
	| { readonly kind: 'pending' }
	| Extract<ManagementFailure, { readonly kind: 'refused' }>;
interface ClientScope {
	readonly token: string;
	readonly organizationId: string;
	readonly clientId: string;
}
interface WorkspaceRemoval {
	readonly workspaceId: string;
	readonly removal: AgentRemoval;
}

/** Reconciles one client's retirement across independently committed workspace records. */
export function createWorkspaceAgentRetirement(props: {
	readonly signIn: AgentClientManagementPort;
	readonly workspaces: { readonly forWorkspace: (workspaceId: string) => AgentManagementAuthority };
}): {
	readonly resume: (
		scope: ClientScope,
		workspaceIds: readonly string[],
		freshRequestId?: string,
	) => Promise<RemovalOutcome | null>;
} {
	async function observeDisable(scope: ClientScope, requestId: string): Promise<RemovalOutcome> {
		try {
			const parsed = disableResultSchema.safeParse(
				await props.signIn.disable({ ...scope, requestId }),
			);
			if (!parsed.success) return { kind: 'pending' };
			if (parsed.data.kind === 'refused') return parsed.data;
			return parsed.data.kind === 'disabled' && parsed.data.clientId === scope.clientId
				? { kind: 'complete' }
				: { kind: 'pending' };
		} catch {
			return { kind: 'pending' };
		}
	}
	async function readRecords(
		scope: ClientScope,
		workspaceIds: readonly string[],
	): Promise<readonly WorkspaceRemoval[]> {
		return Promise.all(
			workspaceIds.map(async (workspaceId): Promise<WorkspaceRemoval> => {
				const authority = props.workspaces.forWorkspace(workspaceId);
				const removal = await authority.readAgentRemoval(scope.clientId);
				if (
					removal?.operation !== 'disable' ||
					(await authority.readMembership(scope.clientId)) !== null
				)
					throw new Error('Workspace retirement readback incomplete');
				return { workspaceId, removal };
			}),
		);
	}
	async function completeRecords(
		scope: ClientScope,
		records: readonly WorkspaceRemoval[],
		requestId: string,
	): Promise<void> {
		const completions = await Promise.allSettled(
			records.map(async ({ workspaceId, removal }): Promise<void> => {
				if (removal.kind === 'complete' || removal.requestId !== requestId) return;
				await props.workspaces
					.forWorkspace(workspaceId)
					.completeAgentRemoval(scope.clientId, requestId, 'disable');
			}),
		);
		if (completions.some((result) => result.status === 'rejected'))
			throw new Error('Workspace retirement completion incomplete');
	}
	async function replaceRecords(
		scope: ClientScope,
		records: readonly WorkspaceRemoval[],
		requestId: string,
	): Promise<void> {
		// Each swap is guarded by the exact observed record. A partial swap is reconciled on retry.
		const replacements = await Promise.allSettled(
			records.map(async ({ workspaceId, removal }): Promise<void> => {
				if (removal.kind === 'complete' || removal.requestId === requestId) return;
				await props.workspaces
					.forWorkspace(workspaceId)
					.beginAgentRemoval(scope.clientId, requestId, {
						operation: 'disable',
						replacesPendingRequestId: removal.requestId,
					});
			}),
		);
		if (replacements.some((result) => result.status === 'rejected'))
			throw new Error('Workspace retirement replacement incomplete');
	}
	async function completeWinningOperation(
		scope: ClientScope,
		records: readonly WorkspaceRemoval[],
		requestId: string,
	): Promise<RemovalOutcome> {
		const workspaceIds = records.map(({ workspaceId }) => workspaceId);
		await replaceRecords(scope, records, requestId);
		await completeRecords(scope, await readRecords(scope, workspaceIds), requestId);
		const completed = await readRecords(scope, workspaceIds);
		if (!completed.every(({ removal }) => removal.kind === 'complete'))
			throw new Error('Retirement readback incomplete');
		return { kind: 'complete' };
	}
	return {
		async resume(scope, workspaceIds, freshRequestId): Promise<RemovalOutcome | null> {
			const previous = await Promise.all(
				workspaceIds.map((workspaceId) =>
					props.workspaces.forWorkspace(workspaceId).readAgentRemoval(scope.clientId),
				),
			);
			const existing = previous.find((removal) => removal?.operation === 'disable');
			const anchorId = existing?.requestId ?? freshRequestId;
			if (anchorId === undefined) return null;
			const removals = await Promise.allSettled(
				workspaceIds.map(async (workspaceId, index): Promise<void> => {
					const authority = props.workspaces.forWorkspace(workspaceId);
					const recorded = previous[index];
					await authority.beginAgentRemoval(
						scope.clientId,
						recorded?.operation === 'disable' ? recorded.requestId : anchorId,
						{ operation: 'disable' },
					);
					if ((await authority.readMembership(scope.clientId)) !== null)
						throw new Error('Membership removal readback incomplete');
				}),
			);
			if (removals.some((result) => result.status === 'rejected'))
				throw new Error('Workspace retirement removal incomplete');
			let records = await readRecords(scope, workspaceIds);
			if (records.every(({ removal }) => removal.kind === 'complete')) return { kind: 'complete' };
			// Complete records already hold a disabled-client readback and are never reopened.
			let winningId = records.find(({ removal }) => removal.kind === 'complete')?.removal.requestId;
			const pendingIds = [
				...new Set(
					records
						.filter(({ removal }) => removal.kind === 'pending')
						.map(({ removal }) => removal.requestId),
				),
			];
			const outcomes = new Map<string, RemovalOutcome>();
			const observations = await Promise.all(
				pendingIds
					.filter((requestId) => requestId !== freshRequestId)
					.map(async (requestId) => ({
						requestId,
						outcome: await observeDisable(scope, requestId),
					})),
			);
			for (const { requestId, outcome } of observations) {
				outcomes.set(requestId, outcome);
				if (outcome.kind === 'complete') winningId ??= requestId;
			}
			if (freshRequestId !== undefined) {
				if (winningId !== undefined) return completeWinningOperation(scope, records, winningId);
				if ([...outcomes.values()].some((outcome) => outcome.kind === 'pending'))
					return { kind: 'pending' };
				await replaceRecords(scope, records, freshRequestId);
				const outcome = await observeDisable(scope, freshRequestId);
				if (outcome.kind !== 'complete') return outcome;
				return completeWinningOperation(
					scope,
					await readRecords(scope, workspaceIds),
					freshRequestId,
				);
			}
			// Status/add requests may finish a recorded id, but never replace one.
			const completions = await Promise.allSettled(
				[...outcomes]
					.filter(([, outcome]) => outcome.kind === 'complete')
					.map(([requestId]) => completeRecords(scope, records, requestId)),
			);
			if (completions.some((result) => result.status === 'rejected'))
				throw new Error('Workspace retirement status completion incomplete');
			records = await readRecords(scope, workspaceIds);
			if (records.every(({ removal }) => removal.kind === 'complete')) return { kind: 'complete' };
			if (winningId === undefined) {
				const refused = [...outcomes.values()].find((outcome) => outcome.kind === 'refused');
				if (refused !== undefined) return refused;
			}
			return { kind: 'pending' };
		},
	};
}
