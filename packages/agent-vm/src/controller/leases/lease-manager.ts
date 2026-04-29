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
	releaseLease(leaseId: string): Promise<void>;
}

function assertReusableScopeLease(
	existingLease: Lease,
	requestedLease: {
		readonly profileId: string;
		readonly workspaceDir: string;
		readonly zoneId: string;
		readonly scopeKey: string;
	},
): void {
	if (existingLease.profileId !== requestedLease.profileId) {
		throw new Error(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing profileId '${existingLease.profileId}' does not match requested profileId '${requestedLease.profileId}'.`,
		);
	}
	if (existingLease.workspaceDir !== requestedLease.workspaceDir) {
		throw new Error(
			`Tool VM lease scope conflict for zone '${requestedLease.zoneId}' scopeKey '${requestedLease.scopeKey}': existing workspaceDir '${existingLease.workspaceDir}' does not match requested workspaceDir '${requestedLease.workspaceDir}'.`,
		);
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

	return {
		async createLease(leaseOptions) {
			const existingLease = findLeaseForScope({
				scopeKey: leaseOptions.scopeKey,
				zoneId: leaseOptions.zoneId,
			});
			if (existingLease) {
				assertReusableScopeLease(existingLease, leaseOptions);
				return touchLease(existingLease);
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
		},
		getLease(leaseId: string): Lease | undefined {
			const lease = leases.get(leaseId);
			return lease ? touchLease(lease) : undefined;
		},
		listLeases(): Lease[] {
			return [...leases.values()];
		},
		async releaseLease(leaseId: string): Promise<void> {
			const lease = leases.get(leaseId);
			if (!lease) {
				return;
			}

			let releaseError: Error | undefined;
			try {
				await lease.vm.close();
			} catch (error) {
				releaseError = error instanceof Error ? error : new Error(String(error));
			}

			leases.delete(leaseId);
			options.tcpPool.release(lease.tcpSlot);

			if (releaseError) {
				throw releaseError;
			}
		},
	};
}
