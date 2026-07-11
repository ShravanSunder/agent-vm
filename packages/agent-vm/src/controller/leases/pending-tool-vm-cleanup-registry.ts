import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import { assertVmDestructionComplete } from '../../shared/vm-destruction-receipt.js';
import type { ProvisionalToolVmOwnershipHandle } from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { AgentLeaseIdentity } from './agent-lease-operation-lock.js';

interface PendingDetachedToolVmCleanup extends AgentLeaseIdentity {
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly kind: 'detached';
	readonly ownership: ProvisionalToolVmOwnershipHandle;
	readonly tcpSlot: number;
}

interface PendingLiveToolVmCleanup extends AgentLeaseIdentity {
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly kind: 'live';
	readonly ownership: ProvisionalToolVmOwnershipHandle;
	readonly persistedRuntimeRecord?: {
		readonly recordId: string;
		readonly stateDirectory: string;
	};
	readonly tcpSlot: number;
	readonly vm: ManagedVm;
}

type PendingToolVmCleanup = PendingDetachedToolVmCleanup | PendingLiveToolVmCleanup;

export interface PendingToolVmCleanupRegistry {
	pendingCleanupIdentitiesForGateway(
		expectedGateway: GatewayEpochIdentity,
	): readonly AgentLeaseIdentity[];
	recordDetachedCleanup(cleanup: Omit<PendingDetachedToolVmCleanup, 'kind'>): void;
	recordLiveCleanup(cleanup: Omit<PendingLiveToolVmCleanup, 'kind'>): void;
	retry(agentIdentity: AgentLeaseIdentity): Promise<void>;
}

interface CreatePendingToolVmCleanupRegistryOptions {
	readonly deleteRuntimeRecord: (stateDirectory: string, recordId: string) => Promise<void>;
	readonly releaseTcpSlotAfterCompleteDestruction: (tcpSlot: number) => void;
	readonly writeWarning: (message: string) => void;
}

function agentIdentityKey(agentIdentity: AgentLeaseIdentity): string {
	return `${agentIdentity.zoneId}\0${agentIdentity.agentId}`;
}

function formatCleanupError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createPendingToolVmCleanupRegistry(
	options: CreatePendingToolVmCleanupRegistryOptions,
): PendingToolVmCleanupRegistry {
	const pendingCleanupByAgent = new Map<string, PendingToolVmCleanup>();

	const retry = async (agentIdentity: AgentLeaseIdentity): Promise<void> => {
		const identityKey = agentIdentityKey(agentIdentity);
		const pendingCleanup = pendingCleanupByAgent.get(identityKey);
		if (pendingCleanup === undefined) {
			return;
		}
		if (pendingCleanup.kind === 'detached') {
			const destroyReceipt = await pendingCleanup.ownership.destroyDetached();
			assertVmDestructionComplete(
				destroyReceipt,
				`Detached partially-created lease VM for zone '${agentIdentity.zoneId}' agent '${agentIdentity.agentId}'`,
			);
			pendingCleanupByAgent.delete(identityKey);
			options.releaseTcpSlotAfterCompleteDestruction(pendingCleanup.tcpSlot);
			return;
		}

		const destroyReceipt = await pendingCleanup.ownership.destroyLive(
			async () => await pendingCleanup.vm.close(),
		);
		assertVmDestructionComplete(
			destroyReceipt,
			`Partially-created lease VM for zone '${agentIdentity.zoneId}' agent '${agentIdentity.agentId}'`,
		);
		pendingCleanupByAgent.delete(identityKey);
		if (pendingCleanup.persistedRuntimeRecord !== undefined) {
			try {
				await options.deleteRuntimeRecord(
					pendingCleanup.persistedRuntimeRecord.stateDirectory,
					pendingCleanup.persistedRuntimeRecord.recordId,
				);
			} catch (deleteError) {
				options.writeWarning(
					`failed to delete recovered partial-create runtime record '${pendingCleanup.persistedRuntimeRecord.recordId}' in zone '${agentIdentity.zoneId}': ${formatCleanupError(deleteError)}`,
				);
			}
		}
		options.releaseTcpSlotAfterCompleteDestruction(pendingCleanup.tcpSlot);
	};

	return {
		pendingCleanupIdentitiesForGateway(expectedGateway): readonly AgentLeaseIdentity[] {
			const agentIdentities: AgentLeaseIdentity[] = [];
			for (const pendingCleanup of pendingCleanupByAgent.values()) {
				if (gatewayIdentitiesEqual(pendingCleanup.gatewayIdentity, expectedGateway)) {
					agentIdentities.push({
						agentId: pendingCleanup.agentId,
						zoneId: pendingCleanup.zoneId,
					});
				}
			}
			return agentIdentities;
		},
		recordDetachedCleanup(cleanup): void {
			pendingCleanupByAgent.set(agentIdentityKey(cleanup), { ...cleanup, kind: 'detached' });
		},
		recordLiveCleanup(cleanup): void {
			pendingCleanupByAgent.set(agentIdentityKey(cleanup), { ...cleanup, kind: 'live' });
		},
		retry,
	};
}
