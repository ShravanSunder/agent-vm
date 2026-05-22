import {
	isToolVmActiveUseId,
	type EndToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseResponse,
	type StartToolVmActiveUseRequest,
	type StartToolVmActiveUseResponse,
	type ToolVmActiveUseCorrelation,
} from '@agent-vm/gateway-interface';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import type { ZoneGitToolVmMount } from '../zone-git/zone-git-paths.js';
import type { TcpPool } from './tcp-pool.js';

export interface ToolVmProfile {
	readonly cpus: number;
	readonly imageProfile: string;
	readonly memory: string;
}

export interface Lease {
	readonly agentWorkspaceDir: string;
	readonly createdAt: number;
	readonly effectiveIdleTtlMs: number;
	readonly guestWorkdir: string;
	readonly id: string;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly scopeKey: string;
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

export interface LeaseRenewal {
	readonly kind: 'renewed';
	readonly lastUsedAt: number;
	readonly lease: Lease;
}

export interface LeaseSnapshot {
	readonly kind: 'snapshot';
	readonly lease: Lease;
}

export interface LeaseManager {
	createLease(options: {
		readonly agentWorkspaceDir: string;
		readonly effectiveIdleTtlMs?: number;
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly scopeKey: string;
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
	getActiveUseCount(leaseId: string): number;
	heartbeatActiveUse(leaseId: string, useId: string): HeartbeatToolVmActiveUseResponse | undefined;
	renewLease(leaseId: string): LeaseRenewal | undefined;
	listLeases(): Lease[];
	peekLease(leaseId: string): LeaseSnapshot | undefined;
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

export class LeaseScopeConflictError extends Error {}
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
	readonly leaseId: string;
	readonly startedAt: number;
	readonly useId: string;
}

interface EndedToolVmActiveUseTombstone {
	readonly expiresAt: number;
	readonly leaseId: string;
	readonly useId: string;
}

const defaultLeaseEffectiveIdleTtlMs = 30 * 60 * 1000;
const defaultToolVmUsePolicy = {
	endedUseTombstoneTtlMs: 10 * 60 * 1000,
	heartbeatAfterMs: 30 * 1000,
	heartbeatStaleMs: 2 * 60 * 1000,
} satisfies ToolVmUsePolicy;

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

function assertReusableScopeLease(
	existingLease: Lease,
	requestedLease: {
		readonly agentWorkspaceDir: string;
		readonly profileId: string;
		readonly guestWorkdir: string;
		readonly hostWorkMountDir: string;
		readonly effectiveIdleTtlMs?: number;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
		readonly scopeKey: string;
	},
): void {
	if (
		requestedLease.effectiveIdleTtlMs !== undefined &&
		existingLease.effectiveIdleTtlMs !== requestedLease.effectiveIdleTtlMs
	) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing effectiveIdleTtlMs '${String(existingLease.effectiveIdleTtlMs)}' does not match requested effectiveIdleTtlMs '${String(requestedLease.effectiveIdleTtlMs)}'.`,
		);
	}
	if (existingLease.profileId !== requestedLease.profileId) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing profileId '${existingLease.profileId}' does not match requested profileId '${requestedLease.profileId}'.`,
		);
	}
	if (existingLease.hostWorkMountDir !== requestedLease.hostWorkMountDir) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing hostWorkMountDir '${existingLease.hostWorkMountDir}' does not match requested hostWorkMountDir '${requestedLease.hostWorkMountDir}'.`,
		);
	}
	if (existingLease.guestWorkdir !== requestedLease.guestWorkdir) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing guestWorkdir '${existingLease.guestWorkdir}' does not match requested guestWorkdir '${requestedLease.guestWorkdir}'.`,
		);
	}
	if (!zoneGitMountsEqual(existingLease.zoneGitMount, requestedLease.zoneGitMount)) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing zoneGitMount does not match requested zoneGitMount.`,
		);
	}
	if (existingLease.agentWorkspaceDir !== requestedLease.agentWorkspaceDir) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing agentWorkspaceDir '${existingLease.agentWorkspaceDir}' does not match requested agentWorkspaceDir '${requestedLease.agentWorkspaceDir}'.`,
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
	try {
		const result = await lease.vm.exec('true');
		return result.exitCode === 0;
	} catch (error) {
		writeLeaseManagerWarning(
			`liveness check failed for lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}`,
		);
		return false;
	}
}

function scopeIndexKey(scopeRequest: {
	readonly scopeKey: string;
	readonly zoneId: string;
}): string {
	return `${scopeRequest.zoneId}\0${scopeRequest.scopeKey}`;
}

function activeUseKey(leaseId: string, useId: string): string {
	return `${leaseId}\0${useId}`;
}

export function createLeaseManager(options: {
	readonly createManagedVm: (leaseOptions: {
		readonly agentWorkspaceDir: string;
		readonly effectiveIdleTtlMs?: number;
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly tcpSlot: number;
		readonly guestWorkdir: string;
		readonly hostWorkMountDir: string;
		readonly zoneGitMount?: ZoneGitToolVmMount;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly now: () => number;
	readonly tcpPool: TcpPool;
	readonly toolVmUsePolicy?: ToolVmUsePolicy;
}): LeaseManager {
	const leases = new Map<string, Lease>();
	const activeUses = new Map<string, ToolVmActiveUse>();
	const endedUseTombstones = new Map<string, EndedToolVmActiveUseTombstone>();
	const leaseIdsByScope = new Map<string, string>();
	const releasingLeaseIds = new Set<string>();
	const scopeLocks = new Map<string, Promise<void>>();
	const toolVmUsePolicy = options.toolVmUsePolicy ?? defaultToolVmUsePolicy;
	assertValidToolVmUsePolicy(toolVmUsePolicy);

	function storeLease(lease: Lease): void {
		leases.set(lease.id, lease);
		leaseIdsByScope.set(scopeIndexKey(lease), lease.id);
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
		const indexKey = scopeIndexKey(lease);
		// Only clear the scope index if it still points at this exact lease.
		if (leaseIdsByScope.get(indexKey) === lease.id) {
			leaseIdsByScope.delete(indexKey);
		}
	}

	function findLeaseForScope(scopeRequest: {
		readonly scopeKey: string;
		readonly zoneId: string;
	}): Lease | undefined {
		const leaseId = leaseIdsByScope.get(scopeIndexKey(scopeRequest));
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

	async function withScopeLock<TValue>(
		scopeRequest: { readonly scopeKey: string; readonly zoneId: string },
		fn: () => Promise<TValue>,
	): Promise<TValue> {
		const lockKey = `${scopeRequest.zoneId}\0${scopeRequest.scopeKey}`;
		const previousLock = scopeLocks.get(lockKey) ?? Promise.resolve();
		let releaseCurrentLock: (() => void) | undefined;
		const currentLock = new Promise<void>((resolve) => {
			releaseCurrentLock = resolve;
		});
		scopeLocks.set(lockKey, currentLock);
		await previousLock.catch(() => {});
		try {
			return await fn();
		} finally {
			releaseCurrentLock?.();
			if (scopeLocks.get(lockKey) === currentLock) {
				scopeLocks.delete(lockKey);
			}
		}
	}

	async function evictLease(lease: Lease): Promise<void> {
		deleteLease(lease);
		options.tcpPool.release(lease.tcpSlot);
		try {
			await lease.vm.close();
		} catch (error) {
			writeLeaseManagerWarning(
				`failed to close evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}`,
			);
		}
	}

	return {
		async createLease(leaseOptions) {
			return await withScopeLock(leaseOptions, async () => {
				const existingLease = findLeaseForScope({
					scopeKey: leaseOptions.scopeKey,
					zoneId: leaseOptions.zoneId,
				});
				if (existingLease) {
					assertReusableScopeLease(existingLease, leaseOptions);
					if (await isLeaseVmLive(existingLease)) {
						return touchLease(existingLease);
					}
					await evictLease(existingLease);
				}
				const tcpSlot = options.tcpPool.allocate();
				try {
					const vm = await options.createManagedVm({
						...leaseOptions,
						tcpSlot,
					});
					try {
						const sshAccess = await vm.enableSsh({
							listenPort: options.tcpPool.portForSlot(tcpSlot),
						});
						const createdAt = options.now();
						const lease: Lease = {
							agentWorkspaceDir: leaseOptions.agentWorkspaceDir,
							createdAt,
							effectiveIdleTtlMs: leaseOptions.effectiveIdleTtlMs ?? defaultLeaseEffectiveIdleTtlMs,
							guestWorkdir: leaseOptions.guestWorkdir,
							id: `${leaseOptions.zoneId}-${leaseOptions.scopeKey}-${createdAt}`,
							lastUsedAt: createdAt,
							profileId: leaseOptions.profileId,
							scopeKey: leaseOptions.scopeKey,
							sshAccess,
							tcpSlot,
							vm,
							hostWorkMountDir: leaseOptions.hostWorkMountDir,
							...(leaseOptions.zoneGitMount ? { zoneGitMount: leaseOptions.zoneGitMount } : {}),
							zoneId: leaseOptions.zoneId,
						};
						storeLease(lease);
						return lease;
					} catch (error) {
						try {
							await vm.close();
						} catch (closeError) {
							writeLeaseManagerWarning(
								`failed to close partially-created lease VM for zone '${leaseOptions.zoneId}' scope '${leaseOptions.scopeKey}': ${formatLeaseManagerError(closeError)}`,
							);
						}
						throw error;
					}
				} catch (error) {
					options.tcpPool.release(tcpSlot);
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
			let count = 0;
			for (const activeUse of activeUses.values()) {
				if (activeUse.leaseId === leaseId) {
					count += 1;
				}
			}
			return count;
		},
		heartbeatActiveUse(
			leaseId: string,
			useId: string,
		): HeartbeatToolVmActiveUseResponse | undefined {
			const lease = leases.get(leaseId);
			const activeUse = activeUses.get(activeUseKey(leaseId, useId));
			if (!lease || !activeUse) {
				return undefined;
			}
			const now = options.now();
			const updatedUse = {
				...activeUse,
				expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
				lastHeartbeatAt: now,
			};
			activeUses.set(activeUseKey(leaseId, useId), updatedUse);
			touchLease(lease);
			return {
				expiresAt: updatedUse.expiresAt,
				heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
			};
		},
		renewLease(leaseId: string): LeaseRenewal | undefined {
			const lease = leases.get(leaseId);
			if (!lease) {
				return undefined;
			}
			const renewedLease = touchLease(lease);
			return {
				kind: 'renewed',
				lastUsedAt: renewedLease.lastUsedAt,
				lease: renewedLease,
			};
		},
		listLeases(): Lease[] {
			return [...leases.values()];
		},
		peekLease(leaseId: string): LeaseSnapshot | undefined {
			const lease = leases.get(leaseId);
			return lease ? { kind: 'snapshot', lease } : undefined;
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
			const lease = leases.get(leaseId);
			if (!lease) {
				return;
			}
			await withScopeLock(lease, async () => {
				const currentLease = leases.get(leaseId);
				if (!currentLease) {
					return;
				}
				if (
					releaseOptions?.ifLastUsedAtBeforeOrAt !== undefined &&
					currentLease.lastUsedAt > releaseOptions.ifLastUsedAtBeforeOrAt
				) {
					return;
				}
				if (releaseOptions?.force !== true) {
					for (const activeUse of activeUses.values()) {
						if (activeUse.leaseId === leaseId) {
							throw new LeaseActiveUseConflictError(
								`Tool VM lease '${leaseId}' is still in active use.`,
							);
						}
					}
				}
				releasingLeaseIds.add(leaseId);

				let releaseError: Error | undefined;
				try {
					await currentLease.vm.close();
				} catch (error) {
					releaseError = error instanceof Error ? error : new Error(String(error));
				}

				deleteLease(currentLease);
				options.tcpPool.release(currentLease.tcpSlot);

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
