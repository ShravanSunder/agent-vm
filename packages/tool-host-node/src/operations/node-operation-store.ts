import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
	operationRecordSchema,
	type OperationKey,
	type OperationPort,
	type OperationRecord,
	type OperationCreateResult,
	type OperationLookupResult,
} from '@agent-collaboration/tool-engine/dispatch';

import { createCrashDurableRecordStore } from '#node-host/operations/crash-durable-record-store';
import { acquireNodeStoreOwnershipLock } from '#node-host/operations/node-store-ownership-lock';

export interface NodeOperationStore extends OperationPort {
	readonly close: () => Promise<void>;
}

function operationRecordId(key: OperationKey): string {
	return createHash('sha256')
		.update(JSON.stringify([key.authority, key.principal, key.item]))
		.digest('hex');
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
	}
}

/** One fenced writer owns durable records; callers receive only currently authorized records. */
export async function openNodeOperationStore(props: {
	readonly directory: string;
	readonly authority: string;
	readonly authorize: (key: OperationKey, verifiedContextRef: string) => boolean;
	readonly now?: () => number;
}): Promise<NodeOperationStore> {
	const ownership = await acquireNodeStoreOwnershipLock({ runtimeDirectory: props.directory });
	const records = createCrashDurableRecordStore({
		recordSchema: operationRecordSchema,
		recordsDirectoryPath: path.join(props.directory, 'tool-operations-v1'),
	});
	const now = props.now ?? Date.now;
	let closed = false;
	const activeMutations = new Set<Promise<unknown>>();
	function admitted(key: OperationKey, contextRef: string): boolean {
		return !closed && key.authority === props.authority && props.authorize(key, contextRef);
	}
	async function tracked<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		const pending = operation();
		activeMutations.add(pending);
		try {
			return await pending;
		} finally {
			activeMutations.delete(pending);
		}
	}
	return {
		createOrRead: async ({ invocation }): Promise<OperationCreateResult> => {
			if (!admitted(invocation.operationKey, invocation.verifiedContextRef))
				return { kind: 'denied' };
			try {
				return await tracked(async () =>
					records.mutateRecord<OperationCreateResult>(
						operationRecordId(invocation.operationKey),
						(current) => {
							if (current !== null)
								return {
									nextRecord: current,
									result:
										current.intentDigest === invocation.intentDigest
											? { kind: 'existing', record: current }
											: { kind: 'conflict' },
								};
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
							return { nextRecord: record, result: { kind: 'created', record } };
						},
					),
				);
			} catch {
				return { kind: 'unavailable' };
			}
		},
		lookup: async (request): Promise<OperationLookupResult> => {
			if (request.version !== 'tool-operation-v1') return { kind: 'unsupported-version' };
			if (!admitted(request.key, request.verifiedContextRef)) return { kind: 'denied' };
			try {
				const record = await records.loadRecord(operationRecordId(request.key));
				return record === null ? { kind: 'not-found' } : { kind: 'found', record };
			} catch {
				return { kind: 'unavailable' };
			}
		},
		transition: async ({ invocation, expectedRevision, next }): Promise<OperationLookupResult> => {
			if (!admitted(invocation.operationKey, invocation.verifiedContextRef))
				return { kind: 'denied' };
			try {
				return await tracked(async () =>
					records.mutateRecord<OperationLookupResult>(
						operationRecordId(invocation.operationKey),
						(current) => {
							if (current === null) return { nextRecord: null, result: { kind: 'not-found' } };
							if (
								current.intentDigest !== invocation.intentDigest ||
								current.revision !== expectedRevision ||
								!transitionIsAllowed(current.state, next)
							)
								return { nextRecord: current, result: { kind: 'conflict' } };
							const record = operationRecordSchema.parse({
								...current,
								revision: randomUUID(),
								updatedAt: new Date(now()).toISOString(),
								state: next,
							});
							return { nextRecord: record, result: { kind: 'found', record } };
						},
					),
				);
			} catch {
				return { kind: 'unavailable' };
			}
		},
		close: async (): Promise<void> => {
			closed = true;
			await Promise.allSettled(activeMutations);
			await ownership.release();
		},
	};
}
