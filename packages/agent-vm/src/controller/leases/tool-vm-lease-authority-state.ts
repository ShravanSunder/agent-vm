import {
	type AuthorizedToolVmLeafBinding,
	type TerminalToolVmActiveUseTombstone,
	type ToolVmActiveUse,
	type ToolVmLeafAuthorityReference,
	type ToolVmLeaseAuthorityCommand,
	type ToolVmLeaseAuthorityRetentionPolicy,
	type ToolVmLeaseAuthorityState,
	type ToolVmLeaseCompatibility,
	type ToolVmLeaseLeafState,
} from './tool-vm-lease-authority-contracts.js';
import {
	compatibilitiesEqual,
	nonTerminalActiveUseExists,
	quarantineLeafForAmbiguousUse,
	replaceLeaf,
	requireAdmittingParent,
	requireExactParent,
	requireLiveLeaf,
	stablePrincipalKey,
	terminalUseTombstoneKey,
	transitionError,
	validateLatestReport,
	validateRetentionPolicy,
} from './tool-vm-lease-authority-state-helpers.js';

export * from './tool-vm-lease-authority-contracts.js';

export const DEFAULT_TOOL_VM_LEAF_TOMBSTONE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_TOOL_VM_LEAF_TOMBSTONE_CAPACITY = 4_096;
export const DEFAULT_TOOL_VM_TERMINAL_USE_TOMBSTONE_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_TOOL_VM_TERMINAL_USE_TOMBSTONE_CAPACITY = 4_096;
export const DEFAULT_TOOL_VM_OBSERVATION_GAP_GRACE_MS = 120_000;

const defaultRetentionPolicy = {
	leafTombstoneTtlMs: DEFAULT_TOOL_VM_LEAF_TOMBSTONE_TTL_MS,
	maxLeafTombstones: DEFAULT_TOOL_VM_LEAF_TOMBSTONE_CAPACITY,
	maxTerminalUseTombstones: DEFAULT_TOOL_VM_TERMINAL_USE_TOMBSTONE_CAPACITY,
	observationGapGraceMs: DEFAULT_TOOL_VM_OBSERVATION_GAP_GRACE_MS,
	terminalUseTombstoneTtlMs: DEFAULT_TOOL_VM_TERMINAL_USE_TOMBSTONE_TTL_MS,
} satisfies ToolVmLeaseAuthorityRetentionPolicy;

export function createEmptyToolVmLeaseAuthorityState(
	options: {
		readonly retentionPolicy?: Partial<ToolVmLeaseAuthorityRetentionPolicy>;
	} = {},
): ToolVmLeaseAuthorityState {
	const retentionPolicy = {
		...defaultRetentionPolicy,
		...options.retentionPolicy,
	};
	validateRetentionPolicy(retentionPolicy);
	return {
		leavesByPrincipal: new Map(),
		parent: { kind: 'unregistered' },
		retentionPolicy,
		terminalUseTombstones: new Map(),
		tombstonesByGeneration: new Map(),
	};
}

export function authorizeCurrentToolVmLeafBinding(
	state: ToolVmLeaseAuthorityState,
	request: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly compatibility: ToolVmLeaseCompatibility;
		readonly nowMs: number;
		readonly sshBindingId: string;
	},
): AuthorizedToolVmLeafBinding {
	requireAdmittingParent(state, request.authority.gateway);
	const leaf = requireLiveLeaf(state, request.authority);
	if (leaf.kind !== 'current') {
		return transitionError('leaf-not-current', `Leaf is '${leaf.kind}' and cannot authorize work.`);
	}
	if (!compatibilitiesEqual(leaf.compatibility, request.compatibility)) {
		return transitionError(
			'compatibility-conflict',
			'Lease compatibility does not match the current leaf.',
		);
	}
	if (request.nowMs >= leaf.idleExpiresAtMs && !nonTerminalActiveUseExists(leaf.activeUses)) {
		return transitionError('lease-expired', 'Lease policy has expired.');
	}
	if (leaf.sshBinding.bindingId !== request.sshBindingId) {
		return transitionError('binding-not-authorized', 'SSH binding is not current for this leaf.');
	}
	return {
		leaseId: leaf.leaseId,
		leafGeneration: leaf.leafGeneration,
		idleExpiresAtMs: leaf.idleExpiresAtMs,
		runtimeBinding: leaf.runtimeBinding,
		sshBinding: leaf.sshBinding,
	};
}

export function reduceToolVmLeaseAuthorityState(
	state: ToolVmLeaseAuthorityState,
	command: ToolVmLeaseAuthorityCommand,
): ToolVmLeaseAuthorityState {
	switch (command.kind) {
		case 'register-parent': {
			if (state.parent.kind !== 'unregistered') {
				return transitionError(
					'parent-already-registered',
					'Gateway parent is already registered.',
				);
			}
			return {
				...state,
				parent: { gateway: structuredClone(command.gateway), kind: 'registered' },
			};
		}
		case 'seal-parent': {
			const parent = requireExactParent(state, command.gateway);
			if (parent.kind !== 'registered') {
				return transitionError(
					'parent-not-admitting',
					`Gateway parent is already '${parent.kind}'.`,
				);
			}
			return { ...state, parent: { gateway: parent.gateway, kind: 'sealed' } };
		}
		case 'retire-parent': {
			const parent = requireExactParent(state, command.gateway);
			if (parent.kind !== 'sealed') {
				return transitionError(
					'parent-not-sealed',
					'Gateway parent must be sealed before retirement.',
				);
			}
			if (state.leavesByPrincipal.size > 0) {
				return transitionError(
					'parent-has-live-leaves',
					'Gateway parent cannot retire while a live leaf disposition remains.',
				);
			}
			return { ...state, parent: { gateway: parent.gateway, kind: 'retired' } };
		}
		case 'begin-provisioning': {
			requireAdmittingParent(state, command.authority.gateway);
			if (
				command.authority.leaseId.length === 0 ||
				!Number.isSafeInteger(command.idleExpiresAtMs) ||
				command.idleExpiresAtMs <= 0
			) {
				throw new Error(
					'Lease identity and policy expiry must be controller-owned bounded values.',
				);
			}
			if (command.authority.principal.zoneId !== command.authority.gateway.zoneId) {
				return transitionError(
					'principal-mismatch',
					'Stable principal zone does not match its Gateway parent.',
				);
			}
			const principalKey = stablePrincipalKey(command.authority.principal);
			if (state.leavesByPrincipal.has(principalKey)) {
				return transitionError(
					'leaf-already-exists',
					'Stable principal already has a provisional or live leaf.',
				);
			}
			if (
				state.tombstonesByGeneration.has(command.authority.leafGeneration) ||
				[...state.leavesByPrincipal.values()].some(
					(leaf) => leaf.leafGeneration === command.authority.leafGeneration,
				)
			) {
				return transitionError(
					'leaf-generation-reused',
					'Leaf generation was already used and cannot be reissued.',
				);
			}
			return replaceLeaf(state, {
				activeUses: new Map(),
				compatibility: structuredClone(command.compatibility),
				kind: 'provisioning',
				leaseId: command.authority.leaseId,
				leafGeneration: command.authority.leafGeneration,
				idleExpiresAtMs: command.idleExpiresAtMs,
				principal: structuredClone(command.authority.principal),
			});
		}
		case 'commit-current': {
			// Provisioning authority was admitted before a parent seal. Completing
			// that exact durable commit publishes the existing child so teardown
			// can discover it; it does not admit a new child under the sealed parent.
			requireExactParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'provisioning') {
				return transitionError(
					'leaf-not-provisioning',
					`Leaf is '${leaf.kind}' and cannot accept a create result.`,
				);
			}
			return replaceLeaf(state, {
				...leaf,
				kind: 'current',
				runtimeBinding: structuredClone(command.runtimeBinding),
				sshBinding: structuredClone(command.sshBinding),
			});
		}
		case 'renew-idle-expiry': {
			requireAdmittingParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'current') {
				return transitionError(
					'leaf-not-current',
					`Leaf is '${leaf.kind}' and cannot renew idle expiry.`,
				);
			}
			if (command.nowMs >= leaf.idleExpiresAtMs && !nonTerminalActiveUseExists(leaf.activeUses)) {
				return transitionError('lease-expired', 'Lease idle expiry has already elapsed.');
			}
			if (
				!Number.isSafeInteger(command.nextIdleExpiresAtMs) ||
				command.nextIdleExpiresAtMs <= command.nowMs ||
				command.nextIdleExpiresAtMs <= leaf.idleExpiresAtMs
			) {
				return transitionError(
					'idle-expiry-regressed',
					'Lease idle expiry must advance beyond both the current deadline and observation time.',
				);
			}
			return replaceLeaf(state, {
				...leaf,
				idleExpiresAtMs: command.nextIdleExpiresAtMs,
			});
		}
		case 'mark-suspect': {
			requireAdmittingParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'current') {
				return transitionError('leaf-not-current', `Leaf is '${leaf.kind}', not current.`);
			}
			return replaceLeaf(state, {
				...leaf,
				kind: 'suspect',
				suspectReason: command.reason,
			});
		}
		case 'restore-current': {
			requireAdmittingParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'suspect') {
				return transitionError('leaf-not-current', `Leaf is '${leaf.kind}', not suspect.`);
			}
			return replaceLeaf(state, {
				activeUses: leaf.activeUses,
				compatibility: leaf.compatibility,
				kind: 'current',
				leaseId: leaf.leaseId,
				leafGeneration: leaf.leafGeneration,
				idleExpiresAtMs: leaf.idleExpiresAtMs,
				principal: leaf.principal,
				runtimeBinding: leaf.runtimeBinding,
				sshBinding: leaf.sshBinding,
			});
		}
		case 'quarantine': {
			requireExactParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (
				leaf.kind !== 'provisioning' &&
				leaf.kind !== 'current' &&
				leaf.kind !== 'suspect' &&
				leaf.kind !== 'quarantined'
			) {
				return transitionError('leaf-not-current', `Leaf is '${leaf.kind}' and cannot quarantine.`);
			}
			return replaceLeaf(state, {
				...leaf,
				kind: 'quarantined',
				quarantineReason: command.reason,
			});
		}
		case 'start-active-use': {
			requireAdmittingParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'current') {
				return transitionError('leaf-not-current', `Leaf is '${leaf.kind}' and cannot start work.`);
			}
			const terminalTombstone = state.terminalUseTombstones.get(
				terminalUseTombstoneKey(command.authority, command.use.useId),
			);
			if (terminalTombstone !== undefined) {
				if (
					terminalTombstone.semanticOperationId === command.use.semanticOperationId &&
					terminalTombstone.operationPayloadDigest === command.use.operationPayloadDigest &&
					terminalTombstone.processEpoch === command.use.processEpoch
				) {
					return transitionError(
						'active-use-not-resumable',
						'Active use already ended and cannot be started again.',
					);
				}
				return transitionError(
					'active-use-semantic-collision',
					'Terminal active-use identity was retried with changed semantic meaning.',
				);
			}
			const existingUse = leaf.activeUses.get(command.use.useId);
			if (existingUse !== undefined) {
				const sameSemanticIdentity =
					existingUse.processEpoch === command.use.processEpoch &&
					existingUse.semanticOperationId === command.use.semanticOperationId &&
					existingUse.operationPayloadDigest === command.use.operationPayloadDigest;
				if (existingUse.kind === 'running' && sameSemanticIdentity) {
					return state;
				}
				if (!sameSemanticIdentity) {
					return transitionError(
						'active-use-semantic-collision',
						'Active-use identity was retried with changed process or semantic meaning.',
					);
				}
			}
			if (nonTerminalActiveUseExists(leaf.activeUses)) {
				return transitionError('active-use-conflict', 'Leaf already has non-terminal remote work.');
			}
			const activeUses = new Map(leaf.activeUses);
			activeUses.set(command.use.useId, { ...command.use, kind: 'running' });
			return replaceLeaf(state, { ...leaf, activeUses });
		}
		case 'heartbeat-active-use': {
			requireAdmittingParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'current') {
				return transitionError(
					'leaf-not-current',
					`Leaf is '${leaf.kind}' and cannot heartbeat work.`,
				);
			}
			const activeUse = leaf.activeUses.get(command.useId);
			if (activeUse === undefined) {
				return transitionError('active-use-not-found', 'Active use does not exist.');
			}
			if (activeUse.kind !== 'running') {
				return transitionError('active-use-not-resumable', `Active use is '${activeUse.kind}'.`);
			}
			if (activeUse.processEpoch !== command.processEpoch) {
				return transitionError('process-epoch-mismatch', 'Heartbeat process epoch is stale.');
			}
			if (activeUse.sessionAttachmentGeneration !== command.sessionAttachmentGeneration) {
				return transitionError(
					'attachment-generation-regressed',
					'Heartbeat session attachment does not own this active use.',
				);
			}
			if (command.heartbeatAtMs < activeUse.lastHeartbeatAtMs) {
				return transitionError(
					'active-use-heartbeat-regressed',
					'Active-use heartbeat observation time regressed.',
				);
			}
			if (command.report !== undefined) {
				validateLatestReport(command.report);
				if (
					activeUse.latestReport !== undefined &&
					command.report.sequence <= activeUse.latestReport.sequence
				) {
					return transitionError(
						'active-use-report-regressed',
						'Active-use report sequence did not advance.',
					);
				}
			}
			const activeUses = new Map(leaf.activeUses);
			activeUses.set(command.useId, {
				...activeUse,
				lastHeartbeatAtMs: command.heartbeatAtMs,
				...(command.operationReport === undefined
					? {}
					: { latestOperationReport: structuredClone(command.operationReport) }),
				...(command.report === undefined ? {} : { latestReport: structuredClone(command.report) }),
			});
			return replaceLeaf(state, { ...leaf, activeUses });
		}
		case 'session-disconnected': {
			requireExactParent(state, command.gateway);
			let leavesByPrincipal: Map<string, ToolVmLeaseLeafState> | undefined;
			for (const [principalKey, leaf] of state.leavesByPrincipal.entries()) {
				if (leaf.kind !== 'current' && leaf.kind !== 'suspect') {
					continue;
				}
				let activeUses: Map<string, ToolVmActiveUse> | undefined;
				for (const [useId, activeUse] of leaf.activeUses.entries()) {
					if (
						activeUse.kind === 'running' &&
						activeUse.processEpoch === command.processEpoch &&
						activeUse.sessionAttachmentGeneration === command.sessionAttachmentGeneration
					) {
						activeUses ??= new Map(leaf.activeUses);
						activeUses.set(useId, {
							...activeUse,
							kind: 'observation-gap',
							observedAtMs: command.observedAtMs,
							resumeDeadlineMs: command.observedAtMs + state.retentionPolicy.observationGapGraceMs,
						});
					}
				}
				if (activeUses !== undefined) {
					leavesByPrincipal ??= new Map(state.leavesByPrincipal);
					leavesByPrincipal.set(principalKey, { ...leaf, activeUses });
				}
			}
			return leavesByPrincipal === undefined ? state : { ...state, leavesByPrincipal };
		}
		case 'resume-active-use': {
			requireAdmittingParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'current') {
				return transitionError(
					'leaf-not-current',
					`Leaf is '${leaf.kind}' and cannot resume work.`,
				);
			}
			const activeUse = leaf.activeUses.get(command.useId);
			if (activeUse === undefined) {
				return transitionError('active-use-not-found', 'Active use does not exist.');
			}
			if (activeUse.kind !== 'observation-gap') {
				return transitionError('active-use-not-resumable', `Active use is '${activeUse.kind}'.`);
			}
			if (activeUse.processEpoch !== command.processEpoch) {
				return transitionError(
					'process-epoch-mismatch',
					'Only the same process epoch may resume an observation gap.',
				);
			}
			if (command.nowMs >= activeUse.resumeDeadlineMs) {
				return transitionError(
					'observation-gap-expired',
					'Observation-gap resume deadline has expired.',
				);
			}
			if (command.sessionAttachmentGeneration <= activeUse.sessionAttachmentGeneration) {
				return transitionError(
					'attachment-generation-regressed',
					'Resumed session attachment generation must advance.',
				);
			}
			const activeUses = new Map(leaf.activeUses);
			activeUses.set(command.useId, {
				kind: 'running',
				lastHeartbeatAtMs: command.lastHeartbeatAtMs,
				...(activeUse.correlation === undefined ? {} : { correlation: activeUse.correlation }),
				...(activeUse.latestOperationReport === undefined
					? {}
					: { latestOperationReport: activeUse.latestOperationReport }),
				...(activeUse.latestReport === undefined ? {} : { latestReport: activeUse.latestReport }),
				operationPayloadDigest: activeUse.operationPayloadDigest,
				processEpoch: activeUse.processEpoch,
				semanticOperationId: activeUse.semanticOperationId,
				sessionAttachmentGeneration: command.sessionAttachmentGeneration,
				startedAtMs: activeUse.startedAtMs,
				useId: activeUse.useId,
			});
			return replaceLeaf(state, { ...leaf, activeUses });
		}
		case 'end-active-use': {
			requireAdmittingParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'current' && leaf.kind !== 'suspect') {
				return transitionError('leaf-not-current', `Leaf is '${leaf.kind}' and cannot end work.`);
			}
			const activeUse = leaf.activeUses.get(command.useId);
			if (activeUse === undefined) {
				return transitionError('active-use-not-found', 'Active use does not exist.');
			}
			if (activeUse.kind === 'ambiguous' || activeUse.kind === 'terminal') {
				return transitionError('active-use-not-resumable', `Active use is '${activeUse.kind}'.`);
			}
			if (activeUse.processEpoch !== command.processEpoch) {
				return transitionError(
					'process-epoch-mismatch',
					'Only the process epoch that owns an active use may report it terminal.',
				);
			}
			if (
				(activeUse.kind === 'running' &&
					activeUse.sessionAttachmentGeneration !== command.sessionAttachmentGeneration) ||
				(activeUse.kind === 'observation-gap' &&
					activeUse.sessionAttachmentGeneration >= command.sessionAttachmentGeneration)
			) {
				return transitionError(
					'attachment-generation-regressed',
					'Terminal report does not match a valid current session attachment.',
				);
			}
			const tombstoneKey = terminalUseTombstoneKey(command.authority, command.useId);
			if (
				!state.terminalUseTombstones.has(tombstoneKey) &&
				state.terminalUseTombstones.size >= state.retentionPolicy.maxTerminalUseTombstones
			) {
				return transitionError(
					'tombstone-capacity-exhausted',
					'Terminal active-use tombstone capacity is exhausted; prune expired entries first.',
				);
			}
			const activeUses = new Map(leaf.activeUses);
			activeUses.delete(command.useId);
			const terminalUseTombstones = new Map(state.terminalUseTombstones);
			const terminalTombstone = {
				...(activeUse.correlation === undefined ? {} : { correlation: activeUse.correlation }),
				endedAtMs: command.endedAtMs,
				expiresAtMs: command.endedAtMs + state.retentionPolicy.terminalUseTombstoneTtlMs,
				gateway: structuredClone(command.authority.gateway),
				leafGeneration: leaf.leafGeneration,
				...(activeUse.latestReport === undefined ? {} : { latestReport: activeUse.latestReport }),
				...(command.operationReport === undefined && activeUse.latestOperationReport === undefined
					? {}
					: {
							latestOperationReport: structuredClone(
								command.operationReport ?? activeUse.latestOperationReport,
							),
						}),
				operationPayloadDigest: activeUse.operationPayloadDigest,
				outcome: command.outcome,
				principal: leaf.principal,
				processEpoch: activeUse.processEpoch,
				semanticOperationId: activeUse.semanticOperationId,
				useId: activeUse.useId,
			} satisfies TerminalToolVmActiveUseTombstone;
			terminalUseTombstones.set(tombstoneKey, terminalTombstone);
			const stateWithUpdatedLeaf = replaceLeaf(state, { ...leaf, activeUses });
			return { ...stateWithUpdatedLeaf, terminalUseTombstones };
		}
		case 'expire-observation-gap': {
			requireExactParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'current' && leaf.kind !== 'suspect') {
				return transitionError('leaf-not-current', `Leaf is '${leaf.kind}' and has no active use.`);
			}
			const activeUse = leaf.activeUses.get(command.useId);
			if (activeUse === undefined) {
				return transitionError('active-use-not-found', 'Active use does not exist.');
			}
			if (activeUse.kind !== 'observation-gap') {
				return transitionError('active-use-not-resumable', `Active use is '${activeUse.kind}'.`);
			}
			if (activeUse.sessionAttachmentGeneration !== command.expectedSessionAttachmentGeneration) {
				return transitionError(
					'attachment-generation-regressed',
					'Observation-gap expiry does not match the fenced attachment generation.',
				);
			}
			if (command.nowMs < activeUse.resumeDeadlineMs) {
				return transitionError(
					'observation-gap-not-expired',
					'Observation-gap deadline has not expired.',
				);
			}
			const activeUses = new Map(leaf.activeUses);
			activeUses.set(command.useId, {
				ambiguousAtMs: command.ambiguousAtMs,
				...(activeUse.correlation === undefined ? {} : { correlation: activeUse.correlation }),
				kind: 'ambiguous',
				...(activeUse.latestOperationReport === undefined
					? {}
					: { latestOperationReport: activeUse.latestOperationReport }),
				...(activeUse.latestReport === undefined ? {} : { latestReport: activeUse.latestReport }),
				operationPayloadDigest: activeUse.operationPayloadDigest,
				processEpoch: activeUse.processEpoch,
				reason: 'observation-gap-expired',
				semanticOperationId: activeUse.semanticOperationId,
				startedAtMs: activeUse.startedAtMs,
				useId: activeUse.useId,
			});
			return replaceLeaf(state, quarantineLeafForAmbiguousUse(leaf, activeUses));
		}
		case 'process-epoch-lost': {
			requireExactParent(state, command.gateway);
			let leavesByPrincipal: Map<string, ToolVmLeaseLeafState> | undefined;
			for (const [principalKey, leaf] of state.leavesByPrincipal.entries()) {
				if (leaf.kind !== 'current' && leaf.kind !== 'suspect') {
					continue;
				}
				let activeUses: Map<string, ToolVmActiveUse> | undefined;
				for (const [useId, activeUse] of leaf.activeUses.entries()) {
					if (
						(activeUse.kind === 'running' || activeUse.kind === 'observation-gap') &&
						activeUse.processEpoch === command.processEpoch
					) {
						activeUses ??= new Map(leaf.activeUses);
						activeUses.set(useId, {
							ambiguousAtMs: command.ambiguousAtMs,
							...(activeUse.correlation === undefined
								? {}
								: { correlation: activeUse.correlation }),
							kind: 'ambiguous',
							...(activeUse.latestOperationReport === undefined
								? {}
								: { latestOperationReport: activeUse.latestOperationReport }),
							...(activeUse.latestReport === undefined
								? {}
								: { latestReport: activeUse.latestReport }),
							operationPayloadDigest: activeUse.operationPayloadDigest,
							processEpoch: activeUse.processEpoch,
							reason: 'process-epoch-lost',
							semanticOperationId: activeUse.semanticOperationId,
							startedAtMs: activeUse.startedAtMs,
							useId: activeUse.useId,
						});
					}
				}
				if (activeUses !== undefined) {
					leavesByPrincipal ??= new Map(state.leavesByPrincipal);
					leavesByPrincipal.set(principalKey, quarantineLeafForAmbiguousUse(leaf, activeUses));
				}
			}
			return leavesByPrincipal === undefined ? state : { ...state, leavesByPrincipal };
		}
		case 'begin-destruction': {
			requireExactParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind === 'destroying') {
				return state;
			}
			if (leaf.kind === 'owner-unsafe') {
				return transitionError(
					'leaf-not-destroying',
					'Owner-unsafe leaf requires an explicit exact retry path.',
				);
			}
			return replaceLeaf(state, {
				activeUses: leaf.activeUses,
				compatibility: leaf.compatibility,
				destructionReason: command.reason,
				kind: 'destroying',
				leaseId: leaf.leaseId,
				leafGeneration: leaf.leafGeneration,
				idleExpiresAtMs: leaf.idleExpiresAtMs,
				principal: leaf.principal,
				...('runtimeBinding' in leaf ? { runtimeBinding: leaf.runtimeBinding } : {}),
				...('sshBinding' in leaf ? { sshBinding: leaf.sshBinding } : {}),
			});
		}
		case 'destruction-incomplete': {
			requireExactParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'destroying') {
				return transitionError('leaf-not-destroying', `Leaf is '${leaf.kind}', not destroying.`);
			}
			return replaceLeaf(state, {
				activeUses: leaf.activeUses,
				compatibility: leaf.compatibility,
				kind: 'owner-unsafe',
				leaseId: leaf.leaseId,
				leafGeneration: leaf.leafGeneration,
				ownerUnsafeReason: command.reason,
				idleExpiresAtMs: leaf.idleExpiresAtMs,
				principal: leaf.principal,
				...(leaf.runtimeBinding === undefined ? {} : { runtimeBinding: leaf.runtimeBinding }),
				...(leaf.sshBinding === undefined ? {} : { sshBinding: leaf.sshBinding }),
			});
		}
		case 'retry-destruction': {
			requireExactParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'owner-unsafe') {
				return transitionError('leaf-not-destroying', `Leaf is '${leaf.kind}', not owner-unsafe.`);
			}
			return replaceLeaf(state, {
				activeUses: leaf.activeUses,
				compatibility: leaf.compatibility,
				destructionReason: command.reason,
				kind: 'destroying',
				leaseId: leaf.leaseId,
				leafGeneration: leaf.leafGeneration,
				idleExpiresAtMs: leaf.idleExpiresAtMs,
				principal: leaf.principal,
				...(leaf.runtimeBinding === undefined ? {} : { runtimeBinding: leaf.runtimeBinding }),
				...(leaf.sshBinding === undefined ? {} : { sshBinding: leaf.sshBinding }),
			});
		}
		case 'destruction-completed': {
			requireExactParent(state, command.authority.gateway);
			const leaf = requireLiveLeaf(state, command.authority);
			if (leaf.kind !== 'destroying') {
				return transitionError('leaf-not-destroying', `Leaf is '${leaf.kind}', not destroying.`);
			}
			if (
				command.vmId !== undefined &&
				leaf.runtimeBinding !== undefined &&
				command.vmId !== leaf.runtimeBinding.vmId
			) {
				return transitionError(
					'lease-identity-mismatch',
					'Destroyed VM identity does not match the controller runtime binding.',
				);
			}
			if (
				!state.tombstonesByGeneration.has(leaf.leafGeneration) &&
				state.tombstonesByGeneration.size >= state.retentionPolicy.maxLeafTombstones
			) {
				return transitionError(
					'tombstone-capacity-exhausted',
					'Leaf tombstone capacity is exhausted; prune expired entries first.',
				);
			}
			const leavesByPrincipal = new Map(state.leavesByPrincipal);
			leavesByPrincipal.delete(stablePrincipalKey(leaf.principal));
			const tombstonesByGeneration = new Map(state.tombstonesByGeneration);
			tombstonesByGeneration.set(leaf.leafGeneration, {
				destroyedAtMs: command.destroyedAtMs,
				expiresAtMs: command.destroyedAtMs + state.retentionPolicy.leafTombstoneTtlMs,
				gateway: structuredClone(command.authority.gateway),
				kind: 'destroyed',
				leaseId: leaf.leaseId,
				leafGeneration: leaf.leafGeneration,
				principal: leaf.principal,
				reason: command.reason,
				...(leaf.sshBinding === undefined ? {} : { sshBindingId: leaf.sshBinding.bindingId }),
				...(leaf.runtimeBinding === undefined ? {} : { vmId: leaf.runtimeBinding.vmId }),
			});
			return { ...state, leavesByPrincipal, tombstonesByGeneration };
		}
		case 'prune-tombstones': {
			const tombstonesByGeneration = new Map(
				[...state.tombstonesByGeneration.entries()].filter(
					([, tombstone]) => tombstone.expiresAtMs > command.nowMs,
				),
			);
			const terminalUseTombstones = new Map(
				[...state.terminalUseTombstones.entries()].filter(
					([, tombstone]) => tombstone.expiresAtMs > command.nowMs,
				),
			);
			if (
				tombstonesByGeneration.size === state.tombstonesByGeneration.size &&
				terminalUseTombstones.size === state.terminalUseTombstones.size
			) {
				return state;
			}
			return { ...state, terminalUseTombstones, tombstonesByGeneration };
		}
	}
	throw new Error('unsupported Tool VM lease authority command');
}
