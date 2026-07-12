import type { ManagedVm } from '@agent-vm/managed-vm';

import {
	createGatewayDestructionBudget,
	type GatewayDestructionBudget,
} from './gateway-destruction-budget.js';
import type {
	GatewayEpochSeedHandle,
	GatewayOwnershipCoordinator,
} from './gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity, GatewayEpochSeed } from './vm-ownership-contracts.js';

export interface GatewayVmLifecycleAuthority {
	readonly gatewaySeed: GatewayEpochSeed;
	readonly gatewayIdentity: GatewayEpochIdentity | undefined;
	attachGatewayVm(gatewayVmId: string): GatewayEpochIdentity;
	containPendingCreate(options: {
		readonly closeLateCreatedVm: (createdVm: ManagedVm) => Promise<void>;
		readonly pendingCreate: Promise<ManagedVm>;
	}): Promise<void>;
	destroyLive(destroyGatewayVm: () => Promise<void>): Promise<void>;
}

export function createGatewayVmLifecycleAuthority(options: {
	readonly bootId: string;
	readonly destructionBudget?: GatewayDestructionBudget;
	readonly destroyGatewayOwnedLeases: (
		gatewayIdentity: GatewayEpochIdentity,
		signal: AbortSignal,
	) => Promise<void>;
	readonly generationId: string;
	readonly ownershipCoordinator: GatewayOwnershipCoordinator;
	readonly zoneId: string;
}): GatewayVmLifecycleAuthority {
	const seedHandle: GatewayEpochSeedHandle = options.ownershipCoordinator.beginGatewayEpoch({
		bootId: options.bootId,
		generationId: options.generationId,
		zoneId: options.zoneId,
	});
	const destructionBudget = options.destructionBudget ?? createGatewayDestructionBudget();
	let currentGatewayIdentity: GatewayEpochIdentity | undefined;
	let pendingCreateContainment: Promise<void> | undefined;

	return {
		gatewaySeed: structuredClone(seedHandle.seed),
		get gatewayIdentity(): GatewayEpochIdentity | undefined {
			return currentGatewayIdentity === undefined
				? undefined
				: structuredClone(currentGatewayIdentity);
		},
		attachGatewayVm(gatewayVmId): GatewayEpochIdentity {
			const identity = seedHandle.attachGatewayVm(gatewayVmId);
			currentGatewayIdentity = identity;
			return structuredClone(identity);
		},
		containPendingCreate(containmentOptions): Promise<void> {
			pendingCreateContainment ??= containmentOptions.pendingCreate.then(async (createdVm) => {
				await containmentOptions.closeLateCreatedVm(createdVm);
			});
			return pendingCreateContainment;
		},
		async destroyLive(destroyGatewayVm): Promise<void> {
			const gatewayIdentity = currentGatewayIdentity;
			if (gatewayIdentity === undefined) {
				throw new Error(`Gateway VM lifecycle for zone '${options.zoneId}' is not attached.`);
			}
			const attempt = destructionBudget.createSubtreeAttempt();
			try {
				await attempt.runSubtree(async () => {
					const sealed = options.ownershipCoordinator.sealGatewayEpoch(gatewayIdentity);
					await options.destroyGatewayOwnedLeases(gatewayIdentity, attempt.signal);
					attempt.throwIfExpired('before Gateway child membership barrier');
					await sealed.barrier;
					attempt.throwIfExpired('before Gateway VM destruction');
					await attempt.runTarget(`gateway VM '${gatewayIdentity.gatewayVmId}'`, destroyGatewayVm);
					await options.ownershipCoordinator.retireGateway(gatewayIdentity);
				});
			} catch (error) {
				options.ownershipCoordinator.recordGatewayDestroyUnavailable(gatewayIdentity);
				throw error;
			}
		},
	};
}
