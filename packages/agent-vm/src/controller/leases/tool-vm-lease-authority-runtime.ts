import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import {
	type ToolVmExactDestructionOptions,
	type ToolVmLeaseAuthorityRuntime,
	type ToolVmLeaseRuntimeResource,
	type ToolVmRuntimeLeaseIdentity,
} from './tool-vm-lease-authority-runtime-contracts.js';
import {
	assertLeaseMatchesRuntime,
	authorityResourceKey,
	commitIdentity,
	gatewayAuthorityKey,
} from './tool-vm-lease-authority-runtime-identity.js';
import { requireLiveLeaf, stablePrincipalKey } from './tool-vm-lease-authority-state-helpers.js';
import {
	createEmptyToolVmLeaseAuthorityState,
	reduceToolVmLeaseAuthorityState,
	ToolVmLeaseAuthorityTransitionError,
	type ToolVmLeafAuthorityReference,
	type ToolVmLeaseLeafState,
	type ToolVmLeaseAuthorityRetentionPolicy,
	type ToolVmLeaseAuthorityState,
	type ToolVmActiveUse,
} from './tool-vm-lease-authority-state.js';

export {
	type ToolVmExactDestructionAdmission,
	type ToolVmExactDestructionAdmissionPolicy,
	type ToolVmExactDestructionOptions,
	type ToolVmLeaseAuthorityRuntime,
	type ToolVmLeaseRuntimeResource,
	type ToolVmRuntimeLeaseIdentity,
} from './tool-vm-lease-authority-runtime-contracts.js';

interface MutableToolVmLeaseRuntimeResource<
	TLease extends ToolVmRuntimeLeaseIdentity,
> extends ToolVmLeaseRuntimeResource<TLease> {
	commitDisposition: 'complete' | 'not-started';
	commitIdentity?: string;
	commitLease?: TLease;
	destructionInFlight?: Promise<ToolVmLeaseRuntimeResource<TLease>>;
	lease?: TLease;
}

export function createToolVmLeaseAuthorityRuntime<
	TLease extends ToolVmRuntimeLeaseIdentity,
	TCleanupContext = never,
>(
	options: {
		readonly retentionPolicy?: Partial<ToolVmLeaseAuthorityRetentionPolicy>;
	} = {},
): ToolVmLeaseAuthorityRuntime<TLease, TCleanupContext> {
	const authorityStatesByGateway = new Map<string, ToolVmLeaseAuthorityState>();
	const resourcesByAuthority = new Map<string, MutableToolVmLeaseRuntimeResource<TLease>>();
	const authorityResourceKeysByLeaseId = new Map<string, string>();
	const cleanupContextsByAuthority = new Map<string, TCleanupContext>();
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

	function resourceForLeaseId(
		leaseId: string,
	): MutableToolVmLeaseRuntimeResource<TLease> | undefined {
		const resourceKey = authorityResourceKeysByLeaseId.get(leaseId);
		return resourceKey === undefined ? undefined : resourcesByAuthority.get(resourceKey);
	}

	function leafSnapshotForResource(
		resource: MutableToolVmLeaseRuntimeResource<TLease>,
	): ToolVmLeaseLeafState {
		return structuredClone(
			requireLiveLeaf(requireAuthorityState(resource.authority.gateway), resource.authority),
		);
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
				'Tool VM leaf tombstone capacity is exhausted before controller destruction.',
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

	function startExactDestruction(
		destroyOptions: ToolVmExactDestructionOptions,
	): Promise<ToolVmLeaseRuntimeResource<TLease>> {
		const resource = requireResource(destroyOptions.authority);
		if (resource.destructionInFlight !== undefined) {
			return resource.destructionInFlight;
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
				await destroyOptions.destroy();
				const completedState = reduceToolVmLeaseAuthorityState(
					requireAuthorityState(destroyOptions.authority.gateway),
					{
						authority: destroyOptions.authority,
						destroyedAtMs: destroyOptions.destroyedAtMs,
						kind: 'destruction-completed',
						reason: destroyOptions.reason,
						...(resource.lease === undefined ? {} : { vmId: resource.lease.vm.id }),
					},
				);
				replaceAuthorityState(destroyOptions.authority.gateway, completedState);
				resourcesByAuthority.delete(authorityResourceKey(destroyOptions.authority));
				cleanupContextsByAuthority.delete(authorityResourceKey(destroyOptions.authority));
				authorityResourceKeysByLeaseId.delete(destroyOptions.authority.leaseId);
				releaseDestructionTombstone(destroyOptions.authority);
				return resource;
			} catch (error) {
				recordDestructionIncomplete(destroyOptions.authority, 'controller-destruction-failed');
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
	}

	return {
		activeUseCount(leaseId): number {
			const resource = resourceForLeaseId(leaseId);
			return resource === undefined ? 0 : leafSnapshotForResource(resource).activeUses.size;
		},
		activeUseSnapshots(leaseId): readonly ToolVmActiveUse[] {
			const resource = resourceForLeaseId(leaseId);
			const leaf = resource === undefined ? undefined : leafSnapshotForResource(resource);
			return leaf === undefined ? [] : [...leaf.activeUses.values()];
		},
		admitExactDestruction(admissionOptions) {
			const resource = requireResource(admissionOptions.authority);
			if (resource.destructionInFlight !== undefined) {
				return { completion: resource.destructionInFlight, kind: 'started' };
			}
			if (admissionOptions.policy.kind === 'require-no-active-use') {
				const leaf = leafSnapshotForResource(resource);
				if (leaf.activeUses.size > 0) {
					return { kind: 'blocked-active-use' };
				}
				if (
					admissionOptions.policy.ifLastUsedAtBeforeOrAt !== undefined &&
					resource.lease !== undefined &&
					resource.lease.lastUsedAt > admissionOptions.policy.ifLastUsedAtBeforeOrAt
				) {
					return { kind: 'skip-recently-used' };
				}
			}
			return { completion: startExactDestruction(admissionOptions), kind: 'started' };
		},
		applyAuthorityCommand(command): ToolVmLeaseLeafState | undefined {
			if (command.kind === 'prune-tombstones') {
				for (const [gatewayKey, state] of authorityStatesByGateway.entries()) {
					const prunedState = reduceToolVmLeaseAuthorityState(state, command);
					const canEvictRetiredState =
						prunedState.parent.kind === 'retired' &&
						prunedState.leavesByPrincipal.size === 0 &&
						prunedState.terminalUseTombstones.size === 0 &&
						prunedState.tombstonesByGeneration.size === 0 &&
						leaseIdsForGateway(prunedState.parent.gateway).length === 0 &&
						(reservedDestructionTombstonesByGateway.get(gatewayKey)?.size ?? 0) === 0;
					if (canEvictRetiredState) {
						authorityStatesByGateway.delete(gatewayKey);
					} else {
						authorityStatesByGateway.set(gatewayKey, prunedState);
					}
				}
				return undefined;
			}
			const gateway = 'authority' in command ? command.authority.gateway : command.gateway;
			replaceAuthorityState(
				gateway,
				reduceToolVmLeaseAuthorityState(requireAuthorityState(gateway), command),
			);
			if (!('authority' in command)) {
				return undefined;
			}
			return leafSnapshotForResource(requireResource(command.authority));
		},
		authorityForLease(leaseId): ToolVmLeafAuthorityReference | undefined {
			const resource = resourceForLeaseId(leaseId);
			return resource === undefined ? undefined : structuredClone(resource.authority);
		},
		authorityForPrincipal(principal): ToolVmLeafAuthorityReference | undefined {
			const principalKey = stablePrincipalKey(principal);
			const resource = [...resourcesByAuthority.values()].find(
				(candidateResource) =>
					stablePrincipalKey(candidateResource.authority.principal) === principalKey,
			);
			if (resource !== undefined) {
				return structuredClone(resource.authority);
			}
			return undefined;
		},
		cleanupContextForAuthority(authority): TCleanupContext | undefined {
			return cleanupContextsByAuthority.get(authorityResourceKey(authority));
		},
		cleanupContextForLease(leaseId): TCleanupContext | undefined {
			const resource = resourceForLeaseId(leaseId);
			return resource === undefined
				? undefined
				: cleanupContextsByAuthority.get(authorityResourceKey(resource.authority));
		},
		beginProvisioning(beginOptions): void {
			const resourceKey = authorityResourceKey(beginOptions.authority);
			if (
				resourcesByAuthority.has(resourceKey) ||
				authorityResourceKeysByLeaseId.has(beginOptions.authority.leaseId)
			) {
				throw new Error('Tool VM lease authority already has a retained runtime resource.');
			}
			const state = reduceToolVmLeaseAuthorityState(
				requireAuthorityState(beginOptions.authority.gateway),
				{
					authority: beginOptions.authority,
					compatibility: beginOptions.compatibility,
					idleExpiresAtMs: beginOptions.idleExpiresAtMs,
					kind: 'begin-provisioning',
				},
			);
			replaceAuthorityState(beginOptions.authority.gateway, state);
			if (beginOptions.cleanupContext !== undefined) {
				cleanupContextsByAuthority.set(resourceKey, beginOptions.cleanupContext);
			}
			resourcesByAuthority.set(resourceKey, {
				authority: structuredClone(beginOptions.authority),
				commitDisposition: 'not-started',
			});
			authorityResourceKeysByLeaseId.set(beginOptions.authority.leaseId, resourceKey);
		},
		async commitCurrent(commitOptions): Promise<void> {
			const resource = requireResource(commitOptions.authority);
			assertLeaseMatchesRuntime({
				authority: commitOptions.authority,
				lease: commitOptions.lease,
				runtimeBinding: commitOptions.runtimeBinding,
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
		},
		destroyExact(destroyOptions): Promise<ToolVmLeaseRuntimeResource<TLease>> {
			return startExactDestruction(destroyOptions);
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
		getCleanupLease(leaseId): TLease | undefined {
			return resourceForLeaseId(leaseId)?.lease;
		},
		getLease(leaseId): TLease | undefined {
			const resource = resourceForLeaseId(leaseId);
			return resource === undefined ? undefined : committedLeaseForResource(resource);
		},
		getRetainedLease(leaseId): TLease | undefined {
			const resource = resourceForLeaseId(leaseId);
			return resource?.commitDisposition === 'complete' ? resource.lease : undefined;
		},
		leaseIdsOwnedByGateway(gateway): readonly string[] {
			return leaseIdsForGateway(gateway);
		},
		leafSnapshotForLease(leaseId): ToolVmLeaseLeafState | undefined {
			const resource = resourceForLeaseId(leaseId);
			return resource === undefined ? undefined : leafSnapshotForResource(resource);
		},
		listLeases(): readonly TLease[] {
			return [...resourcesByAuthority.values()].flatMap((resource) => {
				const lease = committedLeaseForResource(resource);
				return lease === undefined ? [] : [lease];
			});
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
		sealGateway(gateway): void {
			const parent = requireAuthorityState(gateway).parent;
			if (parent.kind === 'sealed') {
				return;
			}
			replaceAuthorityState(
				gateway,
				reduceToolVmLeaseAuthorityState(requireAuthorityState(gateway), {
					gateway,
					kind: 'seal-parent',
				}),
			);
		},
		setCleanupContext(authority, context): void {
			requireResource(authority);
			cleanupContextsByAuthority.set(authorityResourceKey(authority), context);
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
