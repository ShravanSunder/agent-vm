import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import {
	ToolVmLeaseAuthorityTransitionError,
	type CurrentToolVmLeaseLeaf,
	type DestroyedToolVmLeaseLeafTombstone,
	type QuarantinedToolVmLeaseLeaf,
	type StableToolVmLeasePrincipal,
	type SuspectToolVmLeaseLeaf,
	type ToolVmActiveUse,
	type ToolVmActiveUseLatestReport,
	type ToolVmExactDestructionReceipt,
	type ToolVmLeafAuthorityReference,
	type ToolVmLeaseAuthorityRetentionPolicy,
	type ToolVmLeaseAuthorityState,
	type ToolVmLeaseAuthorityTransitionErrorCode,
	type ToolVmLeaseCompatibility,
	type ToolVmLeaseLeafState,
	type ToolVmLeaseParentState,
} from './tool-vm-lease-authority-contracts.js';

const maximumActiveUseReportSummaryLength = 1_024;

export function transitionError(
	code: ToolVmLeaseAuthorityTransitionErrorCode,
	message: string,
): never {
	throw new ToolVmLeaseAuthorityTransitionError(code, message);
}

export function stablePrincipalKey(principal: StableToolVmLeasePrincipal): string {
	return `${principal.zoneId}\0${principal.agentId}`;
}

export function terminalUseTombstoneKey(
	authority: ToolVmLeafAuthorityReference,
	useId: string,
): string {
	return `${authority.gateway.gatewayEpochId}\0${stablePrincipalKey(authority.principal)}\0${authority.leafGeneration}\0${useId}`;
}

export function validateRetentionPolicy(policy: ToolVmLeaseAuthorityRetentionPolicy): void {
	for (const [name, value] of Object.entries(policy)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(
				`Tool VM lease authority retention policy '${name}' must be a positive integer.`,
			);
		}
	}
}

export function validateLatestReport(report: ToolVmActiveUseLatestReport): void {
	if (
		!Number.isSafeInteger(report.sequence) ||
		report.sequence < 0 ||
		report.summary.length > maximumActiveUseReportSummaryLength
	) {
		throw new Error('Tool VM active-use report is outside its bounded contract.');
	}
}

export function validateExactDestructionReceipt(
	leaf: ToolVmLeaseLeafState,
	receipt: ToolVmExactDestructionReceipt,
): void {
	if (!receipt.complete) {
		return transitionError(
			'destruction-receipt-incomplete',
			'Exact Tool VM destruction receipt is incomplete.',
		);
	}
	if (
		receipt.reservationId !== leaf.destructionIdentity.reservationId ||
		receipt.reservationPath !== leaf.destructionIdentity.reservationPath ||
		receipt.targetIdentity !== leaf.destructionIdentity.targetIdentity ||
		receipt.vmId !== leaf.destructionIdentity.vmId
	) {
		return transitionError(
			'destruction-receipt-mismatch',
			'Exact Tool VM destruction receipt does not match the retained target identity.',
		);
	}
}

function stablePrincipalsEqual(
	left: StableToolVmLeasePrincipal,
	right: StableToolVmLeasePrincipal,
): boolean {
	return left.zoneId === right.zoneId && left.agentId === right.agentId;
}

export function compatibilitiesEqual(
	left: ToolVmLeaseCompatibility,
	right: ToolVmLeaseCompatibility,
): boolean {
	return (
		left.policyFingerprint === right.policyFingerprint &&
		left.profileId === right.profileId &&
		left.purpose === right.purpose &&
		left.workMountDir === right.workMountDir
	);
}

export function requireExactParent(
	state: ToolVmLeaseAuthorityState,
	gateway: GatewayEpochIdentity,
): Exclude<ToolVmLeaseParentState, { readonly kind: 'unregistered' }> {
	if (state.parent.kind === 'unregistered') {
		return transitionError('parent-unregistered', 'Gateway parent is not registered.');
	}
	if (!gatewayIdentitiesEqual(state.parent.gateway, gateway)) {
		return transitionError(
			'parent-identity-mismatch',
			'Gateway parent identity does not match this lease authority state.',
		);
	}
	return state.parent;
}

export function requireAdmittingParent(
	state: ToolVmLeaseAuthorityState,
	gateway: GatewayEpochIdentity,
): Extract<ToolVmLeaseParentState, { readonly kind: 'registered' }> {
	const parent = requireExactParent(state, gateway);
	if (parent.kind !== 'registered') {
		return transitionError(
			'parent-not-admitting',
			`Gateway parent is '${parent.kind}' and cannot admit lease authority.`,
		);
	}
	return parent;
}

function tombstoneForAuthority(
	state: ToolVmLeaseAuthorityState,
	authority: ToolVmLeafAuthorityReference,
): DestroyedToolVmLeaseLeafTombstone | undefined {
	const tombstone = state.tombstonesByGeneration.get(authority.leafGeneration);
	if (tombstone === undefined) {
		return undefined;
	}
	if (!stablePrincipalsEqual(tombstone.principal, authority.principal)) {
		return transitionError(
			'principal-mismatch',
			'Leaf generation belongs to a different stable principal.',
		);
	}
	if (tombstone.leaseId !== authority.leaseId) {
		return transitionError(
			'lease-identity-mismatch',
			'Leaf tombstone belongs to a different controller-owned lease identity.',
		);
	}
	return tombstone;
}

export function requireLiveLeaf(
	state: ToolVmLeaseAuthorityState,
	authority: ToolVmLeafAuthorityReference,
): ToolVmLeaseLeafState {
	requireExactParent(state, authority.gateway);
	if (tombstoneForAuthority(state, authority) !== undefined) {
		return transitionError('leaf-destroyed', 'Leaf generation has been positively destroyed.');
	}
	const principalKey = stablePrincipalKey(authority.principal);
	const leaf = state.leavesByPrincipal.get(principalKey);
	if (leaf === undefined) {
		for (const candidateLeaf of state.leavesByPrincipal.values()) {
			if (candidateLeaf.leafGeneration === authority.leafGeneration) {
				return transitionError(
					'principal-mismatch',
					'Leaf generation belongs to a different stable principal.',
				);
			}
		}
		return transitionError('leaf-not-found', 'Stable principal has no live lease leaf.');
	}
	if (leaf.leafGeneration !== authority.leafGeneration) {
		return transitionError(
			'leaf-generation-mismatch',
			'Leaf generation does not match the stable principal current authority.',
		);
	}
	if (leaf.leaseId !== authority.leaseId) {
		return transitionError(
			'lease-identity-mismatch',
			'Lease identity does not match the stable principal current authority.',
		);
	}
	return leaf;
}

export function replaceLeaf(
	state: ToolVmLeaseAuthorityState,
	leaf: ToolVmLeaseLeafState,
): ToolVmLeaseAuthorityState {
	const leavesByPrincipal = new Map(state.leavesByPrincipal);
	leavesByPrincipal.set(stablePrincipalKey(leaf.principal), leaf);
	return { ...state, leavesByPrincipal };
}

export function nonTerminalActiveUseExists(
	activeUses: ReadonlyMap<string, ToolVmActiveUse>,
): boolean {
	return [...activeUses.values()].some((activeUse) => activeUse.kind !== 'terminal');
}

export function quarantineLeafForAmbiguousUse(
	leaf: CurrentToolVmLeaseLeaf | SuspectToolVmLeaseLeaf,
	activeUses: ReadonlyMap<string, ToolVmActiveUse>,
): QuarantinedToolVmLeaseLeaf {
	return {
		...leaf,
		activeUses,
		kind: 'quarantined',
		quarantineReason: 'active-use-ambiguous',
	};
}
