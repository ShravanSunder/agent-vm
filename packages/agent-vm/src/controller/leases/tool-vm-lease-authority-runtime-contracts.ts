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
	readonly cleanup: () => Promise<void>;
	readonly destroyedAtMs: number;
	readonly fenceAccess: () => Promise<void>;
	readonly reason: string;
}

export interface ToolVmExactDestructionProgress<TLease extends ToolVmRuntimeLeaseIdentity> {
	readonly accessFenced: Promise<void>;
	readonly completion: Promise<ToolVmLeaseRuntimeResource<TLease>>;
}

export type ToolVmExactDestructionAdmission<TLease extends ToolVmRuntimeLeaseIdentity> =
	| { readonly kind: 'blocked-active-use' }
	| { readonly kind: 'skip-recently-used' }
	| {
			readonly accessFenced: Promise<void>;
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
	authorityForCurrentAgent(options: {
		readonly agentId: string;
		readonly gateway: GatewayEpochIdentity;
	}): ToolVmLeafAuthorityReference | undefined;
	authorityForPrincipal(options: {
		readonly gateway: GatewayEpochIdentity;
		readonly principal: StableToolVmLeasePrincipal;
	}): ToolVmLeafAuthorityReference | undefined;
	cleanupContextForAuthority(authority: ToolVmLeafAuthorityReference): TCleanupContext | undefined;
	cleanupContextForLease(leaseId: string): TCleanupContext | undefined;
	beginProvisioning(options: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly cleanupContext?: TCleanupContext;
		readonly compatibility: ToolVmLeaseCompatibility;
		readonly idleExpiresAtMs: number;
	}): void;
	commitCurrent(options: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly lease: TLease;
		readonly runtimeBinding: ToolVmRuntimeBinding;
		readonly sshBinding: ToolVmSshBinding;
	}): Promise<void>;
	destroyExact(options: ToolVmExactDestructionOptions): ToolVmExactDestructionProgress<TLease>;
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
	registerGateway(gateway: GatewayEpochIdentity): void;
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
