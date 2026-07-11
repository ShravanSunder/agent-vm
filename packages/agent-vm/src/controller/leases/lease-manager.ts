import { randomUUID } from 'node:crypto';

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
	VmDestroyReceiptV1,
	VmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';

import type { readProcessIdentity as defaultReadProcessIdentity } from '../../shared/managed-vm-process.js';
import {
	containsUnprovenVmDestructionError,
	IncompleteVmDestructionError,
} from '../../shared/vm-destruction-receipt.js';
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
import { createToolVmCurrentLeaseRegistry } from './tool-vm-current-lease-registry.js';
import { createToolVmLeaseCreationRegistry } from './tool-vm-lease-creation-registry.js';
import {
	classifyToolVmLeaseCloseOutcome,
	classifyToolVmLeaseReleaseRequest,
	classifyToolVmLeaseRenewal,
	isToolVmLeaseExpired,
} from './tool-vm-lease-lifecycle.js';
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
		readonly user?: string;
	};
	readonly tcpSlot: number;
	readonly vm: ManagedVm;
	readonly hostWorkMountDir: string;
	readonly zoneGitMount?: ZoneGitToolVmMount;
	readonly zoneId: string;
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

export interface LeaseManager {
	createLease(options: {
		readonly agentId: string;
		readonly agentWorkspaceDir: string;
		readonly effectiveIdleTtlMs?: number;
		readonly expectedGateway: GatewayEpochIdentity;
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly guestWorkdir: string;
		readonly hostWorkMountDir: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
	}): Promise<Lease>;
	destroyGatewayOwnedLeases(
		expectedGateway: GatewayEpochIdentity,
		signal?: AbortSignal,
	): Promise<void>;
	endActiveUse(
		leaseId: string,
		useId: string,
		request: EndToolVmActiveUseRequest,
	): { readonly kind: 'ended' | 'unknown-use' } | undefined;
	getActiveUses(leaseId: string): readonly ToolVmActiveUseSnapshot[];
	getActiveUseCount(leaseId: string): number;
	heartbeatActiveUse(
		leaseId: string,
		useId: string,
		request: HeartbeatToolVmActiveUseRequest,
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
		request: StartToolVmActiveUseRequest,
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

interface ToolVmActiveUse {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly expiresAt: number;
	readonly lastHeartbeatAt: number;
	readonly latestReport?: ToolVmActiveUseOperationReport;
	readonly leaseId: string;
	readonly startedAt: number;
	readonly useId: string;
}

interface EndedToolVmActiveUseTombstone {
	readonly expiresAt: number;
	readonly leaseId: string;
	readonly useId: string;
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

function activeUseKey(leaseId: string, useId: string): string {
	return `${leaseId}\0${useId}`;
}

export function createLeaseManager(options: {
	readonly controllerPort: number;
	readonly createLeaseId?: () => string;
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
	const activeUses = new Map<string, ToolVmActiveUse>();
	const endedUseTombstones = new Map<string, EndedToolVmActiveUseTombstone>();
	const releasingLeaseIds = new Set<string>();
	const leaseRetirementListeners = new Set<(event: ToolVmLeaseRetirementEvent) => void>();
	const agentLeaseOperationLock = createAgentLeaseOperationLock();
	const currentLeaseRegistry = createToolVmCurrentLeaseRegistry<Lease>();
	const leaseCreationRegistry = createToolVmLeaseCreationRegistry();
	const toolVmUsePolicy = options.toolVmUsePolicy ?? defaultToolVmUsePolicy;
	assertValidToolVmUsePolicy(toolVmUsePolicy);

	function storeLease(storeOptions: {
		readonly gatewayIdentity: GatewayEpochIdentity;
		readonly lease: Lease;
		readonly ownership: ReturnType<GatewayOwnershipCoordinator['admitProvisionalToolVm']>;
	}): void {
		currentLeaseRegistry.recordCurrent(storeOptions);
	}

	function deleteLease(lease: Lease): void {
		currentLeaseRegistry.forget(lease);
		releasingLeaseIds.delete(lease.id);
		for (const [key, activeUse] of activeUses.entries()) {
			if (activeUse.leaseId === lease.id) {
				activeUses.delete(key);
			}
		}
		for (const [key, tombstone] of endedUseTombstones.entries()) {
			if (tombstone.leaseId === lease.id) {
				endedUseTombstones.delete(key);
			}
		}
	}

	function findLeaseForAgent(agentLease: {
		readonly agentId: string;
		readonly zoneId: string;
	}): Lease | undefined {
		return currentLeaseRegistry.findByAgent(agentLease);
	}

	function touchLease(lease: Lease): Lease {
		return currentLeaseRegistry.touch(lease, options.now());
	}

	function assertLeaseGatewayAdmitting(lease: Lease): void {
		const expectedGateway = currentLeaseRegistry.resolveGatewayIdentity(lease.id);
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

	function activeUseCountForLease(leaseId: string): number {
		let count = 0;
		for (const activeUse of activeUses.values()) {
			if (activeUse.leaseId === leaseId) {
				count += 1;
			}
		}
		return count;
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

	async function evictLease(lease: Lease, reason: ToolVmLeaseRetirementReason): Promise<void> {
		const ownership = currentLeaseRegistry.requireOwnership(lease.id);
		releasingLeaseIds.add(lease.id);
		let destroyReceipt: VmDestroyReceiptV1;
		try {
			destroyReceipt = await ownership.destroyLive(async () => await lease.vm.close());
		} catch (error) {
			options.tcpPool.quarantine(lease.tcpSlot);
			writeLeaseManagerWarning(
				`failed to close evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${lease.tcpSlot} and preserving runtime record for next-startup cleanup.`,
			);
			throw error;
		}
		if (!destroyReceipt.complete) {
			options.tcpPool.quarantine(lease.tcpSlot);
			writeLeaseManagerWarning(
				`evicted lease '${lease.id}' in zone '${lease.zoneId}' returned an incomplete exact VM destruction receipt. Quarantining tcp slot ${lease.tcpSlot} and preserving runtime record for next-startup cleanup.`,
			);
			throw new IncompleteVmDestructionError(`Evicted lease '${lease.id}'`, destroyReceipt);
		}
		deleteLease(lease);
		notifyLeaseRetired({ leaseId: lease.id, reason });
		releaseTcpSlotAfterCompleteDestruction(lease.tcpSlot);
		try {
			await deleteRuntimeRecord(options.stateDirFor(lease.zoneId), lease.runtimeRecordId);
		} catch (deleteError) {
			writeLeaseManagerWarning(
				`failed to delete tool VM runtime record for evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(deleteError)}`,
			);
		}
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
					await pendingCleanupRegistry.retry(leaseOptions);
					const existingLease = findLeaseForAgent({
						agentId: leaseOptions.agentId,
						zoneId: leaseOptions.zoneId,
					});
					if (existingLease) {
						assertLeaseGatewayAdmitting(existingLease);
						const existingGatewayIdentity = currentLeaseRegistry.resolveGatewayIdentity(
							existingLease.id,
						);
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
					const tcpSlot = options.tcpPool.allocate();
					const toolOwnership = options.ownershipCoordinator.admitProvisionalToolVm({
						agentId: leaseOptions.agentId,
						expectedGateway: leaseOptions.expectedGateway,
						sessionLabel: `tool-vm:${leaseOptions.zoneId}:${leaseOptions.agentId}`,
					});
					// Tracks whether the slot is safe to release after partial-create
					// failure. If vm.close() throws or never runs (VM was created but
					// teardown failed), the host port may still be held — quarantine
					// the slot instead of releasing it.
					let vmCreatedButNotClosed = false;
					let detachedCleanupComplete = false;
					let persistedRuntimeRecord:
						| { readonly recordId: string; readonly stateDirectory: string }
						| undefined;
					try {
						const ownershipReservation = await toolOwnership.ready;
						let vm: ManagedVm;
						try {
							vm = await options.createManagedVm({
								...leaseOptions,
								ownershipReservation,
								tcpSlot,
							});
						} catch (createError) {
							try {
								await toolOwnership.destroyDetached();
								detachedCleanupComplete = true;
							} catch (cleanupError) {
								vmCreatedButNotClosed = true;
								pendingCleanupRegistry.recordDetachedCleanup({
									agentId: leaseOptions.agentId,
									gatewayIdentity: structuredClone(leaseOptions.expectedGateway),
									ownership: toolOwnership,
									tcpSlot,
									zoneId: leaseOptions.zoneId,
								});
								const aggregateError = new AggregateError(
									[createError, cleanupError],
									`Tool VM creation failed and detached cleanup was not proven for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}'.`,
									{ cause: createError },
								);
								throw aggregateError;
							}
							throw createError;
						}
						vmCreatedButNotClosed = true;
						try {
							const sshAccess = await vm.enableSsh({
								listenPort: options.tcpPool.portForSlot(tcpSlot),
							});
							const createdAt = options.now();
							const runtimeRecordId = createRuntimeRecordId();
							const lease: Lease = {
								agentId: leaseOptions.agentId,
								agentWorkspaceDir: leaseOptions.agentWorkspaceDir,
								createdAt,
								effectiveIdleTtlMs: leaseOptions.effectiveIdleTtlMs ?? defaultToolVmLeaseIdleTtlMs,
								guestWorkdir: leaseOptions.guestWorkdir,
								id: createLeaseId(),
								lastUsedAt: createdAt,
								profileId: leaseOptions.profileId,
								runtimeRecordId,
								sshAccess,
								tcpSlot,
								vm,
								hostWorkMountDir: leaseOptions.hostWorkMountDir,
								...(leaseOptions.zoneGitMount ? { zoneGitMount: leaseOptions.zoneGitMount } : {}),
								zoneId: leaseOptions.zoneId,
							};
							// Persist a runtime record so the next controller startup can
							// scope-fence and clean up this tool VM's QEMU if we crash
							// before evictLease/releaseLease runs.
							try {
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
							} catch (writeError) {
								// Undo: remove the in-memory lease + close the VM + release the
								// TCP slot, then surface the failure to the caller.
								deleteLease(lease);
								throw writeError;
							}
							await toolOwnership.commitCurrent();
							storeLease({
								gatewayIdentity: leaseOptions.expectedGateway,
								lease,
								ownership: toolOwnership,
							});
							vmCreatedButNotClosed = false;
							return lease;
						} catch (error) {
							let cleanupError: Error | undefined;
							try {
								const destroyReceipt = await toolOwnership.destroyLive(
									async () => await vm.close(),
								);
								if (destroyReceipt.complete) {
									vmCreatedButNotClosed = false;
								} else {
									cleanupError = new IncompleteVmDestructionError(
										`Partially-created lease VM for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}'`,
										destroyReceipt,
									);
									writeLeaseManagerWarning(
										`partially-created lease VM for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}' returned an incomplete exact VM destruction receipt. Quarantining tcp slot ${tcpSlot}.`,
									);
								}
							} catch (closeError) {
								cleanupError =
									closeError instanceof Error ? closeError : new Error(String(closeError));
								writeLeaseManagerWarning(
									`failed to close partially-created lease VM for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}': ${formatLeaseManagerError(closeError)}. Quarantining tcp slot ${tcpSlot}.`,
								);
							}
							if (cleanupError) {
								pendingCleanupRegistry.recordLiveCleanup({
									agentId: leaseOptions.agentId,
									gatewayIdentity: structuredClone(leaseOptions.expectedGateway),
									ownership: toolOwnership,
									...(persistedRuntimeRecord === undefined ? {} : { persistedRuntimeRecord }),
									tcpSlot,
									vm,
									zoneId: leaseOptions.zoneId,
								});
								const primaryError = error instanceof Error ? error : new Error(String(error));
								const aggregateError = new AggregateError(
									[primaryError, cleanupError],
									`Tool VM lease creation failed and teardown was not proven complete for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}'.`,
								);
								aggregateError.cause = primaryError;
								throw aggregateError;
							}
							if (persistedRuntimeRecord !== undefined) {
								try {
									await deleteRuntimeRecord(
										persistedRuntimeRecord.stateDirectory,
										persistedRuntimeRecord.recordId,
									);
								} catch (deleteError) {
									writeLeaseManagerWarning(
										`failed to delete rolled-back tool VM runtime record '${persistedRuntimeRecord.recordId}' in zone '${leaseOptions.zoneId}': ${formatLeaseManagerError(deleteError)}`,
									);
								}
							}
							throw error;
						}
					} catch (error) {
						if (vmCreatedButNotClosed) {
							// VM may still hold the host port — see comment above.
							options.tcpPool.quarantine(tcpSlot);
						} else if (containsUnprovenVmDestructionError(error) && !detachedCleanupComplete) {
							options.tcpPool.quarantine(tcpSlot);
							pendingCleanupRegistry.recordDetachedCleanup({
								agentId: leaseOptions.agentId,
								gatewayIdentity: structuredClone(leaseOptions.expectedGateway),
								ownership: toolOwnership,
								tcpSlot,
								zoneId: leaseOptions.zoneId,
							});
						} else {
							options.tcpPool.release(tcpSlot);
						}
						throw error;
					}
				});
			} finally {
				finishTrackingCreation();
			}
		},
		async destroyGatewayOwnedLeases(expectedGateway, signal) {
			const cleanupAgentIdentities = new Map<
				string,
				{ readonly agentId: string; readonly zoneId: string }
			>();
			const recordCleanupAgentIdentity = (agentIdentity: {
				readonly agentId: string;
				readonly zoneId: string;
			}): void => {
				cleanupAgentIdentities.set(
					`${agentIdentity.zoneId}\0${agentIdentity.agentId}`,
					agentIdentity,
				);
			};
			for (const agentIdentity of pendingCleanupRegistry.pendingCleanupIdentitiesForGateway(
				expectedGateway,
			)) {
				recordCleanupAgentIdentity(agentIdentity);
			}
			for (const agentIdentity of leaseCreationRegistry.inFlightAgentIdentitiesForGateway(
				expectedGateway,
			)) {
				recordCleanupAgentIdentity(agentIdentity);
			}
			for (const leaseId of currentLeaseRegistry.leaseIdsOwnedByGateway(expectedGateway)) {
				const lease = currentLeaseRegistry.get(leaseId);
				if (lease !== undefined) {
					recordCleanupAgentIdentity(lease);
				}
			}
			const cleanupTasks = [...cleanupAgentIdentities.values()].map(
				(agentIdentity) => async () =>
					await agentLeaseOperationLock.runExclusive(agentIdentity, async () => {
						await pendingCleanupRegistry.retry(agentIdentity);
						const currentLease = currentLeaseRegistry.findByAgent(agentIdentity);
						if (currentLease === undefined) {
							return;
						}
						const currentGatewayIdentity = currentLeaseRegistry.resolveGatewayIdentity(
							currentLease.id,
						);
						if (
							currentGatewayIdentity !== undefined &&
							gatewayIdentitiesEqual(currentGatewayIdentity, expectedGateway)
						) {
							await evictLease(currentLease, 'released');
						}
					}),
			);
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
		},
		endActiveUse(
			leaseId: string,
			useId: string,
			_request: EndToolVmActiveUseRequest,
		): { readonly kind: 'ended' | 'unknown-use' } | undefined {
			const lease = currentLeaseRegistry.get(leaseId);
			if (!lease) {
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			const key = activeUseKey(leaseId, useId);
			const activeUse = activeUses.get(key);
			if (activeUse) {
				activeUses.delete(key);
				endedUseTombstones.set(key, {
					expiresAt: options.now() + toolVmUsePolicy.endedUseTombstoneTtlMs,
					leaseId,
					useId,
				});
				touchLease(lease);
				return { kind: 'ended' };
			}
			return { kind: 'unknown-use' };
		},
		getActiveUseCount(leaseId: string): number {
			return activeUseCountForLease(leaseId);
		},
		getActiveUses(leaseId: string): readonly ToolVmActiveUseSnapshot[] {
			return [...activeUses.values()]
				.filter((activeUse) => activeUse.leaseId === leaseId)
				.map(
					(activeUse) =>
						Object.assign(
							{
								expiresAt: activeUse.expiresAt,
								leaseId: activeUse.leaseId,
								startedAt: activeUse.startedAt,
								useId: activeUse.useId,
							},
							activeUse.correlation ? { correlation: activeUse.correlation } : {},
							activeUse.latestReport ? { latestReport: activeUse.latestReport } : {},
						) satisfies ToolVmActiveUseSnapshot,
				);
		},
		heartbeatActiveUse(
			leaseId: string,
			useId: string,
			request: HeartbeatToolVmActiveUseRequest,
		): HeartbeatToolVmActiveUseResponse | undefined {
			const lease = currentLeaseRegistry.get(leaseId);
			const activeUse = activeUses.get(activeUseKey(leaseId, useId));
			if (!lease || !activeUse || releasingLeaseIds.has(leaseId)) {
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			if (isLeaseExpired(lease)) {
				return undefined;
			}
			const now = options.now();
			const updatedUse = {
				...activeUse,
				expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
				lastHeartbeatAt: now,
				...(request.report === undefined ? {} : { latestReport: request.report }),
			};
			activeUses.set(activeUseKey(leaseId, useId), updatedUse);
			touchLease(lease);
			return {
				expiresAt: updatedUse.expiresAt,
				heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
			};
		},
		async renewLease(leaseId: string): Promise<LeaseRenewal> {
			const lease = currentLeaseRegistry.get(leaseId);
			if (!lease) {
				return { kind: 'not-found', reason: 'missing' };
			}
			return await agentLeaseOperationLock.runExclusive(lease, async () => {
				const currentLease = currentLeaseRegistry.get(leaseId);
				if (!currentLease) {
					return { kind: 'not-found', reason: 'missing' };
				}
				assertLeaseGatewayAdmitting(currentLease);
				if (releasingLeaseIds.has(leaseId)) {
					throw new LeaseActiveUseConflictError(`Tool VM lease '${leaseId}' is releasing.`);
				}
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
			return currentLeaseRegistry.list();
		},
		peekLease(leaseId: string): LeaseSnapshot | undefined {
			const lease = currentLeaseRegistry.get(leaseId);
			return lease ? { kind: 'snapshot', lease } : undefined;
		},
		async reapDeadIdleLeases(): Promise<void> {
			for (const lease of currentLeaseRegistry.values()) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- per-agent lock serializes eviction with renew/create/release
				await agentLeaseOperationLock.runExclusive(lease, async () => {
					const currentLease = currentLeaseRegistry.get(lease.id);
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
			for (const [key, activeUse] of activeUses.entries()) {
				if (activeUse.expiresAt < now) {
					activeUses.delete(key);
					endedUseTombstones.set(key, {
						expiresAt: now + toolVmUsePolicy.endedUseTombstoneTtlMs,
						leaseId: activeUse.leaseId,
						useId: activeUse.useId,
					});
				}
			}
			for (const [key, tombstone] of endedUseTombstones.entries()) {
				if (tombstone.expiresAt < now) {
					endedUseTombstones.delete(key);
				}
			}
		},
		async releaseLease(
			leaseId: string,
			releaseOptions?: { readonly force?: boolean; readonly ifLastUsedAtBeforeOrAt?: number },
		): Promise<void> {
			const lease = currentLeaseRegistry.get(leaseId);
			if (!lease) {
				return;
			}
			await agentLeaseOperationLock.runExclusive(lease, async () => {
				const currentLease = currentLeaseRegistry.get(leaseId);
				if (!currentLease) {
					return;
				}
				const releaseDecision = classifyToolVmLeaseReleaseRequest({
					activeUseCount: activeUseCountForLease(leaseId),
					force: releaseOptions?.force,
					ifLastUsedAtBeforeOrAt: releaseOptions?.ifLastUsedAtBeforeOrAt,
					lastUsedAt: currentLease.lastUsedAt,
				});
				if (releaseDecision.kind === 'skip-recently-used') {
					return;
				}
				if (releaseDecision.kind === 'blocked-active-use') {
					throw new LeaseActiveUseConflictError(
						`Tool VM lease '${leaseId}' is still in active use.`,
					);
				}
				const ownership = currentLeaseRegistry.requireOwnership(leaseId);
				releasingLeaseIds.add(leaseId);

				let releaseError: Error | undefined;
				let destroyReceipt: VmDestroyReceiptV1 | undefined;
				try {
					destroyReceipt = await ownership.destroyLive(async () => await currentLease.vm.close());
					if (!destroyReceipt.complete) {
						releaseError = new IncompleteVmDestructionError(
							`Released lease '${currentLease.id}'`,
							destroyReceipt,
						);
					}
				} catch (error) {
					releaseError = error instanceof Error ? error : new Error(String(error));
				}

				const closeOutcome = classifyToolVmLeaseCloseOutcome({
					destroyReceipt,
				});
				if (closeOutcome.kind === 'release-tcp-and-delete-record') {
					deleteLease(currentLease);
					notifyLeaseRetired({ leaseId: currentLease.id, reason: 'released' });
					// Close succeeded: slot is safe to re-allocate, record is
					// safe to delete.
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
				} else {
					// Close failed: QEMU may still hold the host port. Quarantine
					// the slot so the next createLease in this process can't race
					// onto the same port, and preserve the runtime record so the
					// next controller's Phase A cleanup can scope-fence + signal.
					options.tcpPool.quarantine(currentLease.tcpSlot);
					writeLeaseManagerWarning(
						`failed to close released lease '${currentLease.id}' in zone '${currentLease.zoneId}': ${formatLeaseManagerError(releaseError)}. Quarantining tcp slot ${currentLease.tcpSlot} and preserving runtime record for next-startup cleanup.`,
					);
				}

				if (releaseError) {
					throw releaseError;
				}
			});
		},
		startActiveUse(
			leaseId: string,
			request: StartToolVmActiveUseRequest,
		): StartToolVmActiveUseResponse | undefined {
			const lease = currentLeaseRegistry.get(leaseId);
			if (!lease) {
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			if (isLeaseExpired(lease)) {
				return undefined;
			}
			if (releasingLeaseIds.has(leaseId)) {
				throw new LeaseActiveUseConflictError(`Tool VM lease '${leaseId}' is releasing.`);
			}
			if (!isToolVmActiveUseId(request.useId)) {
				throw new TypeError(`Tool VM active-use id '${request.useId}' must be a UUIDv7.`);
			}
			const key = activeUseKey(leaseId, request.useId);
			const existingUse = activeUses.get(key);
			if (existingUse) {
				return {
					expiresAt: existingUse.expiresAt,
					heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
					useId: existingUse.useId,
				};
			}
			const tombstone = endedUseTombstones.get(key);
			if (tombstone) {
				throw new LeaseActiveUseConflictError(
					`Tool VM active-use id '${request.useId}' for lease '${leaseId}' already ended.`,
				);
			}
			const now = options.now();
			const correlation = normalizeToolVmActiveUseCorrelation(request.correlation);
			const activeUse = {
				...(correlation ? { correlation } : {}),
				expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
				lastHeartbeatAt: now,
				...(request.report === undefined ? {} : { latestReport: request.report }),
				leaseId,
				startedAt: now,
				useId: request.useId,
			} satisfies ToolVmActiveUse;
			activeUses.set(key, activeUse);
			touchLease(lease);
			return {
				expiresAt: activeUse.expiresAt,
				heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
				useId: activeUse.useId,
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
