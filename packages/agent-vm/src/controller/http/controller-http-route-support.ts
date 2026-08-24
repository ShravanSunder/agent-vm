import fs from 'node:fs/promises';

import type { Lease, LeaseManager } from '../leases/lease-manager.js';
import { buildToolVmKnownHostsLine } from '../leases/tool-vm-ssh-server-identity.js';
import type {
	PreparedWorkerTask,
	WorkerTaskInput,
	WorkerTaskResult,
} from '../worker-task-runner.js';
import type { ControllerLeasePeekResponse } from './controller-lease-response-types.js';

export class ControllerTaskNotReadyError extends Error {}
export class ControllerRuntimeAtCapacityError extends Error {}

export type ControllerRuntimeReadinessState = 'ready' | 'recovering' | 'stopping';

export interface ControllerRuntimeReadiness {
	readonly ready: boolean;
	readonly state: ControllerRuntimeReadinessState;
}

export interface MutableControllerRuntimeReadiness {
	get(): ControllerRuntimeReadiness;
	set(state: ControllerRuntimeReadinessState): void;
}

export function createMutableControllerRuntimeReadiness(
	initialState: ControllerRuntimeReadinessState,
): MutableControllerRuntimeReadiness {
	let state = initialState;
	return {
		get: () => ({ ready: state === 'ready', state }),
		set: (nextState) => {
			state = nextState;
		},
	};
}

export interface EnableSshForZoneOptions {
	readonly adminToken?: string;
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
	readonly getZoneServiceHealth?: (
		zoneId: string,
	) => Promise<{ readonly ok: boolean } & Record<string, unknown>>;
	readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
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
	'createLease' | 'renewLease' | 'listLeases' | 'peekLease' | 'releaseLease'
> &
	Partial<
		Pick<
			LeaseManager,
			| 'endActiveUse'
			| 'getActiveUseCount'
			| 'getCurrentLeaseBinding'
			| 'getLeaseAuthority'
			| 'heartbeatActiveUse'
			| 'reacquireLease'
			| 'startActiveUse'
			| 'subscribeLeaseRetirement'
		>
	>;

export async function readIdentityPemFromFile(identityFilePath: string): Promise<string> {
	return await fs.readFile(identityFilePath, 'utf8');
}

export async function serializeLeaseForResponse(
	lease: Lease,
	readIdentityPem: (identityFilePath: string) => Promise<string>,
	options: { readonly idleTtlMs: number },
): Promise<{
	readonly agentId: string;
	readonly idleTtlMs: number;
	readonly leaseId: string;
	readonly ssh: {
		readonly host: string;
		readonly identityPem: string;
		readonly knownHostsLine: string;
		readonly port: number;
		readonly user: string;
	};
	readonly tcpSlot: number;
	readonly transport: 'ssh-sandbox';
	readonly workdir: string;
}> {
	if (!lease.sshAccess.identityFile) {
		throw new Error(`Lease '${lease.id}' does not have an SSH identity file.`);
	}
	const identityPem = await readIdentityPem(lease.sshAccess.identityFile);
	if (identityPem.trim().length === 0) {
		throw new Error(`Lease '${lease.id}' SSH identity file is empty.`);
	}
	const knownHostsLine = buildToolVmKnownHostsLine({
		leaseId: lease.id,
		serverHostKey: Reflect.get(lease.sshAccess, 'serverHostKey'),
		tcpSlot: lease.tcpSlot,
	});
	return {
		agentId: lease.agentId,
		idleTtlMs: options.idleTtlMs,
		leaseId: lease.id,
		ssh: {
			host: `tool-${lease.tcpSlot}.vm.host`,
			identityPem,
			knownHostsLine,
			port: 22,
			user: lease.sshAccess.user ?? 'root',
		},
		tcpSlot: lease.tcpSlot,
		transport: 'ssh-sandbox',
		workdir: lease.guestWorkdir,
	};
}

export function serializeLeasePeekForResponse(lease: Lease): ControllerLeasePeekResponse {
	return {
		agentId: lease.agentId,
		createdAt: lease.createdAt,
		idleTtlMs: lease.effectiveIdleTtlMs,
		lastUsedAt: lease.lastUsedAt,
		leaseId: lease.id,
		profileId: lease.profileId,
		ssh: {
			host: lease.sshAccess.host,
			port: lease.sshAccess.port,
			user: lease.sshAccess.user ?? 'root',
		},
		tcpSlot: lease.tcpSlot,
		transport: 'ssh-sandbox',
		workdir: lease.guestWorkdir,
		zoneId: lease.zoneId,
	};
}
