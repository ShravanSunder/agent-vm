import type { ManagedVm } from 'gondolin-core';

import type { TcpPool } from './tcp-pool.js';

export interface ToolProfile {
	readonly cpus: number;
	readonly memory: string;
	readonly workspaceRoot: string;
}

export interface Lease {
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
			const vm = await options.createManagedVm({
				...leaseOptions,
				tcpSlot,
			});
			const sshAccess = await vm.enableSsh({
				listenPort: options.tcpPool.portForSlot(tcpSlot),
			});
			const createdAt = options.now();
			const lease: Lease = {
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

			leases.delete(leaseId);
			options.tcpPool.release(lease.tcpSlot);
			await lease.vm.close();
		},
	};
}
