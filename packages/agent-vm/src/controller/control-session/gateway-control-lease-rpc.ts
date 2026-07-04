import type { GatewayControlLeaseSnapshot } from '@agent-vm/gateway-control-contracts';
import { normalizeToolVmActiveUseCorrelation } from '@agent-vm/gateway-interface';

import {
	type ControllerLeaseManager,
	readIdentityPemFromFile,
} from '../http/controller-http-route-support.js';
import type { ObservedControllerLeaseCreateRequest } from '../leases/observed-lease-create-request.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';
import type { GatewayControlLeaseRpcOperations } from './gateway-control-domain-handler.js';

type LeaseCreateOptions = Parameters<ControllerLeaseManager['createLease']>[0];
type GatewayControlLeaseCreatePayload = Parameters<
	GatewayControlLeaseRpcOperations['createLease']
>[0]['payload'];

export interface GatewayControlLeaseRpcControllerOptions {
	readonly leaseManager: ControllerLeaseManager;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly resolveLeaseCreateOptions: (options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseCreatePayload;
	}) => Promise<LeaseCreateOptions>;
}

function callerContextMatchesLeaseOwner(comparison: {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly owner: GatewayControlTrustedCallerContext;
}): boolean {
	return (
		comparison.callerContext.agentId === comparison.owner.agentId &&
		comparison.callerContext.agentWorkspaceDir === comparison.owner.agentWorkspaceDir &&
		comparison.callerContext.bootId === comparison.owner.bootId &&
		comparison.callerContext.controllerEpoch === comparison.owner.controllerEpoch &&
		comparison.callerContext.peerId === comparison.owner.peerId &&
		comparison.callerContext.purpose === comparison.owner.purpose &&
		comparison.callerContext.sessionKeyDigest === comparison.owner.sessionKeyDigest &&
		comparison.callerContext.workMountDir === comparison.owner.workMountDir &&
		comparison.callerContext.zoneId === comparison.owner.zoneId
	);
}

function serializeGatewayControlLeaseSnapshot(options: {
	readonly includeSsh: 'private' | 'public' | false;
	readonly lease: NonNullable<ReturnType<ControllerLeaseManager['peekLease']>>['lease'];
	readonly state?: GatewayControlLeaseSnapshot['state'];
	readonly readIdentityPem: (identityFilePath: string) => Promise<string>;
}): Promise<GatewayControlLeaseSnapshot> {
	return (async (): Promise<GatewayControlLeaseSnapshot> => {
		const baseSnapshot = {
			agentId: options.lease.agentId,
			idleTtlMs: options.lease.effectiveIdleTtlMs,
			leaseId: options.lease.id,
			state: options.state ?? 'idle',
			tcpSlot: options.lease.tcpSlot,
			transport: 'ssh-sandbox' as const,
			workdir: options.lease.guestWorkdir,
			zoneId: options.lease.zoneId,
		} satisfies Omit<GatewayControlLeaseSnapshot, 'ssh'>;
		if (options.includeSsh === false) {
			return baseSnapshot;
		}
		const publicSshAccess = {
			host: `tool-${options.lease.tcpSlot}.vm.host`,
			port: 22,
			user: options.lease.sshAccess.user ?? 'root',
		};
		if (options.includeSsh === 'public') {
			return {
				...baseSnapshot,
				ssh: publicSshAccess,
			};
		}
		if (!options.lease.sshAccess.identityFile) {
			throw new Error(`Lease '${options.lease.id}' does not have an SSH identity file.`);
		}
		const identityPem = await options.readIdentityPem(options.lease.sshAccess.identityFile);
		if (identityPem.trim().length === 0) {
			throw new Error(`Lease '${options.lease.id}' SSH identity file is empty.`);
		}
		return {
			...baseSnapshot,
			ssh: {
				...publicSshAccess,
				identityPem,
				knownHostsLine: '',
			},
		};
	})();
}

export function createGatewayControlLeaseRpcOperations(
	options: GatewayControlLeaseRpcControllerOptions,
): GatewayControlLeaseRpcOperations {
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;
	const leaseOwnerContextByLeaseId = new Map<string, GatewayControlTrustedCallerContext>();

	function recordLeaseOwner(record: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly leaseId: string;
	}): void {
		leaseOwnerContextByLeaseId.set(record.leaseId, record.callerContext);
	}

	function isOwnedLeaseRequest(payload: {
		readonly callerContext: GatewayControlTrustedCallerContext | undefined;
		readonly leaseId: string;
	}): boolean {
		const owner = leaseOwnerContextByLeaseId.get(payload.leaseId);
		if (owner === undefined || payload.callerContext === undefined) {
			return false;
		}
		return callerContextMatchesLeaseOwner({ callerContext: payload.callerContext, owner });
	}

	return {
		createLease: async ({ callerContext, payload }) => {
			const leaseCreateOptions = await options.resolveLeaseCreateOptions({
				callerContext,
				payload,
			});
			options.onLeaseCreateRequest?.({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				...(leaseCreateOptions.effectiveIdleTtlMs === undefined
					? {}
					: { idleTtlMs: leaseCreateOptions.effectiveIdleTtlMs }),
				profileId: leaseCreateOptions.profileId,
				sessionKeyDigest: callerContext.sessionKeyDigest,
				workMountDir: callerContext.workMountDir,
				zoneId: leaseCreateOptions.zoneId,
			});
			const lease = await options.leaseManager.createLease(leaseCreateOptions);
			recordLeaseOwner({
				callerContext,
				leaseId: lease.id,
			});
			return await serializeGatewayControlLeaseSnapshot({
				includeSsh: 'private',
				lease,
				readIdentityPem,
			});
		},
		endLeaseUse: async ({ callerContext, payload }) => {
			const { leaseId, useId } = payload;
			if (!isOwnedLeaseRequest({ callerContext, leaseId })) {
				return undefined;
			}
			const result = options.leaseManager.endActiveUse?.(leaseId, useId, {
				outcome: 'completed',
			});
			if (result === undefined || result.kind === 'unknown-use') {
				return undefined;
			}
			return {
				leaseId,
				state: 'ended',
				useId,
			};
		},
		getLease: async ({ callerContext, payload }, { includeSsh }) => {
			const { leaseId } = payload;
			if (!isOwnedLeaseRequest({ callerContext, leaseId })) {
				return undefined;
			}
			const leaseSnapshot = options.leaseManager.peekLease(leaseId);
			if (leaseSnapshot === undefined) {
				return undefined;
			}
			return await serializeGatewayControlLeaseSnapshot({
				includeSsh,
				lease: leaseSnapshot.lease,
				readIdentityPem,
			});
		},
		heartbeatLeaseUse: async ({ callerContext, payload }) => {
			const { leaseId, useId } = payload;
			if (!isOwnedLeaseRequest({ callerContext, leaseId })) {
				return undefined;
			}
			const heartbeat = options.leaseManager.heartbeatActiveUse?.(leaseId, useId, {});
			if (heartbeat === undefined) {
				return undefined;
			}
			return {
				expiresAt: heartbeat.expiresAt,
				heartbeatAfterMs: heartbeat.heartbeatAfterMs,
				leaseId,
				state: 'active',
				useId,
			};
		},
		releaseLease: async ({ callerContext, payload }) => {
			const { leaseId } = payload;
			if (!isOwnedLeaseRequest({ callerContext, leaseId })) {
				return undefined;
			}
			const leaseSnapshot = options.leaseManager.peekLease(leaseId);
			if (leaseSnapshot === undefined) {
				return undefined;
			}
			await options.leaseManager.releaseLease(leaseId);
			leaseOwnerContextByLeaseId.delete(leaseId);
			return await serializeGatewayControlLeaseSnapshot({
				includeSsh: false,
				lease: leaseSnapshot.lease,
				readIdentityPem,
				state: 'released',
			});
		},
		renewLease: async ({ callerContext, payload }) => {
			const { leaseId } = payload;
			if (!isOwnedLeaseRequest({ callerContext, leaseId })) {
				return undefined;
			}
			const renewal = await options.leaseManager.renewLease(leaseId);
			if (renewal.kind === 'not-found') {
				return undefined;
			}
			return await serializeGatewayControlLeaseSnapshot({
				includeSsh: 'private',
				lease: renewal.lease,
				readIdentityPem,
			});
		},
		startLeaseUse: async ({ callerContext, payload }) => {
			const { correlation, leaseId, useId } = payload;
			if (!isOwnedLeaseRequest({ callerContext, leaseId })) {
				return undefined;
			}
			const activeUse = options.leaseManager.startActiveUse?.(leaseId, {
				...(correlation === undefined
					? {}
					: { correlation: normalizeToolVmActiveUseCorrelation(correlation) }),
				useId,
			});
			if (activeUse === undefined) {
				return undefined;
			}
			return {
				expiresAt: activeUse.expiresAt,
				heartbeatAfterMs: activeUse.heartbeatAfterMs,
				leaseId,
				state: 'active',
				useId: activeUse.useId,
			};
		},
	};
}
