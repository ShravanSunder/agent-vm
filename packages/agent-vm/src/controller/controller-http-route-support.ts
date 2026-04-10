import fs from 'node:fs/promises';

import type { Lease, LeaseManager } from './lease-manager.js';

export interface LeaseCreatePayload {
	readonly agentWorkspaceDir: string;
	readonly profileId: string;
	readonly scopeKey: string;
	readonly workspaceDir: string;
	readonly zoneId: string;
}

export interface ControllerRouteOperations {
	readonly destroyZone: (zoneId: string, purge: boolean) => Promise<unknown>;
	readonly enableSshForZone?: (zoneId: string) => Promise<unknown>;
	readonly execInZone?: (zoneId: string, command: string) => Promise<unknown>;
	readonly getStatus: () => Promise<unknown>;
	readonly getZoneLogs: (zoneId: string) => Promise<unknown>;
	readonly refreshZoneCredentials: (zoneId: string) => Promise<unknown>;
	readonly stopController?: () => Promise<unknown>;
	readonly upgradeZone: (zoneId: string) => Promise<unknown>;
}

export type ControllerLeaseManager = Pick<
	LeaseManager,
	'createLease' | 'getLease' | 'listLeases' | 'releaseLease'
>;

export function isLeaseCreatePayload(
	value: unknown,
): value is LeaseCreatePayload {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { agentWorkspaceDir?: unknown }).agentWorkspaceDir ===
			'string' &&
		typeof (value as { profileId?: unknown }).profileId === 'string' &&
		typeof (value as { scopeKey?: unknown }).scopeKey === 'string' &&
		typeof (value as { workspaceDir?: unknown }).workspaceDir === 'string' &&
		typeof (value as { zoneId?: unknown }).zoneId === 'string'
	);
}

export function isDestroyPayload(
	value: unknown,
): value is { readonly purge?: boolean } {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as { purge?: unknown };
	return candidate.purge === undefined || typeof candidate.purge === 'boolean';
}

export async function readIdentityPemFromFile(
	identityFilePath: string,
): Promise<string> {
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
