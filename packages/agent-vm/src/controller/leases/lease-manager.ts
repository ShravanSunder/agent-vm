import type { ManagedVm } from '@shravansunder/agent-vm-gondolin-core';

import type { TcpPool } from './tcp-pool.js';

export interface ToolProfile {
	readonly cpus: number;
	readonly memory: string;
	readonly workspaceRoot: string;
}

export interface Lease {
	readonly cleanWorkspace?: () => Promise<void>;
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

export function createLeaseManager(options: {
	readonly cleanWorkspace?: (leaseOptions: {
		readonly profile: ToolProfile;
		readonly tcpSlot: number;
		readonly zoneId: string;
	}) => Promise<void>;
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

	return {
		async createLease(leaseOptions) {
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
						...(options.cleanWorkspace
							? {
									cleanWorkspace: async () =>
										await options.cleanWorkspace?.({
											profile: leaseOptions.profile,
											tcpSlot,
											zoneId: leaseOptions.zoneId,
										}),
								}
							: {}),
						createdAt,
						id: `${leaseOptions.zoneId}-${leaseOptions.scopeKey}-${createdAt}`,
						lastUsedAt: createdAt,
						profileId: leaseOptions.profileId,
						scopeKey: leaseOptions.scopeKey,
						sshAccess,
						tcpSlot,
						vm,
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
			return leases.get(leaseId);
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

			try {
				await lease.cleanWorkspace?.();
			} catch (error) {
				releaseError ??= error instanceof Error ? error : new Error(String(error));
			}

			leases.delete(leaseId);
			options.tcpPool.release(lease.tcpSlot);

			if (releaseError) {
				throw releaseError;
			}
		},
	};
}
