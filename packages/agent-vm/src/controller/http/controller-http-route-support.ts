import fs from 'node:fs/promises';

import type { Lease, LeaseManager } from '../leases/lease-manager.js';
import type {
	PreparedWorkerTask,
	WorkerTaskInput,
	WorkerTaskResult,
} from '../worker-task-runner.js';
import type { ControllerLeasePeekResponse } from './controller-lease-response-types.js';

export class ControllerTaskNotReadyError extends Error {}
export class ControllerRuntimeAtCapacityError extends Error {}

export interface EnableSshForZoneOptions {
	readonly adminToken?: string;
	readonly secretEnv: 'default' | 'with-secrets';
}

export interface ExecInZoneOptions {
	readonly adminToken?: string;
}

export interface ControllerRouteOperations {
	readonly destroyZone: (zoneId: string, purge: boolean) => Promise<unknown>;
	readonly enableSshForZone?: (
		zoneId: string,
		options: EnableSshForZoneOptions,
	) => Promise<unknown>;
	readonly execInZone?: (
		zoneId: string,
		command: string,
		options: ExecInZoneOptions,
	) => Promise<unknown>;
	readonly getStatus: () => Promise<unknown>;
	readonly getTaskState?: (zoneId: string, taskId: string) => Promise<unknown>;
	readonly getZoneHealth?: (
		zoneId: string,
	) => Promise<{ readonly ok: boolean } & Record<string, unknown>>;
	readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
	readonly getZoneGitStatus?: (zoneId: string) => Promise<unknown>;
	readonly getZoneStatus: (zoneId: string) => Promise<unknown>;
	readonly refreshZoneCredentials: (zoneId: string) => Promise<unknown>;
	readonly prepareWorkerTask?: (
		zoneId: string,
		input: WorkerTaskInput,
	) => Promise<PreparedWorkerTask>;
	readonly executeWorkerTask?: (prepared: PreparedWorkerTask) => Promise<WorkerTaskResult>;
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
	readonly pushZoneGit?: (
		zoneId: string,
		input: { readonly expectedHead: string },
	) => Promise<unknown>;
	readonly verifyZoneGitPushToken?: (zoneId: string, token: string | undefined) => boolean;
	readonly pullDefaultForTask?: (
		zoneId: string,
		taskId: string,
		input: {
			readonly currentBranch?: string | null | undefined;
			readonly currentHead?: string | undefined;
			readonly repoUrl: string;
			readonly worktreeDirty?: boolean | undefined;
		},
	) => Promise<unknown>;
	readonly stopController?: () => Promise<unknown>;
	readonly upgradeZone: (zoneId: string) => Promise<unknown>;
}

export type ControllerLeaseManager = Pick<
	LeaseManager,
	'createLease' | 'keepLeaseAlive' | 'listLeases' | 'peekLease' | 'releaseLease'
>;

export async function readIdentityPemFromFile(identityFilePath: string): Promise<string> {
	return await fs.readFile(identityFilePath, 'utf8');
}

export async function serializeLeaseForResponse(
	lease: Lease,
	readIdentityPem: (identityFilePath: string) => Promise<string>,
	options: { readonly idleTtlMs?: number } = {},
): Promise<{
	readonly idleTtlMs?: number;
	readonly leaseId: string;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly workdir: string;
}> {
	return {
		...(options.idleTtlMs !== undefined ? { idleTtlMs: options.idleTtlMs } : {}),
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
		workdir: lease.guestWorkdir,
	};
}

export function serializeLeasePeekForResponse(lease: Lease): ControllerLeasePeekResponse {
	return {
		createdAt: lease.createdAt,
		lastUsedAt: lease.lastUsedAt,
		leaseId: lease.id,
		profileId: lease.profileId,
		scopeKey: lease.scopeKey,
		ssh: {
			host: lease.sshAccess.host,
			port: lease.sshAccess.port,
			user: lease.sshAccess.user ?? 'root',
		},
		tcpSlot: lease.tcpSlot,
		zoneId: lease.zoneId,
	};
}
