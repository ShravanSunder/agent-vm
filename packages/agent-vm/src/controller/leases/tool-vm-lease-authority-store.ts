import { defaultToolVmLeaseAuthorityTombstoneTtlMs } from '@agent-vm/gateway-interface';

export type ToolVmLeaseAuthorityState = 'current' | 'replaced' | 'retired';

export interface ToolVmLeaseStableOwner {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly peerId: string;
	readonly purpose: string;
	readonly sessionKeyDigest: string;
	readonly workMountDir: string;
	readonly zoneId: string;
}

export interface ToolVmLeaseAuthorityRecord<TCompatibility> {
	readonly compatibility: TCompatibility;
	readonly expiresAtMs?: number;
	readonly leaseId: string;
	readonly owner: ToolVmLeaseStableOwner;
	readonly replacementLeaseId?: string;
	readonly state: ToolVmLeaseAuthorityState;
}

export interface ToolVmLeaseAuthorityStore<TCompatibility> {
	markReplaced(oldLeaseId: string, replacementLeaseId: string): void;
	markRetired(leaseId: string): void;
	recordCurrent(record: {
		readonly compatibility: TCompatibility;
		readonly leaseId: string;
		readonly owner: ToolVmLeaseStableOwner;
	}): void;
	resolve(leaseId: string): ToolVmLeaseAuthorityRecord<TCompatibility> | undefined;
}

export interface ToolVmLeaseAuthorityStoreOptions {
	readonly now?: () => number;
	readonly tombstoneTtlMs?: number;
}

export function createToolVmLeaseAuthorityStore<TCompatibility>(
	options: ToolVmLeaseAuthorityStoreOptions = {},
): ToolVmLeaseAuthorityStore<TCompatibility> {
	const recordsByLeaseId = new Map<string, ToolVmLeaseAuthorityRecord<TCompatibility>>();
	const now = options.now ?? (() => Date.now());
	const tombstoneTtlMs = options.tombstoneTtlMs ?? defaultToolVmLeaseAuthorityTombstoneTtlMs;

	function tombstoneExpiresAtMs(): number {
		return now() + tombstoneTtlMs;
	}

	function resolveLiveRecord(
		leaseId: string,
	): ToolVmLeaseAuthorityRecord<TCompatibility> | undefined {
		const record = recordsByLeaseId.get(leaseId);
		if (record?.expiresAtMs !== undefined && record.expiresAtMs < now()) {
			recordsByLeaseId.delete(leaseId);
			return undefined;
		}
		return record;
	}

	return {
		markReplaced: (oldLeaseId, replacementLeaseId) => {
			const record = resolveLiveRecord(oldLeaseId);
			if (record === undefined) {
				return;
			}
			recordsByLeaseId.set(oldLeaseId, {
				...record,
				expiresAtMs: tombstoneExpiresAtMs(),
				replacementLeaseId,
				state: 'replaced',
			});
		},
		markRetired: (leaseId) => {
			const record = resolveLiveRecord(leaseId);
			if (record === undefined) {
				return;
			}
			recordsByLeaseId.set(leaseId, {
				...record,
				expiresAtMs: tombstoneExpiresAtMs(),
				state: record.state === 'replaced' ? 'replaced' : 'retired',
			});
		},
		recordCurrent: (record) => {
			recordsByLeaseId.set(record.leaseId, {
				...record,
				state: 'current',
			});
		},
		resolve: resolveLiveRecord,
	};
}
