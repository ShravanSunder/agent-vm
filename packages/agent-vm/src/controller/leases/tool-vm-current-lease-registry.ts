import type { ProvisionalToolVmOwnershipHandle } from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { AgentLeaseIdentity } from './agent-lease-operation-lock.js';

interface CurrentToolVmLease<TLease extends AgentLeaseIdentity & { readonly id: string }> {
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly lease: TLease;
	readonly ownership: ProvisionalToolVmOwnershipHandle;
}

export interface ToolVmCurrentLeaseRegistry<
	TLease extends AgentLeaseIdentity & { readonly id: string; readonly lastUsedAt: number },
> {
	findByAgent(agentIdentity: AgentLeaseIdentity): TLease | undefined;
	forget(lease: TLease): void;
	get(leaseId: string): TLease | undefined;
	leaseIdsOwnedByGateway(expectedGateway: GatewayEpochIdentity): readonly string[];
	list(): readonly TLease[];
	recordCurrent(current: CurrentToolVmLease<TLease>): void;
	requireOwnership(leaseId: string): ProvisionalToolVmOwnershipHandle;
	resolveGatewayIdentity(leaseId: string): GatewayEpochIdentity | undefined;
	touch(lease: TLease, nowMs: number): TLease;
	values(): IterableIterator<TLease>;
}

function agentLeaseIndexKey(agentIdentity: AgentLeaseIdentity): string {
	return `${agentIdentity.zoneId}\0${agentIdentity.agentId}`;
}

export function createToolVmCurrentLeaseRegistry<
	TLease extends AgentLeaseIdentity & { readonly id: string; readonly lastUsedAt: number },
>(): ToolVmCurrentLeaseRegistry<TLease> {
	const currentByLeaseId = new Map<string, CurrentToolVmLease<TLease>>();
	const leaseIdsByAgent = new Map<string, string>();

	return {
		findByAgent(agentIdentity): TLease | undefined {
			const leaseId = leaseIdsByAgent.get(agentLeaseIndexKey(agentIdentity));
			return leaseId === undefined ? undefined : currentByLeaseId.get(leaseId)?.lease;
		},
		forget(lease): void {
			currentByLeaseId.delete(lease.id);
			const indexKey = agentLeaseIndexKey(lease);
			if (leaseIdsByAgent.get(indexKey) === lease.id) {
				leaseIdsByAgent.delete(indexKey);
			}
		},
		get(leaseId): TLease | undefined {
			return currentByLeaseId.get(leaseId)?.lease;
		},
		leaseIdsOwnedByGateway(expectedGateway): readonly string[] {
			return [...currentByLeaseId.entries()]
				.filter(([, current]) => gatewayIdentitiesEqual(current.gatewayIdentity, expectedGateway))
				.map(([leaseId]) => leaseId);
		},
		list(): readonly TLease[] {
			return [...currentByLeaseId.values()].map((current) => current.lease);
		},
		recordCurrent(current): void {
			currentByLeaseId.set(current.lease.id, {
				...current,
				gatewayIdentity: structuredClone(current.gatewayIdentity),
			});
			leaseIdsByAgent.set(agentLeaseIndexKey(current.lease), current.lease.id);
		},
		requireOwnership(leaseId): ProvisionalToolVmOwnershipHandle {
			const ownership = currentByLeaseId.get(leaseId)?.ownership;
			if (ownership === undefined) {
				throw new Error(`Lease '${leaseId}' is missing its Tool VM ownership handle.`);
			}
			return ownership;
		},
		resolveGatewayIdentity(leaseId): GatewayEpochIdentity | undefined {
			const gatewayIdentity = currentByLeaseId.get(leaseId)?.gatewayIdentity;
			return gatewayIdentity === undefined ? undefined : structuredClone(gatewayIdentity);
		},
		touch(lease, nowMs): TLease {
			const current = currentByLeaseId.get(lease.id);
			if (current === undefined) {
				throw new Error(`Lease '${lease.id}' is not current.`);
			}
			const touchedLease = { ...lease, lastUsedAt: nowMs };
			currentByLeaseId.set(lease.id, { ...current, lease: touchedLease });
			return touchedLease;
		},
		values(): IterableIterator<TLease> {
			return [...currentByLeaseId.values()].map((current) => current.lease).values();
		},
	};
}
