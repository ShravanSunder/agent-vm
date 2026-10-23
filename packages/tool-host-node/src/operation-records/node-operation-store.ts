import { randomUUID } from 'node:crypto';

import {
	operationRecordSchema,
	type OperationKey,
	type OperationPort,
	type OperationRecord,
	type OperationCreateResult,
	type OperationLookupResult,
} from '@agent-collaboration/tool-engine/capability-dispatch';

export interface NodeOperationStore extends OperationPort {
	readonly close: () => Promise<void>;
}

function operationRecordId(key: OperationKey): string {
	return JSON.stringify([key.authority, key.principal, key.item]);
}

function transitionIsAllowed(
	current: OperationRecord['state'],
	next: OperationRecord['state'],
): boolean {
	switch (current.kind) {
		case 'ready':
			return next.kind === 'armed' || next.kind === 'pending';
		case 'pending':
			return next.kind === 'armed';
		case 'armed':
			return next.kind === 'completed' || next.kind === 'ambiguous';
		case 'completed':
			return next.kind === 'result-expired';
		case 'ambiguous':
		case 'result-expired':
			return false;
		default:
			return assertNever(current);
	}
}

function assertNever(value: never): never {
	void value;
	throw new Error('Unsupported operation state.');
}

/** Approval entries last for this host process only; unprotected calls are not recorded. */
export async function openNodeOperationStore(props: {
	readonly directory: string;
	readonly authority: string;
	readonly authorize: (key: OperationKey, verifiedContextRef: string) => boolean;
	readonly now?: () => number;
}): Promise<NodeOperationStore> {
	const records = new Map<string, OperationRecord>();
	const now = props.now ?? Date.now;
	let closed = false;
	function admitted(key: OperationKey, contextRef: string): boolean {
		return !closed && key.authority === props.authority && props.authorize(key, contextRef);
	}
	return {
		createOrRead: async ({ invocation, requiresApproval }): Promise<OperationCreateResult> => {
			if (!admitted(invocation.operationKey, invocation.verifiedContextRef))
				return { kind: 'denied' };
			if (!requiresApproval) return { kind: 'untracked' };
			const identifier = operationRecordId(invocation.operationKey);
			const current = records.get(identifier);
			if (current !== undefined)
				return current.intentDigest === invocation.intentDigest
					? { kind: 'existing', record: current }
					: { kind: 'conflict' };
			const timestamp = new Date(now()).toISOString();
			const record = operationRecordSchema.parse({
				version: 'tool-operation-v1',
				key: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				createdAt: timestamp,
				updatedAt: timestamp,
				revision: randomUUID(),
				state: { kind: 'ready' },
			});
			records.set(identifier, record);
			return { kind: 'created', record };
		},
		lookup: async (request): Promise<OperationLookupResult> => {
			if (request.version !== 'tool-operation-v1') return { kind: 'unsupported-version' };
			if (!admitted(request.key, request.verifiedContextRef)) return { kind: 'denied' };
			const record = records.get(operationRecordId(request.key));
			return record === undefined ? { kind: 'not-found' } : { kind: 'found', record };
		},
		transition: async ({ invocation, expectedRevision, next }): Promise<OperationLookupResult> => {
			if (!admitted(invocation.operationKey, invocation.verifiedContextRef))
				return { kind: 'denied' };
			const identifier = operationRecordId(invocation.operationKey);
			const current = records.get(identifier);
			if (current === undefined) return { kind: 'not-found' };
			if (
				current.intentDigest !== invocation.intentDigest ||
				current.revision !== expectedRevision ||
				!transitionIsAllowed(current.state, next)
			)
				return { kind: 'conflict' };
			const record = operationRecordSchema.parse({
				...current,
				revision: randomUUID(),
				updatedAt: new Date(now()).toISOString(),
				state: next,
			});
			records.set(identifier, record);
			return { kind: 'found', record };
		},
		close: async (): Promise<void> => {
			closed = true;
			records.clear();
		},
	};
}
