import type { ManagedVmDestroyReceiptV1 } from '@agent-vm/gondolin-adapter';

import type {
	ProvisionalToolVmOwnershipHandle,
	ToolVmProvisionalOwnershipProof,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import type {
	StableToolVmLeasePrincipal,
	ToolVmLeafAuthorityReference,
	ToolVmLeaseAuthorityCommand,
	ToolVmLeaseCompatibility,
	ToolVmLeaseLeafState,
	ToolVmRuntimeBinding,
	ToolVmSshBinding,
	ToolVmActiveUse,
} from './tool-vm-lease-authority-state.js';

export interface ToolVmRuntimeLeaseIdentity {
	readonly agentId: string;
	readonly id: string;
	readonly lastUsedAt: number;
	readonly vm: { readonly id: string };
	readonly zoneId: string;
}

export type ToolVmExactDestructionAdmissionPolicy =
	| { readonly kind: 'force' }
	| {
			readonly ifLastUsedAtBeforeOrAt?: number;
			readonly kind: 'require-no-active-use';
	  };

export interface ToolVmExactDestructionOptions {
	readonly authority: ToolVmLeafAuthorityReference;
	readonly destroyedAtMs: number;
	readonly mode:
		| { readonly kind: 'detached' }
		| {
				readonly closeLiveVm: () => Promise<ManagedVmDestroyReceiptV1>;
				readonly kind: 'live';
		  };
	readonly reason: string;
}

export type ToolVmExactDestructionAdmission<TLease extends ToolVmRuntimeLeaseIdentity> =
	| { readonly kind: 'blocked-active-use' }
	| { readonly kind: 'skip-recently-used' }
	| {
			readonly completion: Promise<ToolVmLeaseRuntimeResource<TLease>>;
			readonly kind: 'started';
	  };

export type RuntimeForwardedAuthorityCommand = Exclude<
	ToolVmLeaseAuthorityCommand,
	| { readonly kind: 'begin-provisioning' }
	| { readonly kind: 'commit-current' }
	| { readonly kind: 'renew-idle-expiry' }
	| { readonly kind: 'begin-destruction' }
	| { readonly kind: 'destruction-completed' }
	| { readonly kind: 'destruction-incomplete' }
	| { readonly kind: 'retry-destruction' }
	| { readonly kind: 'register-parent' }
	| { readonly kind: 'retire-parent' }
	| { readonly kind: 'seal-parent' }
>;

export interface ToolVmLeaseRuntimeResource<TLease extends ToolVmRuntimeLeaseIdentity> {
	readonly authority: ToolVmLeafAuthorityReference;
	readonly lease?: TLease;
	readonly ownership: ProvisionalToolVmOwnershipHandle;
	readonly ownershipProof: ToolVmProvisionalOwnershipProof;
}

export class RejectedToolVmProvisioningCleanupError extends AggregateError {
	public constructor(
		public readonly cleanupId: string,
		authorityError: unknown,
		cleanupError: unknown,
	) {
		super(
			[authorityError, cleanupError],
			'Rejected Tool VM authority could not prove exact reservation cleanup.',
		);
		this.cause = authorityError;
		this.name = 'RejectedToolVmProvisioningCleanupError';
	}
}

export interface ToolVmLeaseAuthorityRuntime<
	TLease extends ToolVmRuntimeLeaseIdentity,
	TCleanupContext = never,
> {
	activeUseCount(leaseId: string): number;
	activeUseSnapshots(leaseId: string): readonly ToolVmActiveUse[];
	admitExactDestruction(
		options: ToolVmExactDestructionOptions & {
			readonly policy: ToolVmExactDestructionAdmissionPolicy;
		},
	): ToolVmExactDestructionAdmission<TLease>;
	applyAuthorityCommand(
		command: RuntimeForwardedAuthorityCommand,
	): ToolVmLeaseLeafState | undefined;
	authorityForLease(leaseId: string): ToolVmLeafAuthorityReference | undefined;
	authorityForPrincipal(
		principal: StableToolVmLeasePrincipal,
	): ToolVmLeafAuthorityReference | undefined;
	cleanupContextForAuthority(authority: ToolVmLeafAuthorityReference): TCleanupContext | undefined;
	cleanupContextForLease(leaseId: string): TCleanupContext | undefined;
	beginProvisioning(options: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly cleanupContext?: TCleanupContext;
		readonly compatibility: ToolVmLeaseCompatibility;
		readonly idleExpiresAtMs: number;
		readonly ownership: ProvisionalToolVmOwnershipHandle;
	}): Promise<ToolVmProvisionalOwnershipProof>;
	commitCurrent(options: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly lease: TLease;
		readonly runtimeBinding: ToolVmRuntimeBinding;
		readonly sshBinding: ToolVmSshBinding;
	}): Promise<void>;
	destroyExact(options: ToolVmExactDestructionOptions): Promise<ToolVmLeaseRuntimeResource<TLease>>;
	findCurrentLeaseByPrincipal(options: {
		readonly gateway: GatewayEpochIdentity;
		readonly principal: StableToolVmLeasePrincipal;
	}): TLease | undefined;
	getCleanupLease(leaseId: string): TLease | undefined;
	getLease(leaseId: string): TLease | undefined;
	getRetainedLease(leaseId: string): TLease | undefined;
	leaseIdsOwnedByGateway(gateway: GatewayEpochIdentity): readonly string[];
	leafSnapshotForLease(leaseId: string): ToolVmLeaseLeafState | undefined;
	listLeases(): readonly TLease[];
	rejectedCleanupAuthority(cleanupId: string): ToolVmLeafAuthorityReference | undefined;
	rejectedCleanupIdForPrincipal(principal: StableToolVmLeasePrincipal): string | undefined;
	rejectedCleanupIdsOwnedByGateway(gateway: GatewayEpochIdentity): readonly string[];
	registerGateway(gateway: GatewayEpochIdentity): void;
	retryRejectedProvisioningCleanup(cleanupId: string): Promise<TCleanupContext | undefined>;
	retireGateway(gateway: GatewayEpochIdentity): void;
	sealGateway(gateway: GatewayEpochIdentity): void;
	setCleanupContext(authority: ToolVmLeafAuthorityReference, context: TCleanupContext): void;
	touchLease(
		authority: ToolVmLeafAuthorityReference,
		nowMs: number,
		nextIdleExpiresAtMs: number,
		updateLease: (lease: TLease) => TLease,
	): TLease;
}
