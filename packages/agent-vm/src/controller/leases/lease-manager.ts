import type { ManagedVm } from '@agent-vm/gondolin-adapter';

import type { TcpPool } from './tcp-pool.js';

export interface ToolProfile {
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
	readonly workspaceDir: string;
	readonly zoneId: string;
}

export interface LeaseManager {
	createLease(options: {
		readonly agentWorkspaceDir: string;
		readonly profile: ToolProfile;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}): Promise<Lease>;
	getLease(leaseId: string): Lease | undefined;
	listLeases(): Lease[];
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
		readonly workspaceDir: string;
		readonly zoneId: string;
		readonly scopeKey: string;
	},
): void {
	if (existingLease.profileId !== requestedLease.profileId) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing profileId '${existingLease.profileId}' does not match requested profileId '${requestedLease.profileId}'.`,
		);
	}
	if (existingLease.workspaceDir !== requestedLease.workspaceDir) {
		throw new LeaseScopeConflictError(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing workspaceDir '${existingLease.workspaceDir}' does not match requested workspaceDir '${requestedLease.workspaceDir}'.`,
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

export function createLeaseManager(options: {
	readonly createManagedVm: (leaseOptions: {
		readonly agentWorkspaceDir: string;
		readonly profile: ToolProfile;
		readonly profileId: string;
		readonly scopeKey: string;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly now: () => number;
	readonly tcpPool: TcpPool;
}): LeaseManager {
	const leases = new Map<string, Lease>();
	const scopeLocks = new Map<string, Promise<void>>();

	function findLeaseForScope(scopeRequest: {
		readonly scopeKey: string;
		readonly zoneId: string;
	}): Lease | undefined {
		return [...leases.values()].find(
			(lease) => lease.zoneId === scopeRequest.zoneId && lease.scopeKey === scopeRequest.scopeKey,
		);
	}

	function touchLease(lease: Lease): Lease {
		const touchedLease = {
			...lease,
			lastUsedAt: options.now(),
		};
		leases.set(lease.id, touchedLease);
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
		leases.delete(lease.id);
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
							workspaceDir: leaseOptions.workspaceDir,
							zoneId: leaseOptions.zoneId,
						};
						leases.set(lease.id, lease);
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
		getLease(leaseId: string): Lease | undefined {
			const lease = leases.get(leaseId);
			return lease ? touchLease(lease) : undefined;
		},
		listLeases(): Lease[] {
			return [...leases.values()];
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

				leases.delete(leaseId);
				options.tcpPool.release(currentLease.tcpSlot);

				if (releaseError) {
					throw releaseError;
				}
			});
		},
	};
}
