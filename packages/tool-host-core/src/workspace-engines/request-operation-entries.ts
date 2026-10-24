import type {
	OperationPort,
	OperationRecord,
} from '@agent-collaboration/tool-engine/capability-dispatch';

import type { Clock } from '#tool-host-core/workspace-authority/models/authority-clock';

/** Protected calls keep their dispatcher receipt entries only for this request. The DO owns replay. */
export function createRequestOperationEntries(clock: Clock): OperationPort {
	const records = new Map<string, OperationRecord>();
	return {
		createOrRead: async ({ invocation, requiresApproval }) => {
			if (!requiresApproval) return { kind: 'untracked' };
			const key = JSON.stringify(invocation.operationKey);
			const existing = records.get(key);
			if (existing !== undefined)
				return existing.intentDigest === invocation.intentDigest
					? { kind: 'existing', record: existing }
					: { kind: 'conflict' };
			const timestamp = clock.nowIso();
			const record: OperationRecord = {
				version: 'tool-operation-v1',
				key: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				createdAt: timestamp,
				updatedAt: timestamp,
				revision: '1',
				state: { kind: 'ready' },
			};
			records.set(key, record);
			return { kind: 'created', record };
		},
		lookup: async () => ({ kind: 'not-found' }),
		transition: async ({ invocation, expectedRevision, next }) => {
			const key = JSON.stringify(invocation.operationKey);
			const previous = records.get(key);
			if (previous === undefined || previous.revision !== expectedRevision)
				return { kind: 'conflict' };
			const record = { ...previous, revision: String(Number(previous.revision) + 1), state: next };
			records.set(key, record);
			return { kind: 'found', record };
		},
	};
}
