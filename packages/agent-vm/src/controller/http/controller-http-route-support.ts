import fs from 'node:fs/promises';

import type { Lease, LeaseManager } from '../leases/lease-manager.js';
import type { PreparedWorkerTask, WorkerTaskInput } from '../worker-task-runner.js';

export class ControllerTaskNotReadyError extends Error {}
export class ControllerRuntimeAtCapacityError extends Error {}

export interface ControllerRouteOperations {
	readonly destroyZone: (zoneId: string, purge: boolean) => Promise<unknown>;
	readonly enableSshForZone?: (zoneId: string) => Promise<unknown>;
	readonly execInZone?: (zoneId: string, command: string) => Promise<unknown>;
	readonly getStatus: () => Promise<unknown>;
	readonly getTaskState?: (zoneId: string, taskId: string) => Promise<unknown>;
	readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
	readonly refreshZoneCredentials: (zoneId: string) => Promise<unknown>;
	readonly prepareWorkerTask?: (
		zoneId: string,
		input: WorkerTaskInput,
	) => Promise<PreparedWorkerTask>;
	readonly executeWorkerTask?: (prepared: PreparedWorkerTask) => Promise<unknown>;
	readonly closeTaskForZone?: (
		zoneId: string,
		taskId: string,
	) => Promise<{ readonly status: 'closed' }>;
	readonly pushTaskBranches?: (
		zoneId: string,
		taskId: string,
		input: {
			readonly branches: readonly {
				readonly repoUrl: string;
				readonly branchName: string;
			}[];
		},
	) => Promise<unknown>;
	readonly pullDefaultForTask?: (
		zoneId: string,
		taskId: string,
		input: {
			readonly repoUrl: string;
		},
	) => Promise<unknown>;
	readonly stopController?: () => Promise<unknown>;
	readonly upgradeZone: (zoneId: string) => Promise<unknown>;
}

export type ControllerLeaseManager = Pick<
	LeaseManager,
	'createLease' | 'getLease' | 'listLeases' | 'releaseLease'
>;

export async function readIdentityPemFromFile(identityFilePath: string): Promise<string> {
	return await fs.readFile(identityFilePath, 'utf8');
}

export async function serializeLeaseForResponse(
	lease: Lease,
	readIdentityPem: (identityFilePath: string) => Promise<string>,
): Promise<{
	readonly leaseId: string;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly workdir: '/workspace';
}> {
	return {
		leaseId: lease.id,
		ssh: {
			host: `tool-${lease.tcpSlot}.vm.host`,
			identityPem: lease.sshAccess.identityFile
				? await readIdentityPem(lease.sshAccess.identityFile)
				: '',
			knownHostsLine: '',
			port: 22,
			user: lease.sshAccess.user ?? 'root',
		},
		tcpSlot: lease.tcpSlot,
		workdir: '/workspace',
	};
}
