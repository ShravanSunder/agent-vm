import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import type { TcpPool } from './tcp-pool.js';

export interface ToolVmProfile {
	readonly cpus: number;
	readonly imageProfile: string;
	readonly memory: string;
}

export interface Lease {
	readonly agentWorkspaceDir: string;
	readonly createdAt: number;
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
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly hostWorkMountDir: string;
		readonly zoneId: string;
	}): Promise<Lease>;
	keepLeaseAlive(leaseId: string): LeaseRenewal | undefined;
	listLeases(): Lease[];
	peekLease(leaseId: string): LeaseSnapshot | undefined;
	releaseLease(
		leaseId: string,
		options?: { readonly ifLastUsedAtBeforeOrAt?: number },
	): Promise<void>;
}

export class LeaseScopeConflictError extends Error {}

function assertReusableScopeLease(
	existingLease: Lease,
	requestedLease: {
		readonly agentWorkspaceDir: string;
		readonly profileId: string;
		readonly hostWorkMountDir: string;
		readonly zoneId: string;
		readonly scopeKey: string;
	},
): void {
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
	if (existingLease.agentWorkspaceDir !== requestedLease.agentWorkspaceDir) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing agentWorkspaceDir '${existingLease.agentWorkspaceDir}' does not match requested agentWorkspaceDir '${requestedLease.agentWorkspaceDir}'.`,
		);
	}
}

async function isLeaseVmLive(lease: Lease): Promise<boolean> {
	try {
		const result = await lease.vm.exec('true');
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

function scopeIndexKey(scopeRequest: {
	readonly scopeKey: string;
	readonly zoneId: string;
}): string {
	return `${scopeRequest.zoneId}\0${scopeRequest.scopeKey}`;
}

export function createLeaseManager(options: {
	readonly createManagedVm: (leaseOptions: {
		readonly agentWorkspaceDir: string;
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly tcpSlot: number;
		readonly hostWorkMountDir: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly now: () => number;
	readonly tcpPool: TcpPool;
}): LeaseManager {
	const leases = new Map<string, Lease>();
	const leaseIdsByScope = new Map<string, string>();
	const scopeLocks = new Map<string, Promise<void>>();

	function storeLease(lease: Lease): void {
		leases.set(lease.id, lease);
		leaseIdsByScope.set(scopeIndexKey(lease), lease.id);
	}

	function deleteLease(lease: Lease): void {
		leases.delete(lease.id);
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
		await lease.vm.close().catch(() => {});
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
							id: `${leaseOptions.zoneId}-${leaseOptions.scopeKey}-${createdAt}`,
							lastUsedAt: createdAt,
							profileId: leaseOptions.profileId,
							scopeKey: leaseOptions.scopeKey,
							sshAccess,
							tcpSlot,
							vm,
							hostWorkMountDir: leaseOptions.hostWorkMountDir,
							zoneId: leaseOptions.zoneId,
						};
						storeLease(lease);
						return lease;
					} catch (error) {
						await vm.close().catch(() => {});
						throw error;
					}
				} catch (error) {
					options.tcpPool.release(tcpSlot);
					throw error;
				}
			});
		},
		keepLeaseAlive(leaseId: string): LeaseRenewal | undefined {
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
		async releaseLease(
			leaseId: string,
			releaseOptions?: { readonly ifLastUsedAtBeforeOrAt?: number },
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
	};
}
