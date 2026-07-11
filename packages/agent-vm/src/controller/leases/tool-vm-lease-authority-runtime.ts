import { assertVmDestroyReceiptMatchesTarget } from '../../shared/vm-destruction-receipt.js';
import type { ToolVmProvisionalOwnershipProof } from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import {
	RejectedToolVmProvisioningCleanupError,
	type ToolVmLeaseAuthorityRuntime,
	type ToolVmLeaseRuntimeResource,
	type ToolVmRuntimeLeaseIdentity,
} from './tool-vm-lease-authority-runtime-contracts.js';
import {
	assertDestroyTargetMatchesAuthority,
	assertLeaseMatchesRuntime,
	authorityResourceKey,
	commitIdentity,
	gatewayAuthorityKey,
	rejectedCleanupId,
} from './tool-vm-lease-authority-runtime-identity.js';
import { requireLiveLeaf, stablePrincipalKey } from './tool-vm-lease-authority-state-helpers.js';
import {
	createEmptyToolVmLeaseAuthorityState,
	reduceToolVmLeaseAuthorityState,
	ToolVmLeaseAuthorityTransitionError,
	type ToolVmLeafAuthorityReference,
	type ToolVmLeaseAuthorityRetentionPolicy,
	type ToolVmLeaseAuthorityState,
} from './tool-vm-lease-authority-state.js';

export {
	RejectedToolVmProvisioningCleanupError,
	type ToolVmLeaseAuthorityRuntime,
	type ToolVmLeaseRuntimeResource,
	type ToolVmRuntimeLeaseIdentity,
} from './tool-vm-lease-authority-runtime-contracts.js';

interface MutableToolVmLeaseRuntimeResource<
	TLease extends ToolVmRuntimeLeaseIdentity,
> extends ToolVmLeaseRuntimeResource<TLease> {
	commitDisposition: 'complete' | 'failed' | 'in-flight' | 'not-started';
	commitIdentity?: string;
	commitInFlight?: Promise<void>;
	commitLease?: TLease;
	destructionInFlight?: Promise<ToolVmLeaseRuntimeResource<TLease>>;
	lease?: TLease;
}

interface RejectedToolVmProvisioningCleanupResource<
	TLease extends ToolVmRuntimeLeaseIdentity,
> extends ToolVmLeaseRuntimeResource<TLease> {
	destructionInFlight?: Promise<ToolVmLeaseRuntimeResource<TLease>>;
}

export function createToolVmLeaseAuthorityRuntime<TLease extends ToolVmRuntimeLeaseIdentity>(
	options: {
		readonly retentionPolicy?: Partial<ToolVmLeaseAuthorityRetentionPolicy>;
	} = {},
): ToolVmLeaseAuthorityRuntime<TLease> {
	const authorityStatesByGateway = new Map<string, ToolVmLeaseAuthorityState>();
	const resourcesByAuthority = new Map<string, MutableToolVmLeaseRuntimeResource<TLease>>();
	const rejectedCleanupResourcesByAuthority = new Map<
		string,
		RejectedToolVmProvisioningCleanupResource<TLease>
	>();
	const authorityResourceKeysByLeaseId = new Map<string, string>();
	const reservedDestructionTombstonesByGateway = new Map<string, Set<string>>();

	function requireAuthorityState(gateway: GatewayEpochIdentity): ToolVmLeaseAuthorityState {
		const state = authorityStatesByGateway.get(gatewayAuthorityKey(gateway));
		if (state === undefined) {
			throw new ToolVmLeaseAuthorityTransitionError(
				'parent-unregistered',
				'Gateway parent is not registered.',
			);
		}
		return state;
	}

	function replaceAuthorityState(
		gateway: GatewayEpochIdentity,
		state: ToolVmLeaseAuthorityState,
	): void {
		authorityStatesByGateway.set(gatewayAuthorityKey(gateway), state);
	}

	function requireResource(
		authority: ToolVmLeafAuthorityReference,
	): MutableToolVmLeaseRuntimeResource<TLease> {
		const resource = resourcesByAuthority.get(authorityResourceKey(authority));
		if (resource === undefined) {
			throw new Error(
				`Tool VM leaf generation '${authority.leafGeneration}' has no runtime resource.`,
			);
		}
		if (
			resource.authority.leaseId !== authority.leaseId ||
			!gatewayIdentitiesEqual(resource.authority.gateway, authority.gateway) ||
			stablePrincipalKey(resource.authority.principal) !== stablePrincipalKey(authority.principal)
		) {
			throw new Error('Tool VM runtime resource does not match the requested leaf authority.');
		}
		return resource;
	}

	function committedLeaseForResource(
		resource: MutableToolVmLeaseRuntimeResource<TLease>,
	): TLease | undefined {
		const state = requireAuthorityState(resource.authority.gateway);
		const leaf = state.leavesByPrincipal.get(stablePrincipalKey(resource.authority.principal));
		return leaf?.kind === 'current' && leaf.leafGeneration === resource.authority.leafGeneration
			? resource.lease
			: undefined;
	}

	function leaseIdsForGateway(gateway: GatewayEpochIdentity): readonly string[] {
		const gatewayKey = gatewayAuthorityKey(gateway);
		return [...resourcesByAuthority.values()]
			.filter((resource) => gatewayAuthorityKey(resource.authority.gateway) === gatewayKey)
			.map((resource) => resource.authority.leaseId);
	}

	function rejectedCleanupIdsForGateway(gateway: GatewayEpochIdentity): readonly string[] {
		const gatewayKey = gatewayAuthorityKey(gateway);
		return [...rejectedCleanupResourcesByAuthority.entries()]
			.filter(([, resource]) => gatewayAuthorityKey(resource.authority.gateway) === gatewayKey)
			.map(([cleanupId]) => cleanupId);
	}

	function reserveDestructionTombstone(
		state: ToolVmLeaseAuthorityState,
		authority: ToolVmLeafAuthorityReference,
	): void {
		const gatewayKey = gatewayAuthorityKey(authority.gateway);
		const resourceKey = authorityResourceKey(authority);
		const reserved = reservedDestructionTombstonesByGateway.get(gatewayKey) ?? new Set<string>();
		if (reserved.has(resourceKey)) {
			return;
		}
		if (
			!state.tombstonesByGeneration.has(authority.leafGeneration) &&
			state.tombstonesByGeneration.size + reserved.size >= state.retentionPolicy.maxLeafTombstones
		) {
			throw new ToolVmLeaseAuthorityTransitionError(
				'tombstone-capacity-exhausted',
				'Tool VM leaf tombstone capacity is exhausted before exact destruction.',
			);
		}
		reserved.add(resourceKey);
		reservedDestructionTombstonesByGateway.set(gatewayKey, reserved);
	}

	function releaseDestructionTombstone(authority: ToolVmLeafAuthorityReference): void {
		const gatewayKey = gatewayAuthorityKey(authority.gateway);
		const reserved = reservedDestructionTombstonesByGateway.get(gatewayKey);
		if (reserved === undefined) {
			return;
		}
		reserved.delete(authorityResourceKey(authority));
		if (reserved.size === 0) {
			reservedDestructionTombstonesByGateway.delete(gatewayKey);
		}
	}

	function recordDestructionIncomplete(
		authority: ToolVmLeafAuthorityReference,
		reason: string,
	): void {
		const state = requireAuthorityState(authority.gateway);
		const leaf = requireLiveLeaf(state, authority);
		if (leaf.kind !== 'destroying') {
			return;
		}
		replaceAuthorityState(
			authority.gateway,
			reduceToolVmLeaseAuthorityState(state, {
				authority,
				kind: 'destruction-incomplete',
				reason,
			}),
		);
	}

	return {
		applyAuthorityCommand(command): void {
			if (command.kind === 'prune-tombstones') {
				for (const [gatewayKey, state] of authorityStatesByGateway.entries()) {
					const prunedState = reduceToolVmLeaseAuthorityState(state, command);
					const canEvictRetiredState =
						prunedState.parent.kind === 'retired' &&
						prunedState.leavesByPrincipal.size === 0 &&
						prunedState.terminalUseTombstones.size === 0 &&
						prunedState.tombstonesByGeneration.size === 0 &&
						leaseIdsForGateway(prunedState.parent.gateway).length === 0 &&
						rejectedCleanupIdsForGateway(prunedState.parent.gateway).length === 0 &&
						(reservedDestructionTombstonesByGateway.get(gatewayKey)?.size ?? 0) === 0;
					if (canEvictRetiredState) {
						authorityStatesByGateway.delete(gatewayKey);
					} else {
						authorityStatesByGateway.set(gatewayKey, prunedState);
					}
				}
				return;
			}
			const gateway = 'authority' in command ? command.authority.gateway : command.gateway;
			replaceAuthorityState(
				gateway,
				reduceToolVmLeaseAuthorityState(requireAuthorityState(gateway), command),
			);
		},
		async beginProvisioning(beginOptions): Promise<ToolVmProvisionalOwnershipProof> {
			const ownershipProof = await beginOptions.ownership.ready;
			const resourceKey = authorityResourceKey(beginOptions.authority);
			let state: ToolVmLeaseAuthorityState;
			try {
				assertDestroyTargetMatchesAuthority({
					authority: beginOptions.authority,
					ownershipProof,
				});
				state = reduceToolVmLeaseAuthorityState(
					requireAuthorityState(beginOptions.authority.gateway),
					{
						authority: beginOptions.authority,
						compatibility: beginOptions.compatibility,
						destructionIdentity: ownershipProof.destructionIdentity,
						idleExpiresAtMs: beginOptions.idleExpiresAtMs,
						kind: 'begin-provisioning',
					},
				);
				if (
					resourcesByAuthority.has(resourceKey) ||
					authorityResourceKeysByLeaseId.has(beginOptions.authority.leaseId)
				) {
					throw new Error('Tool VM lease authority already has a retained runtime resource.');
				}
			} catch (authorityError) {
				try {
					const receipt = await beginOptions.ownership.destroyDetached();
					assertVmDestroyReceiptMatchesTarget(
						receipt,
						ownershipProof.verifiedDestroyTarget,
						`Rejected Tool VM leaf '${beginOptions.authority.leafGeneration}' cleanup receipt`,
					);
				} catch (cleanupError) {
					const cleanupId = rejectedCleanupId({
						authority: beginOptions.authority,
						ownershipProof,
					});
					rejectedCleanupResourcesByAuthority.set(cleanupId, {
						authority: structuredClone(beginOptions.authority),
						ownership: beginOptions.ownership,
						ownershipProof: structuredClone(ownershipProof),
					});
					throw new RejectedToolVmProvisioningCleanupError(cleanupId, authorityError, cleanupError);
				}
				throw authorityError;
			}
			replaceAuthorityState(beginOptions.authority.gateway, state);
			resourcesByAuthority.set(resourceKey, {
				authority: structuredClone(beginOptions.authority),
				commitDisposition: 'not-started',
				ownership: beginOptions.ownership,
				ownershipProof: structuredClone(ownershipProof),
			});
			authorityResourceKeysByLeaseId.set(beginOptions.authority.leaseId, resourceKey);
			return structuredClone(ownershipProof);
		},
		async commitCurrent(commitOptions): Promise<void> {
			const resource = requireResource(commitOptions.authority);
			assertLeaseMatchesRuntime({
				authority: commitOptions.authority,
				lease: commitOptions.lease,
				runtimeBinding: commitOptions.runtimeBinding,
				verifiedDestroyTarget: resource.ownershipProof.verifiedDestroyTarget,
			});
			const requestedCommitIdentity = commitIdentity(commitOptions);
			if (resource.commitLease !== undefined && resource.commitLease !== commitOptions.lease) {
				throw new Error('Tool VM current-commit retry changed the exact lease projection.');
			}
			if (
				resource.commitIdentity !== undefined &&
				resource.commitIdentity !== requestedCommitIdentity
			) {
				throw new Error('Tool VM current-commit retry changed lease or binding identity.');
			}
			if (resource.commitInFlight !== undefined) {
				return await resource.commitInFlight;
			}
			if (resource.commitDisposition === 'failed') {
				throw new Error('Tool VM ownership commit is uncertain and requires exact destruction.');
			}
			if (resource.commitDisposition === 'complete') {
				return;
			}
			reduceToolVmLeaseAuthorityState(requireAuthorityState(commitOptions.authority.gateway), {
				authority: commitOptions.authority,
				kind: 'commit-current',
				runtimeBinding: commitOptions.runtimeBinding,
				sshBinding: commitOptions.sshBinding,
			});
			resource.lease = commitOptions.lease;
			resource.commitIdentity = requestedCommitIdentity;
			resource.commitLease = commitOptions.lease;
			resource.commitDisposition = 'in-flight';
			const commit = (async (): Promise<void> => {
				try {
					await resource.ownership.commitCurrent();
					const state = reduceToolVmLeaseAuthorityState(
						requireAuthorityState(commitOptions.authority.gateway),
						{
							authority: commitOptions.authority,
							kind: 'commit-current',
							runtimeBinding: commitOptions.runtimeBinding,
							sshBinding: commitOptions.sshBinding,
						},
					);
					replaceAuthorityState(commitOptions.authority.gateway, state);
					resource.commitDisposition = 'complete';
				} catch (error) {
					resource.commitDisposition = 'failed';
					throw error;
				} finally {
					delete resource.commitInFlight;
				}
			})();
			resource.commitInFlight = commit;
			return await commit;
		},
		destroyExact(destroyOptions): Promise<ToolVmLeaseRuntimeResource<TLease>> {
			const resource = requireResource(destroyOptions.authority);
			if (resource.destructionInFlight !== undefined) {
				return resource.destructionInFlight;
			}
			if (resource.commitInFlight !== undefined) {
				const destructionAfterCommit = resource.commitInFlight
					.catch(() => undefined)
					.then(async () => {
						delete resource.destructionInFlight;
						return await this.destroyExact(destroyOptions);
					});
				resource.destructionInFlight = destructionAfterCommit;
				return destructionAfterCommit;
			}
			const currentState = requireAuthorityState(destroyOptions.authority.gateway);
			const currentLeaf = requireLiveLeaf(currentState, destroyOptions.authority);
			const destructionState = reduceToolVmLeaseAuthorityState(
				currentState,
				currentLeaf.kind === 'owner-unsafe'
					? {
							authority: destroyOptions.authority,
							kind: 'retry-destruction',
							reason: destroyOptions.reason,
						}
					: {
							authority: destroyOptions.authority,
							kind: 'begin-destruction',
							reason: destroyOptions.reason,
						},
			);
			reserveDestructionTombstone(currentState, destroyOptions.authority);
			replaceAuthorityState(destroyOptions.authority.gateway, destructionState);
			const destruction = (async (): Promise<ToolVmLeaseRuntimeResource<TLease>> => {
				try {
					const receipt =
						destroyOptions.mode.kind === 'detached'
							? await resource.ownership.destroyDetached()
							: await resource.ownership.destroyLive(destroyOptions.mode.closeLiveVm);
					assertVmDestroyReceiptMatchesTarget(
						receipt,
						resource.ownershipProof.verifiedDestroyTarget,
						`Tool VM leaf '${destroyOptions.authority.leafGeneration}' destruction receipt`,
					);
					const completedState = reduceToolVmLeaseAuthorityState(
						requireAuthorityState(destroyOptions.authority.gateway),
						{
							authority: destroyOptions.authority,
							destroyedAtMs: destroyOptions.destroyedAtMs,
							kind: 'destruction-completed',
							reason: destroyOptions.reason,
							receipt: {
								complete: true,
								reservationId: resource.ownershipProof.destructionIdentity.reservationId,
								reservationPath: resource.ownershipProof.destructionIdentity.reservationPath,
								vmId: resource.ownershipProof.destructionIdentity.vmId,
							},
						},
					);
					replaceAuthorityState(destroyOptions.authority.gateway, completedState);
					resourcesByAuthority.delete(authorityResourceKey(destroyOptions.authority));
					authorityResourceKeysByLeaseId.delete(destroyOptions.authority.leaseId);
					releaseDestructionTombstone(destroyOptions.authority);
					return resource;
				} catch (error) {
					recordDestructionIncomplete(destroyOptions.authority, 'exact-destruction-unproven');
					throw error;
				}
			})();
			resource.destructionInFlight = destruction;
			void destruction.then(
				() => {
					delete resource.destructionInFlight;
				},
				() => {
					delete resource.destructionInFlight;
				},
			);
			return destruction;
		},
		findCurrentLeaseByPrincipal(findOptions): TLease | undefined {
			const state = authorityStatesByGateway.get(gatewayAuthorityKey(findOptions.gateway));
			if (state === undefined) {
				return undefined;
			}
			const leaf = state.leavesByPrincipal.get(stablePrincipalKey(findOptions.principal));
			if (leaf?.kind !== 'current') {
				return undefined;
			}
			return committedLeaseForResource(
				requireResource({
					gateway: findOptions.gateway,
					leaseId: leaf.leaseId,
					leafGeneration: leaf.leafGeneration,
					principal: leaf.principal,
				}),
			);
		},
		getLease(leaseId): TLease | undefined {
			const resourceKey = authorityResourceKeysByLeaseId.get(leaseId);
			if (resourceKey === undefined) {
				return undefined;
			}
			const resource = resourcesByAuthority.get(resourceKey);
			return resource === undefined ? undefined : committedLeaseForResource(resource);
		},
		leaseIdsOwnedByGateway(gateway): readonly string[] {
			return leaseIdsForGateway(gateway);
		},
		listLeases(): readonly TLease[] {
			return [...resourcesByAuthority.values()].flatMap((resource) => {
				const lease = committedLeaseForResource(resource);
				return lease === undefined ? [] : [lease];
			});
		},
		rejectedCleanupIdsOwnedByGateway(gateway): readonly string[] {
			return rejectedCleanupIdsForGateway(gateway);
		},
		registerGateway(gateway): void {
			const key = gatewayAuthorityKey(gateway);
			if (authorityStatesByGateway.has(key)) {
				return;
			}
			authorityStatesByGateway.set(
				key,
				reduceToolVmLeaseAuthorityState(createEmptyToolVmLeaseAuthorityState(options), {
					gateway,
					kind: 'register-parent',
				}),
			);
		},
		retireGateway(gateway): void {
			if (
				leaseIdsForGateway(gateway).length > 0 ||
				rejectedCleanupIdsForGateway(gateway).length > 0 ||
				(reservedDestructionTombstonesByGateway.get(gatewayAuthorityKey(gateway))?.size ?? 0) > 0
			) {
				throw new ToolVmLeaseAuthorityTransitionError(
					'parent-has-live-leaves',
					'Gateway parent still has retained runtime resources.',
				);
			}
			replaceAuthorityState(
				gateway,
				reduceToolVmLeaseAuthorityState(requireAuthorityState(gateway), {
					gateway,
					kind: 'retire-parent',
				}),
			);
		},
		async retryRejectedProvisioningCleanup(cleanupId): Promise<void> {
			const resource = rejectedCleanupResourcesByAuthority.get(cleanupId);
			if (resource === undefined) {
				return;
			}
			if (resource.destructionInFlight !== undefined) {
				await resource.destructionInFlight;
				return;
			}
			const cleanup = (async (): Promise<ToolVmLeaseRuntimeResource<TLease>> => {
				const receipt = await resource.ownership.destroyDetached();
				assertVmDestroyReceiptMatchesTarget(
					receipt,
					resource.ownershipProof.verifiedDestroyTarget,
					`Rejected Tool VM cleanup '${cleanupId}' receipt`,
				);
				rejectedCleanupResourcesByAuthority.delete(cleanupId);
				return resource;
			})();
			resource.destructionInFlight = cleanup;
			try {
				await cleanup;
			} finally {
				delete resource.destructionInFlight;
			}
		},
		sealGateway(gateway): void {
			replaceAuthorityState(
				gateway,
				reduceToolVmLeaseAuthorityState(requireAuthorityState(gateway), {
					gateway,
					kind: 'seal-parent',
				}),
			);
		},
		touchLease(authority, nowMs, nextIdleExpiresAtMs, updateLease): TLease {
			const resource = requireResource(authority);
			const currentLease = committedLeaseForResource(resource);
			if (currentLease === undefined) {
				throw new Error(`Tool VM lease '${authority.leaseId}' is not current.`);
			}
			const currentLeaf = requireLiveLeaf(requireAuthorityState(authority.gateway), authority);
			if (currentLeaf.kind !== 'current') {
				throw new Error(`Tool VM lease '${authority.leaseId}' is not current.`);
			}
			const updatedLease = updateLease(currentLease);
			assertLeaseMatchesRuntime({
				authority,
				lease: updatedLease,
				runtimeBinding: currentLeaf.runtimeBinding,
				verifiedDestroyTarget: resource.ownershipProof.verifiedDestroyTarget,
			});
			const state = reduceToolVmLeaseAuthorityState(requireAuthorityState(authority.gateway), {
				authority,
				kind: 'renew-idle-expiry',
				nextIdleExpiresAtMs,
				nowMs,
			});
			replaceAuthorityState(authority.gateway, state);
			resourcesByAuthority.set(authorityResourceKey(authority), {
				...resource,
				lease: updatedLease,
			});
			return updatedLease;
		},
	};
}
