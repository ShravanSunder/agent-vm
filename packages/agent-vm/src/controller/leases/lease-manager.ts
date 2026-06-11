import { randomUUID } from 'node:crypto';

import {
	createToolVmLeaseId,
	isToolVmActiveUseId,
	type EndToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseResponse,
	type StartToolVmActiveUseRequest,
	type StartToolVmActiveUseResponse,
	type ToolVmActiveUseCorrelation,
	type ToolVmActiveUseOperationReport,
} from '@agent-vm/gateway-interface';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import {
	isProcessAlive as defaultIsProcessAlive,
	processIdentityMatches,
	readProcessIdentity as defaultReadProcessIdentity,
} from '../../shared/managed-vm-process.js';
import type { ZoneGitToolVmMount } from '../zone-git/zone-git-paths.js';
import { defaultToolVmLeaseIdleTtlMs } from './lease-idle-policy.js';
import type { TcpPool } from './tcp-pool.js';
import {
	classifyToolVmLeaseCloseOutcome,
	classifyToolVmLeaseReleaseRequest,
	classifyToolVmLeaseRenewal,
	isToolVmLeaseExpired,
} from './tool-vm-lease-lifecycle.js';
import {
	buildToolVmRuntimeRecord,
	deleteToolVmRuntimeRecord,
	loadToolVmRuntimeRecord,
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

export interface LeaseManager {
	createLease(options: {
		readonly agentId: string;
		readonly agentWorkspaceDir: string;
		readonly effectiveIdleTtlMs?: number;
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly guestWorkdir: string;
		readonly hostWorkMountDir: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
	}): Promise<Lease>;
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

interface QuarantinedTcpSlotRecord {
	readonly leaseId: string;
	readonly runtimeRecordId: string;
	readonly tcpSlot: number;
	readonly zoneId: string;
}

interface LeaseManagerImplementation extends LeaseManager {
	reapQuarantinedTcpSlots(): Promise<void>;
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

async function isLeaseVmLive(lease: Lease): Promise<boolean> {
	const abortController = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeoutResult = new Promise<false>((resolve) => {
			timeoutHandle = setTimeout(() => {
				abortController.abort();
				resolve(false);
			}, 5_000);
		});
		const probeResult = await Promise.race([
			lease.vm.exec('true', { signal: abortController.signal }),
			timeoutResult,
		]);
		return probeResult !== false && probeResult.exitCode === 0;
	} catch (error) {
		writeLeaseManagerWarning(
			`liveness check failed for lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}`,
		);
		return false;
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
	}
}

function agentLeaseIndexKey(agentLease: {
	readonly agentId: string;
	readonly zoneId: string;
}): string {
	return `${agentLease.zoneId}\0${agentLease.agentId}`;
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
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly deleteToolVmRuntimeRecord?: typeof deleteToolVmRuntimeRecord;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly loadToolVmRuntimeRecord?: typeof loadToolVmRuntimeRecord;
	readonly now: () => number;
	readonly projectNamespace: string;
	// Injected for tests so we don't shell out to `ps` against a fake pid.
	// Production uses the default real implementation.
	readonly readProcessIdentity?: typeof defaultReadProcessIdentity;
	readonly stateDirFor: (zoneId: string) => string;
	readonly systemConfigPath: string;
	readonly tcpPool: TcpPool;
	readonly toolVmUsePolicy?: ToolVmUsePolicy;
	readonly writeToolVmRuntimeRecord?: typeof writeToolVmRuntimeRecord;
}): LeaseManagerImplementation {
	const leases = new Map<string, Lease>();
	const activeUses = new Map<string, ToolVmActiveUse>();
	const endedUseTombstones = new Map<string, EndedToolVmActiveUseTombstone>();
	const leaseIdsByAgent = new Map<string, string>();
	const releasingLeaseIds = new Set<string>();
	const agentLeaseLocks = new Map<string, Promise<void>>();
	const quarantinedSlotRecords = new Map<number, QuarantinedTcpSlotRecord>();
	const toolVmUsePolicy = options.toolVmUsePolicy ?? defaultToolVmUsePolicy;
	assertValidToolVmUsePolicy(toolVmUsePolicy);

	function storeLease(lease: Lease): void {
		leases.set(lease.id, lease);
		leaseIdsByAgent.set(agentLeaseIndexKey(lease), lease.id);
	}

	function deleteLease(lease: Lease): void {
		leases.delete(lease.id);
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
		const indexKey = agentLeaseIndexKey(lease);
		// Only clear the agent index if it still points at this exact lease.
		if (leaseIdsByAgent.get(indexKey) === lease.id) {
			leaseIdsByAgent.delete(indexKey);
		}
	}

	function findLeaseForAgent(agentLease: {
		readonly agentId: string;
		readonly zoneId: string;
	}): Lease | undefined {
		const leaseId = leaseIdsByAgent.get(agentLeaseIndexKey(agentLease));
		return leaseId ? leases.get(leaseId) : undefined;
	}

	function touchLease(lease: Lease): Lease {
		const touchedLease = {
			...lease,
			lastUsedAt: options.now(),
		};
		storeLease(touchedLease);
		return touchedLease;
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

	function isLeaseExpired(lease: Lease): boolean {
		return isToolVmLeaseExpired({
			activeUseCount: activeUseCountForLease(lease.id),
			effectiveIdleTtlMs: lease.effectiveIdleTtlMs,
			lastUsedAt: lease.lastUsedAt,
			nowMs: options.now(),
		});
	}

	async function withAgentLeaseLock<TValue>(
		agentLease: { readonly agentId: string; readonly zoneId: string },
		fn: () => Promise<TValue>,
	): Promise<TValue> {
		const lockKey = `${agentLease.zoneId}\0${agentLease.agentId}`;
		const previousLock = agentLeaseLocks.get(lockKey) ?? Promise.resolve();
		let releaseCurrentLock: (() => void) | undefined;
		const currentLock = new Promise<void>((resolve) => {
			releaseCurrentLock = resolve;
		});
		agentLeaseLocks.set(lockKey, currentLock);
		await previousLock.catch(() => {});
		try {
			return await fn();
		} finally {
			releaseCurrentLock?.();
			if (agentLeaseLocks.get(lockKey) === currentLock) {
				agentLeaseLocks.delete(lockKey);
			}
		}
	}

	const writeRuntimeRecord = options.writeToolVmRuntimeRecord ?? writeToolVmRuntimeRecord;
	const deleteRuntimeRecord = options.deleteToolVmRuntimeRecord ?? deleteToolVmRuntimeRecord;
	const loadRuntimeRecord = options.loadToolVmRuntimeRecord ?? loadToolVmRuntimeRecord;
	const processIsAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	const processIdentityReader = options.readProcessIdentity ?? defaultReadProcessIdentity;
	const createLeaseId = options.createLeaseId ?? createToolVmLeaseId;
	const createRuntimeRecordId = options.createRuntimeRecordId ?? randomUUID;

	function trackQuarantinedTcpSlot(lease: Lease): void {
		quarantinedSlotRecords.set(lease.tcpSlot, {
			leaseId: lease.id,
			runtimeRecordId: lease.runtimeRecordId,
			tcpSlot: lease.tcpSlot,
			zoneId: lease.zoneId,
		});
	}

	async function canRecoverQuarantinedTcpSlot(
		quarantinedRecord: QuarantinedTcpSlotRecord,
	): Promise<boolean> {
		const runtimeRecord = await loadRuntimeRecord(
			options.stateDirFor(quarantinedRecord.zoneId),
			quarantinedRecord.runtimeRecordId,
		);
		if (runtimeRecord === null) {
			writeLeaseManagerWarning(
				`cannot recover quarantined tcp slot ${String(quarantinedRecord.tcpSlot)} for lease '${quarantinedRecord.leaseId}' in zone '${quarantinedRecord.zoneId}': runtime record '${quarantinedRecord.runtimeRecordId}' is missing.`,
			);
			return false;
		}
		if (
			runtimeRecord.tcpSlot !== quarantinedRecord.tcpSlot ||
			runtimeRecord.zoneId !== quarantinedRecord.zoneId
		) {
			writeLeaseManagerWarning(
				`cannot recover quarantined tcp slot ${String(quarantinedRecord.tcpSlot)} for lease '${quarantinedRecord.leaseId}' in zone '${quarantinedRecord.zoneId}': runtime record '${quarantinedRecord.runtimeRecordId}' belongs to zone '${runtimeRecord.zoneId}' slot ${String(runtimeRecord.tcpSlot)}.`,
			);
			return false;
		}
		if (!processIsAlive(runtimeRecord.qemuPid)) {
			return true;
		}
		const currentIdentity = await processIdentityReader(runtimeRecord.qemuPid);
		if (currentIdentity === null) {
			return true;
		}
		return !processIdentityMatches(runtimeRecord.processIdentity, currentIdentity);
	}

	async function recoverQuarantinedTcpSlot(
		quarantinedRecord: QuarantinedTcpSlotRecord,
	): Promise<void> {
		try {
			await deleteRuntimeRecord(
				options.stateDirFor(quarantinedRecord.zoneId),
				quarantinedRecord.runtimeRecordId,
			);
		} catch (deleteError) {
			writeLeaseManagerWarning(
				`failed to delete recovered tool VM runtime record '${quarantinedRecord.runtimeRecordId}' for lease '${quarantinedRecord.leaseId}' in zone '${quarantinedRecord.zoneId}': ${formatLeaseManagerError(deleteError)}`,
			);
		}
		options.tcpPool.releaseQuarantined(quarantinedRecord.tcpSlot);
		quarantinedSlotRecords.delete(quarantinedRecord.tcpSlot);
		writeLeaseManagerWarning(
			`recovered quarantined tcp slot ${String(quarantinedRecord.tcpSlot)} for lease '${quarantinedRecord.leaseId}' in zone '${quarantinedRecord.zoneId}' after proving the recorded Tool VM process is gone.`,
		);
	}

	async function evictLease(lease: Lease): Promise<void> {
		deleteLease(lease);
		let closeSucceeded = true;
		try {
			await lease.vm.close();
		} catch (error) {
			closeSucceeded = false;
			writeLeaseManagerWarning(
				`failed to close evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${lease.tcpSlot} and preserving runtime record for next-startup cleanup.`,
			);
		}
		// Only release the tcp slot when close() succeeded. If close failed the
		// QEMU may still be holding the host port — quarantine the slot so a
		// fresh createLease cannot race onto the same port. Next-startup Phase A
		// will reap the orphan; this controller process will not reuse the slot.
		const closeOutcome = classifyToolVmLeaseCloseOutcome({ closeSucceeded });
		if (closeOutcome.kind === 'release-tcp-and-delete-record') {
			options.tcpPool.release(lease.tcpSlot);
			try {
				await deleteRuntimeRecord(options.stateDirFor(lease.zoneId), lease.runtimeRecordId);
			} catch (deleteError) {
				writeLeaseManagerWarning(
					`failed to delete tool VM runtime record for evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(deleteError)}`,
				);
			}
		} else {
			options.tcpPool.quarantine(lease.tcpSlot);
			trackQuarantinedTcpSlot(lease);
		}
	}

	return {
		async createLease(leaseOptions) {
			return await withAgentLeaseLock(leaseOptions, async () => {
				assertValidLeaseAgentId(leaseOptions.agentId);
				const existingLease = findLeaseForAgent({
					agentId: leaseOptions.agentId,
					zoneId: leaseOptions.zoneId,
				});
				if (existingLease) {
					if (isLeaseExpired(existingLease)) {
						await evictLease(existingLease);
					} else {
						assertCompatibleAgentLeaseRequest(existingLease, leaseOptions);
						if (await isLeaseVmLive(existingLease)) {
							return touchLease(existingLease);
						}
						await evictLease(existingLease);
					}
				}
				const tcpSlot = options.tcpPool.allocate();
				// Tracks whether the slot is safe to release after partial-create
				// failure. If vm.close() throws or never runs (VM was created but
				// teardown failed), the host port may still be held — quarantine
				// the slot instead of releasing it.
				let vmCreatedButNotClosed = false;
				try {
					const vm = await options.createManagedVm({
						...leaseOptions,
						tcpSlot,
					});
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
						storeLease(lease);
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
						} catch (writeError) {
							// Undo: remove the in-memory lease + close the VM + release the
							// TCP slot, then surface the failure to the caller.
							deleteLease(lease);
							throw writeError;
						}
						vmCreatedButNotClosed = false;
						return lease;
					} catch (error) {
						try {
							await vm.close();
							vmCreatedButNotClosed = false;
						} catch (closeError) {
							writeLeaseManagerWarning(
								`failed to close partially-created lease VM for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}': ${formatLeaseManagerError(closeError)}. Quarantining tcp slot ${tcpSlot}.`,
							);
						}
						throw error;
					}
				} catch (error) {
					if (vmCreatedButNotClosed) {
						// VM may still hold the host port — see comment above.
						// This partial-create path has no committed runtime record
						// to prove PID death later, so the slot intentionally stays
						// quarantined for this controller process lifetime.
						options.tcpPool.quarantine(tcpSlot);
					} else {
						options.tcpPool.release(tcpSlot);
					}
					throw error;
				}
			});
		},
		endActiveUse(
			leaseId: string,
			useId: string,
			_request: EndToolVmActiveUseRequest,
		): { readonly kind: 'ended' | 'unknown-use' } | undefined {
			const lease = leases.get(leaseId);
			if (!lease) {
				return undefined;
			}
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
			const lease = leases.get(leaseId);
			const activeUse = activeUses.get(activeUseKey(leaseId, useId));
			if (!lease || !activeUse) {
				return undefined;
			}
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
			const lease = leases.get(leaseId);
			if (!lease) {
				return { kind: 'not-found', reason: 'missing' };
			}
			return await withAgentLeaseLock(lease, async () => {
				const currentLease = leases.get(leaseId);
				if (!currentLease) {
					return { kind: 'not-found', reason: 'missing' };
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
					await evictLease(currentLease);
					return { kind: 'not-found', reason: 'expired' };
				}
				const renewalDecision = classifyToolVmLeaseRenewal({
					activeUseCount,
					effectiveIdleTtlMs: currentLease.effectiveIdleTtlMs,
					lastUsedAt: currentLease.lastUsedAt,
					nowMs: options.now(),
					vmLive: await isLeaseVmLive(currentLease),
				});
				if (renewalDecision.kind === 'evict-dead') {
					await evictLease(currentLease);
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
			return [...leases.values()];
		},
		peekLease(leaseId: string): LeaseSnapshot | undefined {
			const lease = leases.get(leaseId);
			return lease ? { kind: 'snapshot', lease } : undefined;
		},
		async reapDeadIdleLeases(): Promise<void> {
			for (const lease of leases.values()) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- per-agent lock serializes eviction with renew/create/release
				await withAgentLeaseLock(lease, async () => {
					const currentLease = leases.get(lease.id);
					if (!currentLease || activeUseCountForLease(currentLease.id) > 0) {
						return;
					}
					if (!(await isLeaseVmLive(currentLease))) {
						await evictLease(currentLease);
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
		async reapQuarantinedTcpSlots(): Promise<void> {
			for (const quarantinedRecord of quarantinedSlotRecords.values()) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- each slot recovery depends on per-record PID proof.
				if (await canRecoverQuarantinedTcpSlot(quarantinedRecord)) {
					// oxlint-disable-next-line eslint/no-await-in-loop -- recoveries mutate the shared tcp pool map.
					await recoverQuarantinedTcpSlot(quarantinedRecord);
				}
			}
		},
		async releaseLease(
			leaseId: string,
			releaseOptions?: { readonly force?: boolean; readonly ifLastUsedAtBeforeOrAt?: number },
		): Promise<void> {
			const lease = leases.get(leaseId);
			if (!lease) {
				return;
			}
			await withAgentLeaseLock(lease, async () => {
				const currentLease = leases.get(leaseId);
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
				releasingLeaseIds.add(leaseId);

				let releaseError: Error | undefined;
				try {
					await currentLease.vm.close();
				} catch (error) {
					releaseError = error instanceof Error ? error : new Error(String(error));
				}

				deleteLease(currentLease);

				const closeOutcome = classifyToolVmLeaseCloseOutcome({
					closeSucceeded: releaseError === undefined,
				});
				if (closeOutcome.kind === 'release-tcp-and-delete-record') {
					// Close succeeded: slot is safe to re-allocate, record is
					// safe to delete.
					options.tcpPool.release(currentLease.tcpSlot);
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
					trackQuarantinedTcpSlot(currentLease);
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
			const lease = leases.get(leaseId);
			if (!lease) {
				return undefined;
			}
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
			const activeUse = {
				...(request.correlation ? { correlation: request.correlation } : {}),
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
	};
}
