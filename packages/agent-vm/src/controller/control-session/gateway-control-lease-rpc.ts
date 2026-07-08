import type {
	GatewayControlLeaseReacquireIntentPayload,
	GatewayControlLeaseSnapshot,
} from '@agent-vm/gateway-control-contracts';
import {
	normalizeToolVmActiveUseCorrelation,
	type AgentVmHealthEvent,
} from '@agent-vm/gateway-interface';

import {
	type ControllerLeaseManager,
	readIdentityPemFromFile,
} from '../http/controller-http-route-support.js';
import type { ObservedControllerLeaseCreateRequest } from '../leases/observed-lease-create-request.js';
import {
	createToolVmLeaseAuthorityStore,
	type ToolVmLeaseStableOwner,
} from '../leases/tool-vm-lease-authority-store.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';
import type {
	GatewayControlLeaseRpcOperations,
	GatewayControlLeaseRpcRejection,
} from './gateway-control-domain-handler.js';

type LeaseCreateOptions = Parameters<ControllerLeaseManager['createLease']>[0];
type GatewayControlLeaseCreatePayload = Parameters<
	GatewayControlLeaseRpcOperations['createLease']
>[0]['payload'];
type ToolVmSshHealthEvent = Extract<AgentVmHealthEvent, { readonly kind: 'tool-vm-ssh' }>;

export interface GatewayControlLeaseRpcControllerOptions {
	readonly leaseManager: ControllerLeaseManager;
	readonly now?: () => number;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly recordHealthEvent?: (event: AgentVmHealthEvent) => void;
	readonly resolveLeaseCreateOptions: (options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseCreatePayload;
	}) => Promise<LeaseCreateOptions>;
}

function stableOwnerFromCallerContext(
	callerContext: GatewayControlTrustedCallerContext,
): ToolVmLeaseStableOwner {
	return {
		agentId: callerContext.agentId,
		agentWorkspaceDir: callerContext.agentWorkspaceDir,
		bootId: callerContext.bootId,
		controllerEpoch: callerContext.controllerEpoch,
		peerId: callerContext.peerId,
		purpose: callerContext.purpose,
		sessionKeyDigest: callerContext.sessionKeyDigest,
		workMountDir: callerContext.workMountDir,
		zoneId: callerContext.zoneId,
	};
}

function callerContextMatchesLeaseOwner(comparison: {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly owner: ToolVmLeaseStableOwner;
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

function zoneGitMountsMatch(
	leftMount: LeaseCreateOptions['zoneGitMount'],
	rightMount: LeaseCreateOptions['zoneGitMount'],
): boolean {
	if (leftMount === undefined || rightMount === undefined) {
		return leftMount === rightMount;
	}
	return (
		leftMount.hostZoneFilesDir === rightMount.hostZoneFilesDir &&
		leftMount.hostZoneGitRoot === rightMount.hostZoneGitRoot
	);
}

function leaseCreateCompatibilityMismatchFields(
	leftOptions: LeaseCreateOptions,
	rightOptions: LeaseCreateOptions,
): readonly string[] {
	const mismatchedFields: string[] = [];
	if (leftOptions.agentId !== rightOptions.agentId) {
		mismatchedFields.push('agentId');
	}
	if (leftOptions.agentWorkspaceDir !== rightOptions.agentWorkspaceDir) {
		mismatchedFields.push('agentWorkspaceDir');
	}
	if (leftOptions.effectiveIdleTtlMs !== rightOptions.effectiveIdleTtlMs) {
		mismatchedFields.push('effectiveIdleTtlMs');
	}
	if (leftOptions.guestWorkdir !== rightOptions.guestWorkdir) {
		mismatchedFields.push('guestWorkdir');
	}
	if (leftOptions.hostWorkMountDir !== rightOptions.hostWorkMountDir) {
		mismatchedFields.push('hostWorkMountDir');
	}
	if (leftOptions.profileId !== rightOptions.profileId) {
		mismatchedFields.push('profileId');
	}
	if (leftOptions.zoneId !== rightOptions.zoneId) {
		mismatchedFields.push('zoneId');
	}
	if (!zoneGitMountsMatch(leftOptions.zoneGitMount, rightOptions.zoneGitMount)) {
		mismatchedFields.push('zoneGitMount');
	}
	return mismatchedFields;
}

function leaseCreatePayloadFromReacquirePayload(
	payload: GatewayControlLeaseReacquireIntentPayload,
): GatewayControlLeaseCreatePayload {
	return {
		callerContext: payload.callerContext,
		...(payload.idleTtlHintMs === undefined ? {} : { idleTtlHintMs: payload.idleTtlHintMs }),
	};
}

function leaseRpcRejection(
	leaseRejectionReason: GatewayControlLeaseRpcRejection['leaseRejectionReason'],
): GatewayControlLeaseRpcRejection {
	return {
		leaseRejectionReason,
		result: 'rejected',
	};
}

function toolVmSshOperationFromReacquirePayload(
	payload: GatewayControlLeaseReacquireIntentPayload,
): ToolVmSshHealthEvent['operation'] {
	return payload.staleEvidence.kind === 'tool-vm-ssh' ? payload.staleEvidence.operation : 'probe';
}

function emitReacquireLifecycleEvent(options: {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly elapsedMs: number;
	readonly leaseRejectionReason?: GatewayControlLeaseRpcRejection['leaseRejectionReason'];
	readonly observedAtMs: number;
	readonly operation: ToolVmSshHealthEvent['operation'];
	readonly oldLeaseId: string;
	readonly recordHealthEvent: ((event: AgentVmHealthEvent) => void) | undefined;
	readonly replacementLeaseId?: string;
	readonly result: AgentVmHealthEvent['result'];
}): void {
	if (options.recordHealthEvent === undefined) {
		return;
	}
	const eventBase = {
		agentId: options.callerContext.agentId,
		callerContextState: 'ok' as const,
		elapsedMs: options.elapsedMs,
		kind: 'tool-vm-ssh' as const,
		leaseId: options.replacementLeaseId ?? options.oldLeaseId,
		...(options.leaseRejectionReason === undefined
			? {}
			: { leaseRejectionReason: options.leaseRejectionReason }),
		lifecycleEventRole: 'controller_final' as const,
		observedAtMs: options.observedAtMs,
		oldLeaseId: options.oldLeaseId,
		operation: options.operation,
		result: options.result,
		transitionId: `lease_reacquire:${options.oldLeaseId}`,
		zoneId: options.callerContext.zoneId,
	};
	if (options.replacementLeaseId === undefined) {
		options.recordHealthEvent({
			...eventBase,
			lifecycleTransition: 'stale_to_retired',
		});
		return;
	}
	options.recordHealthEvent({
		...eventBase,
		lifecycleTransition: 'stale_to_reacquired',
		replacementLeaseId: options.replacementLeaseId,
	});
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
	const now = options.now ?? (() => Date.now());
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;
	const leaseAuthorityStore = createToolVmLeaseAuthorityStore<LeaseCreateOptions>({ now });
	options.leaseManager.subscribeLeaseRetirement?.((event) => {
		leaseAuthorityStore.markRetired(event.leaseId);
	});

	function recordLeaseOwner(record: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly leaseCreateOptions: LeaseCreateOptions;
		readonly leaseId: string;
	}): void {
		leaseAuthorityStore.recordCurrent({
			compatibility: record.leaseCreateOptions,
			leaseId: record.leaseId,
			owner: stableOwnerFromCallerContext(record.callerContext),
		});
	}

	function isOwnedLeaseRequest(payload: {
		readonly callerContext: GatewayControlTrustedCallerContext | undefined;
		readonly leaseId: string;
	}): boolean {
		const authority = leaseAuthorityStore.resolve(payload.leaseId);
		if (
			authority === undefined ||
			authority.state !== 'current' ||
			payload.callerContext === undefined
		) {
			return false;
		}
		return callerContextMatchesLeaseOwner({
			callerContext: payload.callerContext,
			owner: authority.owner,
		});
	}

	async function resolveCurrentReacquireCompatibility(optionsToResolve: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly payload: GatewayControlLeaseReacquireIntentPayload;
	}): Promise<LeaseCreateOptions> {
		return await options.resolveLeaseCreateOptions({
			callerContext: optionsToResolve.callerContext,
			payload: leaseCreatePayloadFromReacquirePayload(optionsToResolve.payload),
		});
	}

	function isReacquireCompatibilityCurrent(optionsToCompare: {
		readonly authorityCompatibility: LeaseCreateOptions;
		readonly currentCompatibility: LeaseCreateOptions;
	}): boolean {
		return (
			leaseCreateCompatibilityMismatchFields(
				optionsToCompare.authorityCompatibility,
				optionsToCompare.currentCompatibility,
			).length === 0
		);
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
				leaseCreateOptions,
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
		reacquireLease: async ({ callerContext, payload }) => {
			const operation = toolVmSshOperationFromReacquirePayload(payload);
			const authority = leaseAuthorityStore.resolve(payload.oldLeaseId);
			if (authority === undefined) {
				emitReacquireLifecycleEvent({
					callerContext,
					elapsedMs: 0,
					leaseRejectionReason: 'lease_authority_absent',
					observedAtMs: Math.max(1, now()),
					operation,
					oldLeaseId: payload.oldLeaseId,
					recordHealthEvent: options.recordHealthEvent,
					result: 'failed',
				});
				return leaseRpcRejection('lease_authority_absent');
			}
			if (!callerContextMatchesLeaseOwner({ callerContext, owner: authority.owner })) {
				emitReacquireLifecycleEvent({
					callerContext,
					elapsedMs: 0,
					leaseRejectionReason: 'ownership_denied',
					observedAtMs: Math.max(1, now()),
					operation,
					oldLeaseId: payload.oldLeaseId,
					recordHealthEvent: options.recordHealthEvent,
					result: 'failed',
				});
				return leaseRpcRejection('ownership_denied');
			}
			const currentCompatibility = await resolveCurrentReacquireCompatibility({
				callerContext,
				payload,
			});
			if (
				!isReacquireCompatibilityCurrent({
					authorityCompatibility: authority.compatibility,
					currentCompatibility,
				})
			) {
				emitReacquireLifecycleEvent({
					callerContext,
					elapsedMs: 0,
					leaseRejectionReason: 'ownership_denied',
					observedAtMs: Math.max(1, now()),
					operation,
					oldLeaseId: payload.oldLeaseId,
					recordHealthEvent: options.recordHealthEvent,
					result: 'failed',
				});
				return leaseRpcRejection('ownership_denied');
			}
			if (authority.replacementLeaseId !== undefined) {
				const replacementSnapshot = options.leaseManager.peekLease(authority.replacementLeaseId);
				if (replacementSnapshot !== undefined) {
					return await serializeGatewayControlLeaseSnapshot({
						includeSsh: 'private',
						lease: replacementSnapshot.lease,
						readIdentityPem,
					});
				}
			}
			if (options.leaseManager.peekLease(payload.oldLeaseId) !== undefined) {
				await options.leaseManager.releaseLease(payload.oldLeaseId, { force: true });
			}
			leaseAuthorityStore.markRetired(payload.oldLeaseId);
			const replacementLease = await options.leaseManager.createLease(currentCompatibility);
			if (replacementLease.id === payload.oldLeaseId) {
				emitReacquireLifecycleEvent({
					callerContext,
					elapsedMs: 0,
					leaseRejectionReason: 'lease_reacquire_required',
					observedAtMs: Math.max(1, now()),
					operation,
					oldLeaseId: payload.oldLeaseId,
					recordHealthEvent: options.recordHealthEvent,
					result: 'failed',
				});
				return leaseRpcRejection('lease_reacquire_required');
			}
			leaseAuthorityStore.markReplaced(payload.oldLeaseId, replacementLease.id);
			recordLeaseOwner({
				callerContext,
				leaseCreateOptions: currentCompatibility,
				leaseId: replacementLease.id,
			});
			const replacementSnapshot = await serializeGatewayControlLeaseSnapshot({
				includeSsh: 'private',
				lease: replacementLease,
				readIdentityPem,
			});
			emitReacquireLifecycleEvent({
				callerContext,
				elapsedMs: 0,
				observedAtMs: Math.max(1, now()),
				operation,
				oldLeaseId: payload.oldLeaseId,
				recordHealthEvent: options.recordHealthEvent,
				replacementLeaseId: replacementLease.id,
				result: 'ok',
			});
			return replacementSnapshot;
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
			leaseAuthorityStore.markRetired(leaseId);
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
				leaseAuthorityStore.markRetired(leaseId);
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
