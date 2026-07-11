import { createHash, randomUUID } from 'node:crypto';

import {
	createToolVmLeaseId,
	isToolVmActiveUseId,
	normalizeToolVmActiveUseCorrelation,
	type EndToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseResponse,
	type StartToolVmActiveUseRequest,
	type StartToolVmActiveUseResponse,
	type ToolVmActiveUseCorrelation,
	type ToolVmActiveUseOperationReport,
} from '@agent-vm/gateway-interface';
import type {
	ManagedVm,
	SshServerHostKey,
	VmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';

import type { readProcessIdentity as defaultReadProcessIdentity } from '../../shared/managed-vm-process.js';
import { containsUnprovenVmDestructionError } from '../../shared/vm-destruction-receipt.js';
import { settleGatewayChildDestructionTasks } from '../vm-ownership/gateway-child-destruction.js';
import type { GatewayOwnershipCoordinator } from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { ZoneGitToolVmMount } from '../zone-git/zone-git-paths.js';
import { createAgentLeaseOperationLock } from './agent-lease-operation-lock.js';
import { defaultToolVmLeaseIdleTtlMs } from './lease-idle-policy.js';
import { createPendingToolVmCleanupRegistry } from './pending-tool-vm-cleanup-registry.js';
import type { TcpPool } from './tcp-pool.js';
import {
	createToolVmLeaseAuthorityRuntime,
	RejectedToolVmProvisioningCleanupError,
} from './tool-vm-lease-authority-runtime.js';
import type {
	StableToolVmLeasePrincipal,
	ToolVmLeafAuthorityReference,
	ToolVmLeaseCompatibility,
} from './tool-vm-lease-authority-state.js';
import { createToolVmLeaseCreationRegistry } from './tool-vm-lease-creation-registry.js';
import { classifyToolVmLeaseRenewal, isToolVmLeaseExpired } from './tool-vm-lease-lifecycle.js';
import { isToolVmLeaseVmLive } from './tool-vm-lease-liveness.js';
import {
	buildToolVmRuntimeRecord,
	deleteToolVmRuntimeRecord,
	writeToolVmRuntimeRecord,
} from './tool-vm-runtime-record.js';

export interface ToolVmProfile {
	readonly cpus: number;
	readonly imageProfile: string;
	readonly memory: string;
	readonly runtimeRootfsSize?: string | undefined;
}

export interface Lease {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly createdAt: number;
	readonly effectiveIdleTtlMs: number;
	readonly guestWorkdir: string;
	readonly id: string;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly runtimeRecordId: string;
	readonly sshAccess: {
		readonly command?: string;
		readonly host: string;
		readonly identityFile?: string;
		readonly port: number;
		readonly serverHostKey: SshServerHostKey;
		readonly user?: string;
	};
	readonly tcpSlot: number;
	readonly vm: ManagedVm;
	readonly hostWorkMountDir: string;
	readonly zoneGitMount?: ZoneGitToolVmMount;
	readonly zoneId: string;
}

interface ToolVmLeaseCleanupContext {
	readonly persistedRuntimeRecord?: {
		readonly recordId: string;
		readonly stateDirectory: string;
	};
	readonly tcpSlot: number;
	readonly vm?: ManagedVm;
}

export type LeaseRenewal =
	| {
			readonly kind: 'renewed';
			readonly lastUsedAt: number;
			readonly lease: Lease;
	  }
	| {
			readonly kind: 'not-found';
			readonly reason: 'dead' | 'expired' | 'missing';
	  };

export interface LeaseSnapshot {
	readonly kind: 'snapshot';
	readonly lease: Lease;
}

export interface ToolVmActiveUseSnapshot {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly expiresAt: number;
	readonly latestReport?: ToolVmActiveUseOperationReport;
	readonly leaseId: string;
	readonly startedAt: number;
	readonly useId: string;
}

export type ToolVmLeaseRetirementReason = 'dead' | 'expired' | 'released';

export interface ToolVmLeaseRetirementEvent {
	readonly leaseId: string;
	readonly reason: ToolVmLeaseRetirementReason;
}

export interface ToolVmLeaseRequestAuthority {
	readonly gateway: GatewayEpochIdentity;
	readonly principal: StableToolVmLeasePrincipal;
}

export interface ToolVmLeaseActiveUseExecutionProof {
	readonly operationPayloadDigest: string;
	readonly processEpoch: string;
	readonly semanticOperationId: string;
	readonly sessionAttachmentGeneration: number;
}

export interface ToolVmLeaseCreateOptions {
	readonly agentId: string;
	readonly agentWorkspaceDir: string;
	readonly effectiveIdleTtlMs?: number;
	readonly expectedGateway: GatewayEpochIdentity;
	readonly gatewayWorkMountDir: string;
	readonly guestWorkdir: string;
	readonly hostWorkMountDir: string;
	readonly profile: ToolVmProfile;
	readonly profileId: string;
	readonly zoneGitMount?: ZoneGitToolVmMount;
	readonly zoneId: string;
}

export interface LeaseManager {
	createLease(options: ToolVmLeaseCreateOptions): Promise<Lease>;
	destroyGatewayOwnedLeases(
		expectedGateway: GatewayEpochIdentity,
		signal?: AbortSignal,
	): Promise<void>;
	endActiveUse(
		leaseId: string,
		useId: string,
		request: EndToolVmActiveUseRequest &
			Pick<ToolVmLeaseActiveUseExecutionProof, 'processEpoch' | 'sessionAttachmentGeneration'> & {
				readonly authority: ToolVmLeaseRequestAuthority;
			},
	): { readonly kind: 'ended' | 'unknown-use' } | undefined;
	getActiveUses(leaseId: string): readonly ToolVmActiveUseSnapshot[];
	getActiveUseCount(leaseId: string): number;
	getLeaseAuthority(leaseId: string):
		| {
				readonly authority: ToolVmLeafAuthorityReference;
				readonly compatibility: ToolVmLeaseCompatibility;
		  }
		| undefined;
	heartbeatActiveUse(
		leaseId: string,
		useId: string,
		request: HeartbeatToolVmActiveUseRequest &
			Pick<ToolVmLeaseActiveUseExecutionProof, 'processEpoch' | 'sessionAttachmentGeneration'> & {
				readonly authority: ToolVmLeaseRequestAuthority;
			},
	): HeartbeatToolVmActiveUseResponse | undefined;
	renewLease(leaseId: string): Promise<LeaseRenewal>;
	listLeases(): readonly Lease[];
	peekLease(leaseId: string): LeaseSnapshot | undefined;
	reapDeadIdleLeases(): Promise<void>;
	reapExpiredActiveUses(): void;
	releaseLease(
		leaseId: string,
		options?: { readonly force?: boolean; readonly ifLastUsedAtBeforeOrAt?: number },
	): Promise<void>;
	startActiveUse(
		leaseId: string,
		request: StartToolVmActiveUseRequest &
			ToolVmLeaseActiveUseExecutionProof & { readonly authority: ToolVmLeaseRequestAuthority },
	): StartToolVmActiveUseResponse | undefined;
	subscribeLeaseRetirement(listener: (event: ToolVmLeaseRetirementEvent) => void): () => void;
}

export class AgentLeaseCompatibilityConflictError extends Error {
	public constructor(
		message: string,
		public readonly mismatchedFields: readonly string[],
	) {
		super(message);
		this.name = 'AgentLeaseCompatibilityConflictError';
	}
}
export class LeaseActiveUseConflictError extends Error {}

export interface ToolVmUsePolicy {
	readonly endedUseTombstoneTtlMs: number;
	readonly heartbeatAfterMs: number;
	readonly heartbeatStaleMs: number;
}

const defaultToolVmUsePolicy = {
	endedUseTombstoneTtlMs: 10 * 60 * 1000,
	heartbeatAfterMs: 30 * 1000,
	heartbeatStaleMs: 2 * 60 * 1000,
} satisfies ToolVmUsePolicy;
const leaseAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

function assertValidLeaseAgentId(agentId: string): void {
	if (!leaseAgentIdPattern.test(agentId)) {
		throw new Error(
			`Invalid Tool VM lease agentId '${agentId}': expected an OpenClaw agent id matching /^[a-z0-9][a-z0-9_-]{0,63}$/i.`,
		);
	}
}

function assertValidToolVmUsePolicy(policy: ToolVmUsePolicy): void {
	if (policy.heartbeatAfterMs <= 0) {
		throw new Error('Tool VM active-use heartbeatAfterMs must be positive.');
	}
	if (policy.heartbeatStaleMs < policy.heartbeatAfterMs * 3) {
		throw new Error('Tool VM active-use heartbeatStaleMs must be at least 3x heartbeatAfterMs.');
	}
	if (policy.endedUseTombstoneTtlMs <= 0) {
		throw new Error('Tool VM active-use endedUseTombstoneTtlMs must be positive.');
	}
}

function formatLeaseManagerError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeLeaseManagerWarning(message: string): void {
	process.stderr.write(`[lease-manager] ${message}\n`);
}

function assertCompatibleAgentLeaseRequest(
	existingLease: Lease,
	requestedLease: {
		readonly agentWorkspaceDir: string;
		readonly effectiveIdleTtlMs?: number;
		readonly guestWorkdir: string;
		readonly hostWorkMountDir: string;
		readonly profileId: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
	},
): void {
	const mismatchedFields: string[] = [];
	if (
		requestedLease.effectiveIdleTtlMs !== undefined &&
		existingLease.effectiveIdleTtlMs !== requestedLease.effectiveIdleTtlMs
	) {
		mismatchedFields.push('effectiveIdleTtlMs');
	}
	if (existingLease.profileId !== requestedLease.profileId) {
		mismatchedFields.push('profileId');
	}
	if (existingLease.hostWorkMountDir !== requestedLease.hostWorkMountDir) {
		mismatchedFields.push('hostWorkMountDir');
	}
	if (existingLease.guestWorkdir !== requestedLease.guestWorkdir) {
		mismatchedFields.push('guestWorkdir');
	}
	if (!zoneGitMountsEqual(existingLease.zoneGitMount, requestedLease.zoneGitMount)) {
		mismatchedFields.push('zoneGitMount');
	}
	if (existingLease.agentWorkspaceDir !== requestedLease.agentWorkspaceDir) {
		mismatchedFields.push('agentWorkspaceDir');
	}
	if (mismatchedFields.length > 0) {
		throw new AgentLeaseCompatibilityConflictError(
			`existing Tool VM lease for agent '${existingLease.agentId}' is not compatible with this request; mismatched fields: ${mismatchedFields.join(', ')}`,
			mismatchedFields,
		);
	}
}

function zoneGitMountsEqual(
	leftMount: ZoneGitToolVmMount | undefined,
	rightMount: ZoneGitToolVmMount | undefined,
): boolean {
	if (!leftMount || !rightMount) {
		return leftMount === rightMount;
	}
	return (
		leftMount.hostZoneFilesDir === rightMount.hostZoneFilesDir &&
		leftMount.hostZoneGitRoot === rightMount.hostZoneGitRoot
	);
}

function toolVmLeasePolicyFingerprint(options: {
	readonly agentWorkspaceDir: string;
	readonly effectiveIdleTtlMs: number;
	readonly guestWorkdir: string;
	readonly hostWorkMountDir: string;
	readonly profile: ToolVmProfile;
	readonly zoneGitMount?: ZoneGitToolVmMount;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				agentWorkspaceDir: options.agentWorkspaceDir,
				effectiveIdleTtlMs: options.effectiveIdleTtlMs,
				guestWorkdir: options.guestWorkdir,
				hostWorkMountDir: options.hostWorkMountDir,
				profile: options.profile,
				zoneGitMount: options.zoneGitMount ?? null,
			}),
			'utf8',
		)
		.digest('hex');
}

export function resolveToolVmLeaseCompatibility(
	leaseOptions: ToolVmLeaseCreateOptions,
): ToolVmLeaseCompatibility {
	const effectiveIdleTtlMs = leaseOptions.effectiveIdleTtlMs ?? defaultToolVmLeaseIdleTtlMs;
	return {
		policyFingerprint: toolVmLeasePolicyFingerprint({
			agentWorkspaceDir: leaseOptions.agentWorkspaceDir,
			effectiveIdleTtlMs,
			guestWorkdir: leaseOptions.guestWorkdir,
			hostWorkMountDir: leaseOptions.hostWorkMountDir,
			profile: leaseOptions.profile,
			...(leaseOptions.zoneGitMount === undefined
				? {}
				: { zoneGitMount: leaseOptions.zoneGitMount }),
		}),
		profileId: leaseOptions.profileId,
		purpose: 'tool_vm_lease',
		workMountDir: leaseOptions.gatewayWorkMountDir,
	};
}

function stableToolVmLeasePrincipal(agentLease: {
	readonly agentId: string;
	readonly zoneId: string;
}): StableToolVmLeasePrincipal {
	return { agentId: agentLease.agentId, zoneId: agentLease.zoneId };
}

function createToolVmLeaseRetainedCleanupError(options: {
	readonly agentId: string;
	readonly cleanupError: unknown;
	readonly creationError: unknown;
	readonly zoneId: string;
}): AggregateError {
	return new AggregateError(
		[options.creationError, options.cleanupError],
		`Tool VM lease creation failed and exact retained cleanup was not proven for zone '${options.zoneId}' agent '${options.agentId}'.`,
		{ cause: options.cleanupError },
	);
}

export function createLeaseManager(options: {
	readonly controllerPort: number;
	readonly createLeaseId?: () => string;
	readonly createLeafGeneration?: () => string;
	readonly createRuntimeRecordId?: () => string;
	readonly createManagedVm: (leaseOptions: {
		readonly agentWorkspaceDir: string;
		readonly effectiveIdleTtlMs?: number;
		readonly agentId: string;
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly tcpSlot: number;
		readonly guestWorkdir: string;
		readonly hostWorkMountDir: string;
		readonly ownershipReservation: VmOwnershipReservationReferenceV1;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly deleteToolVmRuntimeRecord?: typeof deleteToolVmRuntimeRecord;
	readonly now: () => number;
	readonly ownershipCoordinator: GatewayOwnershipCoordinator;
	readonly projectNamespace: string;
	// Injected for tests so we don't shell out to `ps` against a fake pid.
	// Production uses the default real implementation.
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly stateDirFor: (zoneId: string) => string;
	readonly systemConfigPath: string;
	readonly tcpPool: TcpPool;
	readonly toolVmUsePolicy?: ToolVmUsePolicy;
	readonly writeToolVmRuntimeRecord?: typeof writeToolVmRuntimeRecord;
}): LeaseManager {
	const leaseRetirementListeners = new Set<(event: ToolVmLeaseRetirementEvent) => void>();
	const agentLeaseOperationLock = createAgentLeaseOperationLock();
	const toolVmUsePolicy = options.toolVmUsePolicy ?? defaultToolVmUsePolicy;
	assertValidToolVmUsePolicy(toolVmUsePolicy);
	const authorityRuntime = createToolVmLeaseAuthorityRuntime<Lease, ToolVmLeaseCleanupContext>({
		retentionPolicy: {
			observationGapGraceMs: toolVmUsePolicy.heartbeatStaleMs,
			terminalUseTombstoneTtlMs: toolVmUsePolicy.endedUseTombstoneTtlMs,
		},
	});
	const leaseCreationRegistry = createToolVmLeaseCreationRegistry();

	function findLeaseForAgent(agentLease: {
		readonly agentId: string;
		readonly expectedGateway: GatewayEpochIdentity;
		readonly zoneId: string;
	}): Lease | undefined {
		return authorityRuntime.findCurrentLeaseByPrincipal({
			gateway: agentLease.expectedGateway,
			principal: stableToolVmLeasePrincipal(agentLease),
		});
	}

	function touchLease(lease: Lease): Lease {
		const authority = authorityRuntime.authorityForLease(lease.id);
		if (authority === undefined) {
			throw new Error(`Tool VM lease '${lease.id}' has no current authority.`);
		}
		const nowMs = options.now();
		if (nowMs <= lease.lastUsedAt) {
			return lease;
		}
		return authorityRuntime.touchLease(
			authority,
			nowMs,
			nowMs + lease.effectiveIdleTtlMs,
			(currentLease) => ({ ...currentLease, lastUsedAt: nowMs }),
		);
	}

	function assertLeaseGatewayAdmitting(lease: Lease): void {
		const expectedGateway = authorityRuntime.authorityForLease(lease.id)?.gateway;
		if (expectedGateway === undefined) {
			throw new Error(`Tool VM lease '${lease.id}' has no current Gateway VM ownership.`);
		}
		const resolvedGateway = options.ownershipCoordinator.resolveGatewayEpoch({
			bootId: expectedGateway.bootId,
			controllerEpoch: expectedGateway.controllerEpoch,
			zoneId: expectedGateway.zoneId,
		});
		if (!gatewayIdentitiesEqual(resolvedGateway, expectedGateway)) {
			throw new Error(`Tool VM lease '${lease.id}' belongs to a stale Gateway VM epoch.`);
		}
	}

	function requireAuthorizedLeaseAuthority(optionsToAuthorize: {
		readonly authority: ToolVmLeaseRequestAuthority;
		readonly leaseId: string;
	}): ToolVmLeafAuthorityReference {
		const authority = authorityRuntime.authorityForLease(optionsToAuthorize.leaseId);
		if (
			authority === undefined ||
			!gatewayIdentitiesEqual(authority.gateway, optionsToAuthorize.authority.gateway) ||
			authority.principal.agentId !== optionsToAuthorize.authority.principal.agentId ||
			authority.principal.zoneId !== optionsToAuthorize.authority.principal.zoneId
		) {
			throw new Error(`Tool VM lease '${optionsToAuthorize.leaseId}' authority is not current.`);
		}
		return authority;
	}

	function activeUseCountForLease(leaseId: string): number {
		return authorityRuntime.activeUseCount(leaseId);
	}

	function notifyLeaseRetired(event: ToolVmLeaseRetirementEvent): void {
		for (const listener of leaseRetirementListeners) {
			listener(event);
		}
	}

	function isLeaseExpired(lease: Lease): boolean {
		return isToolVmLeaseExpired({
			activeUseCount: activeUseCountForLease(lease.id),
			effectiveIdleTtlMs: lease.effectiveIdleTtlMs,
			lastUsedAt: lease.lastUsedAt,
			nowMs: options.now(),
		});
	}

	const writeRuntimeRecord = options.writeToolVmRuntimeRecord ?? writeToolVmRuntimeRecord;
	const deleteRuntimeRecord = options.deleteToolVmRuntimeRecord ?? deleteToolVmRuntimeRecord;
	const createLeaseId = options.createLeaseId ?? createToolVmLeaseId;
	const createRuntimeRecordId = options.createRuntimeRecordId ?? randomUUID;
	const releaseTcpSlotAfterCompleteDestruction = (tcpSlot: number): void => {
		options.tcpPool.release(tcpSlot);
		options.tcpPool.releaseQuarantined(tcpSlot);
	};
	const pendingCleanupRegistry = createPendingToolVmCleanupRegistry({
		deleteRuntimeRecord,
		releaseTcpSlotAfterCompleteDestruction,
		writeWarning: writeLeaseManagerWarning,
	});

	async function retryPendingCleanup(
		agentIdentity: {
			readonly agentId: string;
			readonly zoneId: string;
		},
		expectedGateway: GatewayEpochIdentity,
	): Promise<void> {
		await pendingCleanupRegistry.retry(agentIdentity, expectedGateway);
	}

	async function retryRejectedProvisioningCleanup(cleanupId: string): Promise<void> {
		const cleanupContext = await authorityRuntime.retryRejectedProvisioningCleanup(cleanupId);
		if (cleanupContext !== undefined) {
			releaseTcpSlotAfterCompleteDestruction(cleanupContext.tcpSlot);
		}
	}

	async function destroyRetainedLease(optionsToDestroy: {
		readonly lease: Lease;
		readonly notifyRetirement: boolean;
		readonly reason: ToolVmLeaseRetirementReason | 'create-retry';
	}): Promise<void> {
		const { lease, reason } = optionsToDestroy;
		const authority = authorityRuntime.authorityForLease(lease.id);
		if (authority === undefined) {
			return;
		}
		try {
			await authorityRuntime.destroyExact({
				authority,
				destroyedAtMs: options.now(),
				mode: { closeLiveVm: async () => await lease.vm.close(), kind: 'live' },
				reason,
			});
		} catch (error) {
			options.tcpPool.quarantine(lease.tcpSlot);
			writeLeaseManagerWarning(
				`failed to close evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${lease.tcpSlot} and preserving runtime record for next-startup cleanup.`,
			);
			throw error;
		}
		if (optionsToDestroy.notifyRetirement && reason !== 'create-retry') {
			notifyLeaseRetired({ leaseId: lease.id, reason });
		}
		releaseTcpSlotAfterCompleteDestruction(lease.tcpSlot);
		try {
			await deleteRuntimeRecord(options.stateDirFor(lease.zoneId), lease.runtimeRecordId);
		} catch (deleteError) {
			writeLeaseManagerWarning(
				`failed to delete tool VM runtime record for evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(deleteError)}`,
			);
		}
	}

	async function destroyProvisionalAuthority(optionsToDestroy: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly reason: string;
	}): Promise<void> {
		const cleanupContext = authorityRuntime.cleanupContextForLease(
			optionsToDestroy.authority.leaseId,
		);
		if (cleanupContext === undefined) {
			throw new Error(
				`Tool VM leaf '${optionsToDestroy.authority.leafGeneration}' has no retained cleanup context.`,
			);
		}
		const cleanupVm = cleanupContext.vm;
		try {
			await authorityRuntime.destroyExact({
				authority: optionsToDestroy.authority,
				destroyedAtMs: options.now(),
				mode:
					cleanupVm === undefined
						? { kind: 'detached' }
						: {
								closeLiveVm: async () => await cleanupVm.close(),
								kind: 'live',
							},
				reason: optionsToDestroy.reason,
			});
		} catch (error) {
			options.tcpPool.quarantine(cleanupContext.tcpSlot);
			throw error;
		}
		releaseTcpSlotAfterCompleteDestruction(cleanupContext.tcpSlot);
		if (cleanupContext.persistedRuntimeRecord !== undefined) {
			await deleteRuntimeRecord(
				cleanupContext.persistedRuntimeRecord.stateDirectory,
				cleanupContext.persistedRuntimeRecord.recordId,
			);
		}
	}

	async function evictLease(lease: Lease, reason: ToolVmLeaseRetirementReason): Promise<void> {
		await destroyRetainedLease({ lease, notifyRetirement: true, reason });
	}

	return {
		async createLease(leaseOptions) {
			const finishTrackingCreation = leaseCreationRegistry.trackCreation({
				agentId: leaseOptions.agentId,
				gatewayIdentity: leaseOptions.expectedGateway,
				zoneId: leaseOptions.zoneId,
			});
			try {
				return await agentLeaseOperationLock.runExclusive(leaseOptions, async () => {
					assertValidLeaseAgentId(leaseOptions.agentId);
					const principal = stableToolVmLeasePrincipal(leaseOptions);
					let retainedAuthority = authorityRuntime.authorityForPrincipal(principal);
					const rejectedCleanupId = authorityRuntime.rejectedCleanupIdForPrincipal(principal);
					const rejectedCleanupAuthority =
						rejectedCleanupId === undefined
							? undefined
							: authorityRuntime.rejectedCleanupAuthority(rejectedCleanupId);
					const pendingGateway = pendingCleanupRegistry.pendingGatewayIdentityForAgent(principal);
					if (
						(retainedAuthority !== undefined &&
							!gatewayIdentitiesEqual(retainedAuthority.gateway, leaseOptions.expectedGateway)) ||
						(pendingGateway !== undefined &&
							!gatewayIdentitiesEqual(pendingGateway, leaseOptions.expectedGateway)) ||
						(rejectedCleanupAuthority !== undefined &&
							!gatewayIdentitiesEqual(
								rejectedCleanupAuthority.gateway,
								leaseOptions.expectedGateway,
							))
					) {
						throw new Error(
							`Stable principal '${leaseOptions.zoneId}/${leaseOptions.agentId}' retains Tool VM authority under a different Gateway VM epoch.`,
						);
					}
					authorityRuntime.registerGateway(leaseOptions.expectedGateway);
					await retryPendingCleanup(leaseOptions, leaseOptions.expectedGateway);
					if (rejectedCleanupId !== undefined) {
						await retryRejectedProvisioningCleanup(rejectedCleanupId);
						retainedAuthority = authorityRuntime.authorityForPrincipal(principal);
					}
					const existingLease = findLeaseForAgent({
						agentId: leaseOptions.agentId,
						expectedGateway: leaseOptions.expectedGateway,
						zoneId: leaseOptions.zoneId,
					});
					if (existingLease) {
						assertLeaseGatewayAdmitting(existingLease);
						const existingGatewayIdentity = authorityRuntime.authorityForLease(
							existingLease.id,
						)?.gateway;
						if (
							existingGatewayIdentity === undefined ||
							!gatewayIdentitiesEqual(existingGatewayIdentity, leaseOptions.expectedGateway)
						) {
							throw new Error(
								`Existing lease '${existingLease.id}' belongs to a different Gateway VM epoch.`,
							);
						}
						if (isLeaseExpired(existingLease)) {
							await evictLease(existingLease, 'expired');
						} else {
							assertCompatibleAgentLeaseRequest(existingLease, leaseOptions);
							if (await isToolVmLeaseVmLive(existingLease)) {
								return touchLease(existingLease);
							}
							await evictLease(existingLease, 'dead');
						}
					}
					if (retainedAuthority !== undefined && existingLease === undefined) {
						const retainedCleanupLease = authorityRuntime.getCleanupLease(
							retainedAuthority.leaseId,
						);
						if (retainedCleanupLease === undefined) {
							await destroyProvisionalAuthority({
								authority: retainedAuthority,
								reason: 'create-retry',
							});
						} else {
							await destroyRetainedLease({
								lease: retainedCleanupLease,
								notifyRetirement: false,
								reason: 'create-retry',
							});
						}
					}
					const createdAt = options.now();
					const effectiveIdleTtlMs = leaseOptions.effectiveIdleTtlMs ?? defaultToolVmLeaseIdleTtlMs;
					const authority = {
						gateway: leaseOptions.expectedGateway,
						leaseId: createLeaseId(),
						leafGeneration: (options.createLeafGeneration ?? randomUUID)(),
						principal: stableToolVmLeasePrincipal(leaseOptions),
					} satisfies ToolVmLeafAuthorityReference;
					const compatibility = resolveToolVmLeaseCompatibility(leaseOptions);
					const tcpSlot = options.tcpPool.allocate();
					const toolOwnership = options.ownershipCoordinator.admitProvisionalToolVm({
						agentId: leaseOptions.agentId,
						expectedGateway: leaseOptions.expectedGateway,
						sessionLabel: `tool-vm:${leaseOptions.zoneId}:${leaseOptions.agentId}`,
					});
					let authorityRetained = false;
					let persistedRuntimeRecord:
						| { readonly recordId: string; readonly stateDirectory: string }
						| undefined;
					let vm: ManagedVm | undefined;
					try {
						const ownershipProof = await authorityRuntime.beginProvisioning({
							authority,
							cleanupContext: { tcpSlot },
							compatibility,
							idleExpiresAtMs: createdAt + effectiveIdleTtlMs,
							ownership: toolOwnership,
						});
						authorityRetained = true;
						authorityRuntime.setCleanupContext(authority, { tcpSlot });
						vm = await options.createManagedVm({
							...leaseOptions,
							ownershipReservation: ownershipProof.ownershipReservation,
							tcpSlot,
						});
						authorityRuntime.setCleanupContext(authority, { tcpSlot, vm });
						const sshAccess = await vm.enableSsh({
							listenPort: options.tcpPool.portForSlot(tcpSlot),
						});
						const runtimeRecordId = createRuntimeRecordId();
						const lease: Lease = {
							agentId: leaseOptions.agentId,
							agentWorkspaceDir: leaseOptions.agentWorkspaceDir,
							createdAt,
							effectiveIdleTtlMs,
							guestWorkdir: leaseOptions.guestWorkdir,
							hostWorkMountDir: leaseOptions.hostWorkMountDir,
							id: authority.leaseId,
							lastUsedAt: createdAt,
							profileId: leaseOptions.profileId,
							runtimeRecordId,
							sshAccess,
							tcpSlot,
							vm,
							...(leaseOptions.zoneGitMount ? { zoneGitMount: leaseOptions.zoneGitMount } : {}),
							zoneId: leaseOptions.zoneId,
						};
						// Persist a runtime record so the next controller startup can
						// scope-fence and clean up this tool VM's QEMU if we crash
						// before evictLease/releaseLease runs.
						await writeRuntimeRecord(
							options.stateDirFor(lease.zoneId),
							await buildToolVmRuntimeRecord({
								controllerPort: options.controllerPort,
								agentId: lease.agentId,
								leaseId: lease.id,
								managedVm: vm,
								projectNamespace: options.projectNamespace,
								...(options.readProcessIdentity !== undefined
									? { readProcessIdentity: options.readProcessIdentity }
									: {}),
								recordId: lease.runtimeRecordId,
								systemConfigPath: options.systemConfigPath,
								tcpSlot: lease.tcpSlot,
								zoneId: lease.zoneId,
							}),
						);
						persistedRuntimeRecord = {
							recordId: lease.runtimeRecordId,
							stateDirectory: options.stateDirFor(lease.zoneId),
						};
						authorityRuntime.setCleanupContext(authority, {
							persistedRuntimeRecord,
							tcpSlot,
							vm,
						});
						await authorityRuntime.commitCurrent({
							authority,
							lease,
							runtimeBinding: { runtimeRecordId, tcpSlot, vmId: vm.id },
							sshBinding: {
								bindingId: randomUUID(),
								host: sshAccess.host,
								identityFile: sshAccess.identityFile ?? '',
								port: sshAccess.port,
								serverIdentity: JSON.stringify(sshAccess.serverHostKey),
								user: sshAccess.user ?? 'root',
							},
						});
						return lease;
					} catch (error) {
						if (!authorityRetained) {
							if (containsUnprovenVmDestructionError(error)) {
								options.tcpPool.quarantine(tcpSlot);
								if (!(error instanceof RejectedToolVmProvisioningCleanupError)) {
									pendingCleanupRegistry.recordDetachedCleanup({
										agentId: leaseOptions.agentId,
										gatewayIdentity: leaseOptions.expectedGateway,
										ownership: toolOwnership,
										tcpSlot,
										zoneId: leaseOptions.zoneId,
									});
								}
							} else {
								options.tcpPool.release(tcpSlot);
							}
							throw error;
						}
						try {
							const createdVm = vm;
							await authorityRuntime.destroyExact({
								authority,
								destroyedAtMs: options.now(),
								mode:
									createdVm === undefined
										? { kind: 'detached' }
										: {
												closeLiveVm: async () => await createdVm.close(),
												kind: 'live',
											},
								reason: 'create-failed',
							});
							options.tcpPool.release(tcpSlot);
							if (persistedRuntimeRecord !== undefined) {
								await deleteRuntimeRecord(
									persistedRuntimeRecord.stateDirectory,
									persistedRuntimeRecord.recordId,
								);
							}
						} catch (cleanupError) {
							options.tcpPool.quarantine(tcpSlot);
							writeLeaseManagerWarning(
								`failed to close partially-created lease VM for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}': ${formatLeaseManagerError(cleanupError)}. Quarantining tcp slot ${tcpSlot} for exact retry.`,
							);
							throw createToolVmLeaseRetainedCleanupError({
								agentId: leaseOptions.agentId,
								cleanupError,
								creationError: error,
								zoneId: leaseOptions.zoneId,
							});
						}
						throw error;
					}
				});
			} finally {
				finishTrackingCreation();
			}
		},
		async destroyGatewayOwnedLeases(expectedGateway, signal) {
			// A Gateway with no Tool VM leaves may never have entered the lease
			// authority runtime. Registering its exact identity immediately before
			// sealing makes empty-subtree destruction explicit without reopening a
			// previously known parent or admitting a child.
			authorityRuntime.registerGateway(expectedGateway);
			authorityRuntime.sealGateway(expectedGateway);
			const cleanupTasks: (() => Promise<void>)[] = [];
			const agentIdentitiesByKey = new Map<
				string,
				{ readonly agentId: string; readonly zoneId: string }
			>();
			const includeAgentIdentity = (agentIdentity: {
				readonly agentId: string;
				readonly zoneId: string;
			}): void => {
				agentIdentitiesByKey.set(
					`${agentIdentity.zoneId}\0${agentIdentity.agentId}`,
					agentIdentity,
				);
			};
			for (const agentIdentity of pendingCleanupRegistry.pendingCleanupIdentitiesForGateway(
				expectedGateway,
			)) {
				includeAgentIdentity(agentIdentity);
			}
			for (const agentIdentity of leaseCreationRegistry.inFlightAgentIdentitiesForGateway(
				expectedGateway,
			)) {
				includeAgentIdentity(agentIdentity);
			}
			for (const leaseId of authorityRuntime.leaseIdsOwnedByGateway(expectedGateway)) {
				const authority = authorityRuntime.authorityForLease(leaseId);
				if (authority !== undefined) {
					includeAgentIdentity(authority.principal);
				}
			}
			for (const agentIdentity of agentIdentitiesByKey.values()) {
				cleanupTasks.push(
					async () =>
						await agentLeaseOperationLock.runExclusive(agentIdentity, async () => {
							await retryPendingCleanup(agentIdentity, expectedGateway);
							const authority = authorityRuntime.authorityForPrincipal(agentIdentity);
							if (
								authority === undefined ||
								!gatewayIdentitiesEqual(authority.gateway, expectedGateway)
							) {
								return;
							}
							const lease = authorityRuntime.getCleanupLease(authority.leaseId);
							if (lease !== undefined) {
								await destroyRetainedLease({
									lease,
									notifyRetirement: true,
									reason: 'released',
								});
								return;
							}
							await destroyProvisionalAuthority({
								authority,
								reason: 'gateway-released',
							});
						}),
				);
			}
			for (const cleanupId of authorityRuntime.rejectedCleanupIdsOwnedByGateway(expectedGateway)) {
				const rejectedAuthority = authorityRuntime.rejectedCleanupAuthority(cleanupId);
				if (rejectedAuthority !== undefined) {
					cleanupTasks.push(
						async () =>
							await agentLeaseOperationLock.runExclusive(
								rejectedAuthority.principal,
								async () => await retryRejectedProvisioningCleanup(cleanupId),
							),
					);
				}
			}
			const results = await settleGatewayChildDestructionTasks(
				cleanupTasks,
				signal === undefined ? {} : { signal },
			);
			const failures: unknown[] = [];
			for (const result of results) {
				if (result.status === 'rejected') {
					failures.push(result.reason as unknown);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					`Gateway VM epoch '${expectedGateway.gatewayEpochId}' has ${String(failures.length)} incomplete Tool VM disposition${failures.length === 1 ? '' : 's'}.`,
				);
			}
			authorityRuntime.retireGateway(expectedGateway);
		},
		endActiveUse(
			leaseId: string,
			useId: string,
			request,
		): { readonly kind: 'ended' | 'unknown-use' } | undefined {
			const lease = authorityRuntime.getLease(leaseId);
			if (!lease) {
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			const authority = requireAuthorizedLeaseAuthority({
				authority: request.authority,
				leaseId,
			});
			if (!authorityRuntime.activeUseSnapshots(leaseId).some((use) => use.useId === useId)) {
				return { kind: 'unknown-use' };
			}
			authorityRuntime.applyAuthorityCommand({
				authority,
				endedAtMs: options.now(),
				kind: 'end-active-use',
				...(request.report === undefined ? {} : { operationReport: request.report }),
				outcome: request.outcome === 'completed' ? 'completed' : 'failed-observed',
				processEpoch: request.processEpoch,
				sessionAttachmentGeneration: request.sessionAttachmentGeneration,
				useId,
			});
			touchLease(lease);
			return { kind: 'ended' };
		},
		getActiveUseCount(leaseId: string): number {
			return activeUseCountForLease(leaseId);
		},
		getLeaseAuthority(leaseId) {
			const authority = authorityRuntime.authorityForLease(leaseId);
			const leaf = authorityRuntime.leafSnapshotForLease(leaseId);
			return authority === undefined || leaf === undefined
				? undefined
				: { authority, compatibility: leaf.compatibility };
		},
		getActiveUses(leaseId: string): readonly ToolVmActiveUseSnapshot[] {
			return authorityRuntime.activeUseSnapshots(leaseId).map((activeUse) =>
				Object.assign(
					{
						expiresAt:
							activeUse.kind === 'observation-gap'
								? activeUse.resumeDeadlineMs
								: activeUse.kind === 'ambiguous'
									? activeUse.ambiguousAtMs
									: activeUse.kind === 'terminal'
										? activeUse.endedAtMs
										: activeUse.lastHeartbeatAtMs + toolVmUsePolicy.heartbeatStaleMs,
						leaseId,
						startedAt: activeUse.startedAtMs,
						useId: activeUse.useId,
					},
					activeUse.correlation === undefined ? {} : { correlation: activeUse.correlation },
					activeUse.latestOperationReport === undefined
						? {}
						: { latestReport: activeUse.latestOperationReport },
				),
			);
		},
		heartbeatActiveUse(leaseId, useId, request): HeartbeatToolVmActiveUseResponse | undefined {
			const lease = authorityRuntime.getLease(leaseId);
			if (
				!lease ||
				!authorityRuntime.activeUseSnapshots(leaseId).some((use) => use.useId === useId)
			) {
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			if (isLeaseExpired(lease)) {
				return undefined;
			}
			const authority = requireAuthorizedLeaseAuthority({
				authority: request.authority,
				leaseId,
			});
			const now = options.now();
			authorityRuntime.applyAuthorityCommand({
				authority,
				heartbeatAtMs: now,
				kind: 'heartbeat-active-use',
				...(request.report === undefined ? {} : { operationReport: request.report }),
				processEpoch: request.processEpoch,
				sessionAttachmentGeneration: request.sessionAttachmentGeneration,
				useId,
			});
			touchLease(lease);
			return {
				expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
				heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
			};
		},
		async renewLease(leaseId: string): Promise<LeaseRenewal> {
			const lease = authorityRuntime.getLease(leaseId);
			if (!lease) {
				if (authorityRuntime.getRetainedLease(leaseId) !== undefined) {
					throw new Error(
						`Tool VM lease '${leaseId}' is releasing and retained for exact cleanup; it cannot be renewed.`,
					);
				}
				return { kind: 'not-found', reason: 'missing' };
			}
			return await agentLeaseOperationLock.runExclusive(lease, async () => {
				const currentLease = authorityRuntime.getLease(leaseId);
				if (!currentLease) {
					return { kind: 'not-found', reason: 'missing' };
				}
				assertLeaseGatewayAdmitting(currentLease);
				const activeUseCount = activeUseCountForLease(currentLease.id);
				if (
					isToolVmLeaseExpired({
						activeUseCount,
						effectiveIdleTtlMs: currentLease.effectiveIdleTtlMs,
						lastUsedAt: currentLease.lastUsedAt,
						nowMs: options.now(),
					})
				) {
					await evictLease(currentLease, 'expired');
					return { kind: 'not-found', reason: 'expired' };
				}
				const renewalDecision = classifyToolVmLeaseRenewal({
					activeUseCount,
					effectiveIdleTtlMs: currentLease.effectiveIdleTtlMs,
					lastUsedAt: currentLease.lastUsedAt,
					nowMs: options.now(),
					vmLive: await isToolVmLeaseVmLive(currentLease),
				});
				if (renewalDecision.kind === 'evict-dead') {
					await evictLease(currentLease, 'dead');
					return { kind: 'not-found', reason: 'dead' };
				}
				const renewedLease = touchLease(currentLease);
				return {
					kind: 'renewed',
					lastUsedAt: renewedLease.lastUsedAt,
					lease: renewedLease,
				};
			});
		},
		listLeases(): readonly Lease[] {
			return authorityRuntime.listLeases();
		},
		peekLease(leaseId: string): LeaseSnapshot | undefined {
			const lease = authorityRuntime.getRetainedLease(leaseId);
			return lease ? { kind: 'snapshot', lease } : undefined;
		},
		async reapDeadIdleLeases(): Promise<void> {
			for (const lease of authorityRuntime.listLeases()) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- per-agent lock serializes eviction with renew/create/release
				await agentLeaseOperationLock.runExclusive(lease, async () => {
					const currentLease = authorityRuntime.getLease(lease.id);
					if (!currentLease || activeUseCountForLease(currentLease.id) > 0) {
						return;
					}
					if (!(await isToolVmLeaseVmLive(currentLease))) {
						await evictLease(currentLease, 'dead');
					}
				});
			}
		},
		reapExpiredActiveUses(): void {
			const now = options.now();
			for (const lease of authorityRuntime.listLeases()) {
				const authority = authorityRuntime.authorityForLease(lease.id);
				if (authority === undefined) {
					continue;
				}
				for (const activeUse of authorityRuntime.activeUseSnapshots(lease.id)) {
					if (activeUse.kind === 'observation-gap' && activeUse.resumeDeadlineMs <= now) {
						authorityRuntime.applyAuthorityCommand({
							ambiguousAtMs: now,
							authority,
							expectedSessionAttachmentGeneration: activeUse.sessionAttachmentGeneration,
							kind: 'expire-observation-gap',
							nowMs: now,
							useId: activeUse.useId,
						});
					}
				}
			}
			authorityRuntime.applyAuthorityCommand({ kind: 'prune-tombstones', nowMs: now });
		},
		async releaseLease(
			leaseId: string,
			releaseOptions?: { readonly force?: boolean; readonly ifLastUsedAtBeforeOrAt?: number },
		): Promise<void> {
			const lease = authorityRuntime.getRetainedLease(leaseId);
			if (!lease) {
				return;
			}
			await agentLeaseOperationLock.runExclusive(lease, async () => {
				const currentLease = authorityRuntime.getRetainedLease(leaseId);
				if (!currentLease) {
					return;
				}
				const authority = authorityRuntime.authorityForLease(leaseId);
				if (authority === undefined) {
					return;
				}
				const admission = authorityRuntime.admitExactDestruction({
					authority,
					destroyedAtMs: options.now(),
					mode: {
						closeLiveVm: async () => await currentLease.vm.close(),
						kind: 'live',
					},
					policy:
						releaseOptions?.force === true
							? { kind: 'force' }
							: {
									...(releaseOptions?.ifLastUsedAtBeforeOrAt === undefined
										? {}
										: {
												ifLastUsedAtBeforeOrAt: releaseOptions.ifLastUsedAtBeforeOrAt,
											}),
									kind: 'require-no-active-use',
								},
					reason: 'released',
				});
				if (admission.kind === 'skip-recently-used') {
					return;
				}
				if (admission.kind === 'blocked-active-use') {
					throw new LeaseActiveUseConflictError(
						`Tool VM lease '${leaseId}' is still in active use.`,
					);
				}
				try {
					await admission.completion;
				} catch (error) {
					options.tcpPool.quarantine(currentLease.tcpSlot);
					writeLeaseManagerWarning(
						`failed to close released lease '${currentLease.id}' in zone '${currentLease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${currentLease.tcpSlot} and preserving runtime record for exact retry.`,
					);
					throw error;
				}
				notifyLeaseRetired({ leaseId: currentLease.id, reason: 'released' });
				releaseTcpSlotAfterCompleteDestruction(currentLease.tcpSlot);
				try {
					await deleteRuntimeRecord(
						options.stateDirFor(currentLease.zoneId),
						currentLease.runtimeRecordId,
					);
				} catch (deleteError) {
					writeLeaseManagerWarning(
						`failed to delete tool VM runtime record for released lease '${currentLease.id}' in zone '${currentLease.zoneId}': ${formatLeaseManagerError(deleteError)}`,
					);
				}
			});
		},
		startActiveUse(leaseId, request): StartToolVmActiveUseResponse | undefined {
			const lease = authorityRuntime.getLease(leaseId);
			if (!lease) {
				if (authorityRuntime.leafSnapshotForLease(leaseId) !== undefined) {
					throw new LeaseActiveUseConflictError(
						`Tool VM lease '${leaseId}' is not available for new active work.`,
					);
				}
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			if (isLeaseExpired(lease)) {
				return undefined;
			}
			if (!isToolVmActiveUseId(request.useId)) {
				throw new TypeError(`Tool VM active-use id '${request.useId}' must be a UUIDv7.`);
			}
			const existingUse = authorityRuntime
				.activeUseSnapshots(leaseId)
				.find((use) => use.useId === request.useId);
			if (existingUse) {
				return {
					expiresAt:
						existingUse.kind === 'observation-gap'
							? existingUse.resumeDeadlineMs
							: 'lastHeartbeatAtMs' in existingUse
								? existingUse.lastHeartbeatAtMs + toolVmUsePolicy.heartbeatStaleMs
								: options.now(),
					heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
					useId: existingUse.useId,
				};
			}
			const now = options.now();
			const authority = requireAuthorizedLeaseAuthority({
				authority: request.authority,
				leaseId,
			});
			const correlation = normalizeToolVmActiveUseCorrelation(request.correlation);
			authorityRuntime.applyAuthorityCommand({
				authority,
				kind: 'start-active-use',
				use: {
					...(correlation === undefined ? {} : { correlation }),
					lastHeartbeatAtMs: now,
					...(request.report === undefined ? {} : { latestOperationReport: request.report }),
					operationPayloadDigest: request.operationPayloadDigest,
					processEpoch: request.processEpoch,
					semanticOperationId: request.semanticOperationId,
					sessionAttachmentGeneration: request.sessionAttachmentGeneration,
					startedAtMs: now,
					useId: request.useId,
				},
			});
			touchLease(lease);
			return {
				expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
				heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
				useId: request.useId,
			};
		},
		subscribeLeaseRetirement(listener) {
			leaseRetirementListeners.add(listener);
			return () => {
				leaseRetirementListeners.delete(listener);
			};
		},
	};
}
