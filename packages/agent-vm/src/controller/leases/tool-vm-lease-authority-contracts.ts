import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';

export interface StableToolVmLeasePrincipal {
	readonly agentId: string;
	readonly zoneId: string;
}

export interface ToolVmLeaseCompatibility {
	readonly policyFingerprint: string;
	readonly profileId: string;
	readonly purpose: string;
	readonly workMountDir: string;
}

export interface ToolVmLeafAuthorityReference {
	readonly gateway: GatewayEpochIdentity;
	readonly leaseId: string;
	readonly leafGeneration: string;
	readonly principal: StableToolVmLeasePrincipal;
}

export interface ToolVmRuntimeBinding {
	readonly runtimeRecordId: string;
	readonly tcpSlot: number;
	readonly vmId: string;
}

export interface ToolVmSshBinding {
	readonly bindingId: string;
	readonly host: string;
	readonly identityFile: string;
	readonly port: number;
	readonly serverIdentity: string;
	readonly user: string;
}

export interface ToolVmExactDestructionIdentity {
	readonly reservationId: string;
	readonly reservationPath: string;
	readonly targetIdentity: string;
	readonly vmId: string;
}

export interface ToolVmExactDestructionReceipt {
	readonly complete: boolean;
	readonly reservationId: string;
	readonly reservationPath: string;
	readonly targetIdentity: string;
	readonly vmId: string;
}

export interface ToolVmActiveUseLatestReport {
	readonly reportedAtMs: number;
	readonly sequence: number;
	readonly status: 'progress' | 'running';
	readonly summary: string;
}

interface ToolVmActiveUseIdentity {
	readonly latestReport?: ToolVmActiveUseLatestReport;
	readonly operationPayloadDigest: string;
	readonly processEpoch: string;
	readonly semanticOperationId: string;
	readonly startedAtMs: number;
	readonly useId: string;
}

export interface RunningToolVmActiveUse extends ToolVmActiveUseIdentity {
	readonly kind: 'running';
	readonly lastHeartbeatAtMs: number;
	readonly sessionAttachmentGeneration: number;
}

export interface ObservationGapToolVmActiveUse extends ToolVmActiveUseIdentity {
	readonly kind: 'observation-gap';
	readonly lastHeartbeatAtMs: number;
	readonly observedAtMs: number;
	readonly resumeDeadlineMs: number;
	readonly sessionAttachmentGeneration: number;
}

export interface AmbiguousToolVmActiveUse extends ToolVmActiveUseIdentity {
	readonly ambiguousAtMs: number;
	readonly kind: 'ambiguous';
	readonly reason: 'observation-gap-expired' | 'process-epoch-lost';
}

export interface TerminalToolVmActiveUse extends ToolVmActiveUseIdentity {
	readonly endedAtMs: number;
	readonly kind: 'terminal';
	readonly outcome: 'completed' | 'failed-observed';
}

export type ToolVmActiveUse =
	| RunningToolVmActiveUse
	| ObservationGapToolVmActiveUse
	| AmbiguousToolVmActiveUse
	| TerminalToolVmActiveUse;

interface ToolVmLeaseLeafBase {
	readonly activeUses: ReadonlyMap<string, ToolVmActiveUse>;
	readonly compatibility: ToolVmLeaseCompatibility;
	readonly destructionIdentity: ToolVmExactDestructionIdentity;
	readonly leaseId: string;
	readonly leafGeneration: string;
	readonly idleExpiresAtMs: number;
	readonly principal: StableToolVmLeasePrincipal;
}

export interface ProvisioningToolVmLeaseLeaf extends ToolVmLeaseLeafBase {
	readonly kind: 'provisioning';
}

interface BoundToolVmLeaseLeafBase extends ToolVmLeaseLeafBase {
	readonly runtimeBinding: ToolVmRuntimeBinding;
	readonly sshBinding: ToolVmSshBinding;
}

export interface CurrentToolVmLeaseLeaf extends BoundToolVmLeaseLeafBase {
	readonly kind: 'current';
}

export interface SuspectToolVmLeaseLeaf extends BoundToolVmLeaseLeafBase {
	readonly kind: 'suspect';
	readonly suspectReason: 'runtime' | 'ssh' | 'compatibility';
}

export interface QuarantinedToolVmLeaseLeaf extends ToolVmLeaseLeafBase {
	readonly kind: 'quarantined';
	readonly quarantineReason:
		| 'active-use-ambiguous'
		| 'containment-uncertain'
		| 'credential-uncertain';
	readonly runtimeBinding?: ToolVmRuntimeBinding;
	readonly sshBinding?: ToolVmSshBinding;
}

export interface DestroyingToolVmLeaseLeaf extends ToolVmLeaseLeafBase {
	readonly destructionReason: string;
	readonly kind: 'destroying';
	readonly runtimeBinding?: ToolVmRuntimeBinding;
	readonly sshBinding?: ToolVmSshBinding;
}

export interface OwnerUnsafeToolVmLeaseLeaf extends ToolVmLeaseLeafBase {
	readonly kind: 'owner-unsafe';
	readonly ownerUnsafeReason: string;
	readonly runtimeBinding?: ToolVmRuntimeBinding;
	readonly sshBinding?: ToolVmSshBinding;
}

export type ToolVmLeaseLeafState =
	| ProvisioningToolVmLeaseLeaf
	| CurrentToolVmLeaseLeaf
	| SuspectToolVmLeaseLeaf
	| QuarantinedToolVmLeaseLeaf
	| DestroyingToolVmLeaseLeaf
	| OwnerUnsafeToolVmLeaseLeaf;

export interface DestroyedToolVmLeaseLeafTombstone {
	readonly destroyedAtMs: number;
	readonly expiresAtMs: number;
	readonly gateway: GatewayEpochIdentity;
	readonly kind: 'destroyed';
	readonly leaseId: string;
	readonly leafGeneration: string;
	readonly principal: StableToolVmLeasePrincipal;
	readonly reason: string;
	readonly sshBindingId?: string;
	readonly vmId?: string;
}

export interface TerminalToolVmActiveUseTombstone {
	readonly endedAtMs: number;
	readonly expiresAtMs: number;
	readonly gateway: GatewayEpochIdentity;
	readonly leafGeneration: string;
	readonly latestReport?: ToolVmActiveUseLatestReport;
	readonly operationPayloadDigest: string;
	readonly outcome: TerminalToolVmActiveUse['outcome'];
	readonly principal: StableToolVmLeasePrincipal;
	readonly processEpoch: string;
	readonly semanticOperationId: string;
	readonly useId: string;
}

export interface ToolVmLeaseAuthorityRetentionPolicy {
	readonly leafTombstoneTtlMs: number;
	readonly maxLeafTombstones: number;
	readonly maxTerminalUseTombstones: number;
	readonly observationGapGraceMs: number;
	readonly terminalUseTombstoneTtlMs: number;
}

export type ToolVmLeaseParentState =
	| { readonly kind: 'unregistered' }
	| { readonly gateway: GatewayEpochIdentity; readonly kind: 'registered' }
	| { readonly gateway: GatewayEpochIdentity; readonly kind: 'sealed' }
	| { readonly gateway: GatewayEpochIdentity; readonly kind: 'retired' };

export interface ToolVmLeaseAuthorityState {
	readonly leavesByPrincipal: ReadonlyMap<string, ToolVmLeaseLeafState>;
	readonly parent: ToolVmLeaseParentState;
	readonly retentionPolicy: ToolVmLeaseAuthorityRetentionPolicy;
	readonly terminalUseTombstones: ReadonlyMap<string, TerminalToolVmActiveUseTombstone>;
	readonly tombstonesByGeneration: ReadonlyMap<string, DestroyedToolVmLeaseLeafTombstone>;
}

export type ToolVmLeaseAuthorityTransitionErrorCode =
	| 'active-use-conflict'
	| 'active-use-heartbeat-regressed'
	| 'active-use-not-found'
	| 'active-use-not-resumable'
	| 'active-use-report-regressed'
	| 'active-use-semantic-collision'
	| 'attachment-generation-regressed'
	| 'binding-not-authorized'
	| 'compatibility-conflict'
	| 'destruction-receipt-incomplete'
	| 'destruction-receipt-mismatch'
	| 'leaf-already-exists'
	| 'leaf-destroyed'
	| 'leaf-generation-mismatch'
	| 'leaf-generation-reused'
	| 'leaf-not-current'
	| 'leaf-not-destroying'
	| 'leaf-not-found'
	| 'leaf-not-provisioning'
	| 'idle-expiry-regressed'
	| 'lease-expired'
	| 'lease-identity-mismatch'
	| 'parent-already-registered'
	| 'parent-has-live-leaves'
	| 'parent-identity-mismatch'
	| 'parent-not-admitting'
	| 'parent-not-sealed'
	| 'parent-unregistered'
	| 'principal-mismatch'
	| 'process-epoch-mismatch'
	| 'observation-gap-expired'
	| 'observation-gap-not-expired'
	| 'tombstone-capacity-exhausted';

export class ToolVmLeaseAuthorityTransitionError extends Error {
	public constructor(
		public readonly code: ToolVmLeaseAuthorityTransitionErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ToolVmLeaseAuthorityTransitionError';
	}
}

export interface StartToolVmActiveUseInput {
	readonly lastHeartbeatAtMs: number;
	readonly operationPayloadDigest: string;
	readonly processEpoch: string;
	readonly semanticOperationId: string;
	readonly sessionAttachmentGeneration: number;
	readonly startedAtMs: number;
	readonly useId: string;
}

export type ToolVmLeaseAuthorityCommand =
	| { readonly gateway: GatewayEpochIdentity; readonly kind: 'register-parent' }
	| { readonly gateway: GatewayEpochIdentity; readonly kind: 'seal-parent' }
	| { readonly gateway: GatewayEpochIdentity; readonly kind: 'retire-parent' }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly compatibility: ToolVmLeaseCompatibility;
			readonly destructionIdentity: ToolVmExactDestructionIdentity;
			readonly kind: 'begin-provisioning';
			readonly idleExpiresAtMs: number;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'commit-current';
			readonly runtimeBinding: ToolVmRuntimeBinding;
			readonly sshBinding: ToolVmSshBinding;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'renew-idle-expiry';
			readonly nextIdleExpiresAtMs: number;
			readonly nowMs: number;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'mark-suspect';
			readonly reason: SuspectToolVmLeaseLeaf['suspectReason'];
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'restore-current';
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'quarantine';
			readonly reason: QuarantinedToolVmLeaseLeaf['quarantineReason'];
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'start-active-use';
			readonly use: StartToolVmActiveUseInput;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly heartbeatAtMs: number;
			readonly kind: 'heartbeat-active-use';
			readonly processEpoch: string;
			readonly report?: ToolVmActiveUseLatestReport;
			readonly sessionAttachmentGeneration: number;
			readonly useId: string;
	  }
	| {
			readonly gateway: GatewayEpochIdentity;
			readonly kind: 'session-disconnected';
			readonly observedAtMs: number;
			readonly processEpoch: string;
			readonly sessionAttachmentGeneration: number;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'resume-active-use';
			readonly lastHeartbeatAtMs: number;
			readonly nowMs: number;
			readonly processEpoch: string;
			readonly sessionAttachmentGeneration: number;
			readonly useId: string;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly endedAtMs: number;
			readonly kind: 'end-active-use';
			readonly outcome: TerminalToolVmActiveUse['outcome'];
			readonly processEpoch: string;
			readonly sessionAttachmentGeneration: number;
			readonly useId: string;
	  }
	| {
			readonly ambiguousAtMs: number;
			readonly authority: ToolVmLeafAuthorityReference;
			readonly expectedSessionAttachmentGeneration: number;
			readonly kind: 'expire-observation-gap';
			readonly nowMs: number;
			readonly useId: string;
	  }
	| {
			readonly ambiguousAtMs: number;
			readonly gateway: GatewayEpochIdentity;
			readonly kind: 'process-epoch-lost';
			readonly processEpoch: string;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'begin-destruction';
			readonly reason: string;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'destruction-incomplete';
			readonly reason: string;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly kind: 'retry-destruction';
			readonly reason: string;
	  }
	| {
			readonly authority: ToolVmLeafAuthorityReference;
			readonly destroyedAtMs: number;
			readonly kind: 'destruction-completed';
			readonly receipt: ToolVmExactDestructionReceipt;
			readonly reason: string;
	  }
	| { readonly kind: 'prune-tombstones'; readonly nowMs: number };

export interface AuthorizedToolVmLeafBinding {
	readonly leaseId: string;
	readonly leafGeneration: string;
	readonly idleExpiresAtMs: number;
	readonly runtimeBinding: ToolVmRuntimeBinding;
	readonly sshBinding: ToolVmSshBinding;
}
