import {
	normalizeToolVmActiveUseCorrelation,
	type AgentVmHealthEvent,
} from '@agent-vm/gateway-contracts';
import type {
	GatewayControlLeaseCreateIntentPayload,
	GatewayControlLeaseIdPayload,
	GatewayControlLeaseReacquireIntentPayload,
	GatewayControlLeaseSnapshot,
	GatewayControlLeaseUseEndPayload,
	GatewayControlLeaseUseHeartbeatPayload,
	GatewayControlLeaseUseStartPayload,
} from '@agent-vm/gateway-control-contracts';
import {
	GatewayControlLeaseCreateIntentPayloadSchema,
	GatewayControlLeaseIdPayloadSchema,
	GatewayControlLeaseReacquireIntentPayloadSchema,
	GatewayControlLeaseUseEndPayloadSchema,
	GatewayControlLeaseUseHeartbeatPayloadSchema,
	GatewayControlLeaseUseStartPayloadSchema,
} from '@agent-vm/gateway-control-contracts';

import {
	type ControllerLeaseManager,
	readIdentityPemFromFile,
} from '../http/controller-http-route-support.js';
import { resolveToolVmLeaseCompatibility } from '../leases/lease-manager.js';
import type { ObservedControllerLeaseCreateRequest } from '../leases/observed-lease-create-request.js';
import type { ToolVmLeaseCompatibility } from '../leases/tool-vm-lease-authority-state.js';
import { buildToolVmKnownHostsLine } from '../leases/tool-vm-ssh-server-identity.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';
import type {
	GatewayControlLeaseRpcOperations,
	GatewayControlLeaseRpcRejection,
	GatewayControlLeaseSemanticMutationResult,
	GatewayControlLeaseSemanticMutationOperation,
	GatewayControlLeaseSemanticMutationPayload,
	GatewayControlPreparedLeaseSemanticMutation,
} from './gateway-control-domain-handler.js';
import type { GatewaySemanticExecutionProof } from './gateway-semantic-result-ledger.js';

type LeaseCreateOptions = Parameters<ControllerLeaseManager['createLease']>[0];
type GatewayControlLeaseManager = ControllerLeaseManager &
	Required<Pick<ControllerLeaseManager, 'getLeaseAuthority'>>;
type GatewayControlLeaseCreatePayload = GatewayControlLeaseCreateIntentPayload;
type ToolVmSshHealthEvent = Extract<AgentVmHealthEvent, { readonly kind: 'tool-vm-ssh' }>;

interface LeaseMutationExecutionContext<TPayload> {
	readonly attachmentGeneration: number;
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly gateway: GatewayEpochIdentity;
	readonly payload: TPayload;
	readonly processEpoch: string;
	readonly proof: GatewaySemanticExecutionProof;
}

export interface GatewayControlLeaseRpcControllerOptions {
	readonly leaseManager: GatewayControlLeaseManager;
	readonly now?: () => number;
	readonly onLeaseCreateRequest?: (request: ObservedControllerLeaseCreateRequest) => void;
	readonly readIdentityPem?: (identityFilePath: string) => Promise<string>;
	readonly recordHealthEvent?: (event: AgentVmHealthEvent) => void;
	readonly resolveLeaseCreateOptions: (options: {
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly gateway: GatewayEpochIdentity;
		readonly payload: GatewayControlLeaseCreatePayload;
	}) => Promise<LeaseCreateOptions>;
	readonly seedLeaseWorkspace?: (leaseCreateOptions: LeaseCreateOptions) => Promise<void>;
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

function safeErrorName(error: unknown): string {
	return error instanceof Error && error.name.length > 0 ? error.name : 'unknown';
}

function safeControllerRequestErrorCode(options: {
	readonly error: unknown;
	readonly stage: string;
}): string {
	return `${options.stage}:${safeErrorName(options.error)}`;
}

type CurrentLeaseAuthorityDecision =
	| {
			readonly authority: NonNullable<ReturnType<GatewayControlLeaseManager['getLeaseAuthority']>>;
			readonly status: 'accepted';
	  }
	| {
			readonly rejection: GatewayControlLeaseRpcRejection;
			readonly status: 'rejected';
	  }
	| {
			readonly status: 'absent';
	  };

interface LeaseAuthoritySemanticProfileResolution {
	readonly decision: CurrentLeaseAuthorityDecision;
	readonly profile: {
		readonly compatibilityId: string;
		readonly currentLeafTargetId: string | null;
		readonly kind: 'lease_authority';
		readonly stablePrincipal: string;
	};
}

function isReacquireCompatibilityCurrent(optionsToCompare: {
	readonly authorityCompatibility: ToolVmLeaseCompatibility;
	readonly currentCompatibility: ToolVmLeaseCompatibility;
}): boolean {
	return (
		optionsToCompare.authorityCompatibility.policyFingerprint ===
			optionsToCompare.currentCompatibility.policyFingerprint &&
		optionsToCompare.authorityCompatibility.profileId ===
			optionsToCompare.currentCompatibility.profileId &&
		optionsToCompare.authorityCompatibility.purpose ===
			optionsToCompare.currentCompatibility.purpose &&
		optionsToCompare.authorityCompatibility.workMountDir ===
			optionsToCompare.currentCompatibility.workMountDir
	);
}

function toolVmSshOperationFromReacquirePayload(
	payload: GatewayControlLeaseReacquireIntentPayload,
): ToolVmSshHealthEvent['operation'] {
	return payload.staleEvidence.kind === 'tool-vm-ssh' ? payload.staleEvidence.operation : 'probe';
}

function emitReacquireLifecycleEvent(options: {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly elapsedMs: number;
	readonly callerContextState?: ToolVmSshHealthEvent['callerContextState'];
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
		callerContextState:
			options.callerContextState ??
			(options.leaseRejectionReason === undefined
				? 'ok'
				: callerContextStateForLeaseRejection(options.leaseRejectionReason)),
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
			lifecycleTransition: 'retired_rejected',
		});
		return;
	}
	options.recordHealthEvent({
		...eventBase,
		lifecycleTransition: 'stale_to_reacquired',
		replacementLeaseId: options.replacementLeaseId,
	});
}

function callerContextStateForLeaseRejection(
	leaseRejectionReason: GatewayControlLeaseRpcRejection['leaseRejectionReason'],
): ToolVmSshHealthEvent['callerContextState'] {
	switch (leaseRejectionReason) {
		case 'caller_context_absent':
		case 'lease_absent':
		case 'lease_authority_absent':
			return 'absent';
		case 'caller_context_session_mismatch':
			return 'session_mismatch';
		case 'caller_context_stale':
		case 'lease_generation_stale':
			return 'stale';
		case 'lease_force_released':
		case 'lease_reacquire_required':
		case 'lease_releasing':
		case 'lease_retired':
		case 'lease_use_tombstoned':
		case 'ownership_denied':
		case 'runtime_not_ready':
			return 'not_applicable';
	}
	const exhaustiveReason: never = leaseRejectionReason;
	return exhaustiveReason;
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
		const knownHostsLine = buildToolVmKnownHostsLine({
			leaseId: options.lease.id,
			serverHostKey: Reflect.get(options.lease.sshAccess, 'serverHostKey'),
			tcpSlot: options.lease.tcpSlot,
		});
		return {
			...baseSnapshot,
			ssh: {
				...publicSshAccess,
				identityPem,
				knownHostsLine,
			},
		};
	})();
}

export function createGatewayControlLeaseRpcOperations(
	options: GatewayControlLeaseRpcControllerOptions,
): GatewayControlLeaseRpcOperations {
	const now = options.now ?? (() => Date.now());
	const readIdentityPem = options.readIdentityPem ?? readIdentityPemFromFile;

	function resolveCurrentLeaseAuthorityDecision(payload: {
		readonly callerContext: GatewayControlTrustedCallerContext | undefined;
		readonly gateway: GatewayEpochIdentity;
		readonly leaseId: string;
	}): CurrentLeaseAuthorityDecision {
		const authority = options.leaseManager.getLeaseAuthority(payload.leaseId);
		if (authority === undefined || payload.callerContext === undefined) {
			return { status: 'absent' };
		}
		if (
			!gatewayIdentitiesEqual(authority.authority.gateway, payload.gateway) ||
			authority.authority.principal.agentId !== payload.callerContext.agentId ||
			authority.authority.principal.zoneId !== payload.callerContext.zoneId
		) {
			return {
				rejection: leaseRpcRejection('ownership_denied'),
				status: 'rejected',
			};
		}
		return { authority, status: 'accepted' };
	}

	const mutationOperations = {
		createLease: async ({
			callerContext,
			leaseCreateOptions,
		}: {
			readonly callerContext: GatewayControlTrustedCallerContext;
			readonly leaseCreateOptions: LeaseCreateOptions;
		}) => {
			let stage = 'seed_lease_workspace';
			try {
				await options.seedLeaseWorkspace?.(leaseCreateOptions);
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
				stage = 'lease_manager_create_lease';
				const lease = await options.leaseManager.createLease(leaseCreateOptions);
				stage = 'serialize_lease_snapshot';
				return await serializeGatewayControlLeaseSnapshot({
					includeSsh: 'private',
					lease,
					readIdentityPem,
				});
			} catch (error) {
				options.recordHealthEvent?.({
					attempt: 1,
					elapsedMs: 0,
					errorCode: safeControllerRequestErrorCode({ error, stage }),
					kind: 'controller-request',
					maxAttempts: 1,
					observedAtMs: Math.max(1, now()),
					operation: 'lease-create',
					result: 'failed',
					sessionKeyDigest: callerContext.sessionKeyDigest,
					statusCode: 500,
					zoneId: callerContext.zoneId,
				});
				throw error;
			}
		},
		endLeaseUse: async ({
			attachmentGeneration,
			callerContext,
			gateway,
			payload,
			processEpoch,
		}: LeaseMutationExecutionContext<GatewayControlLeaseUseEndPayload>): Promise<GatewayControlLeaseSemanticMutationResult> => {
			const { leaseId, useId } = payload;
			const authorityDecision = resolveCurrentLeaseAuthorityDecision({
				callerContext,
				gateway,
				leaseId,
			});
			if (authorityDecision.status === 'rejected') {
				return authorityDecision.rejection;
			}
			if (authorityDecision.status === 'absent') {
				return undefined;
			}
			const result = options.leaseManager.endActiveUse?.(leaseId, useId, {
				authority: {
					gateway,
					principal: { agentId: callerContext.agentId, zoneId: callerContext.zoneId },
				},
				outcome: payload.reason === 'completed' ? 'completed' : 'failed',
				processEpoch,
				sessionAttachmentGeneration: attachmentGeneration,
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
		getLease: (async ({ callerContext, gateway, payload }, { includeSsh }) => {
			const { leaseId } = payload;
			const authorityDecision = resolveCurrentLeaseAuthorityDecision({
				callerContext,
				gateway,
				leaseId,
			});
			if (authorityDecision.status === 'rejected') {
				return authorityDecision.rejection;
			}
			if (authorityDecision.status === 'absent') {
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
		}) satisfies GatewayControlLeaseRpcOperations['getLease'],
		reacquireLease: async ({
			callerContext,
			gateway,
			leaseCreateOptions,
			payload,
		}: LeaseMutationExecutionContext<GatewayControlLeaseReacquireIntentPayload> & {
			readonly leaseCreateOptions?: LeaseCreateOptions;
		}) => {
			const operation = toolVmSshOperationFromReacquirePayload(payload);
			const authorityDecision = resolveCurrentLeaseAuthorityDecision({
				callerContext,
				gateway,
				leaseId: payload.oldLeaseId,
			});
			if (authorityDecision.status !== 'accepted') {
				const leaseRejectionReason =
					authorityDecision.status === 'rejected'
						? authorityDecision.rejection.leaseRejectionReason
						: 'lease_authority_absent';
				emitReacquireLifecycleEvent({
					callerContext,
					elapsedMs: 0,
					leaseRejectionReason,
					observedAtMs: Math.max(1, now()),
					operation,
					oldLeaseId: payload.oldLeaseId,
					recordHealthEvent: options.recordHealthEvent,
					result: 'failed',
				});
				return leaseRpcRejection(leaseRejectionReason);
			}
			if (leaseCreateOptions === undefined) {
				throw new Error('Lease reacquire execution is missing prepared lease create options.');
			}
			if (
				!isReacquireCompatibilityCurrent({
					authorityCompatibility: authorityDecision.authority.compatibility,
					currentCompatibility: resolveToolVmLeaseCompatibility(leaseCreateOptions),
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
			await options.seedLeaseWorkspace?.(leaseCreateOptions);
			if (options.leaseManager.peekLease(payload.oldLeaseId) !== undefined) {
				try {
					await options.leaseManager.releaseLease(payload.oldLeaseId, { force: true });
				} catch (error) {
					if (options.leaseManager.peekLease(payload.oldLeaseId) !== undefined) {
						throw error;
					}
				}
			}
			const replacementLease = await options.leaseManager.createLease(leaseCreateOptions);
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
		heartbeatLeaseUse: async ({
			attachmentGeneration,
			callerContext,
			gateway,
			payload,
			processEpoch,
		}: LeaseMutationExecutionContext<GatewayControlLeaseUseHeartbeatPayload>): Promise<GatewayControlLeaseSemanticMutationResult> => {
			const { leaseId, useId } = payload;
			const authorityDecision = resolveCurrentLeaseAuthorityDecision({
				callerContext,
				gateway,
				leaseId,
			});
			if (authorityDecision.status === 'rejected') {
				return authorityDecision.rejection;
			}
			if (authorityDecision.status === 'absent') {
				return undefined;
			}
			const heartbeat = options.leaseManager.heartbeatActiveUse?.(leaseId, useId, {
				authority: {
					gateway,
					principal: { agentId: callerContext.agentId, zoneId: callerContext.zoneId },
				},
				processEpoch,
				sessionAttachmentGeneration: attachmentGeneration,
			});
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
		releaseLease: async ({
			callerContext,
			gateway,
			payload,
		}: LeaseMutationExecutionContext<GatewayControlLeaseIdPayload>) => {
			const { leaseId } = payload;
			const authorityDecision = resolveCurrentLeaseAuthorityDecision({
				callerContext,
				gateway,
				leaseId,
			});
			if (authorityDecision.status === 'rejected') {
				return authorityDecision.rejection;
			}
			if (authorityDecision.status === 'absent') {
				return undefined;
			}
			const leaseSnapshot = options.leaseManager.peekLease(leaseId);
			if (leaseSnapshot === undefined) {
				return undefined;
			}
			await options.leaseManager.releaseLease(leaseId);
			return await serializeGatewayControlLeaseSnapshot({
				includeSsh: false,
				lease: leaseSnapshot.lease,
				readIdentityPem,
				state: 'released',
			});
		},
		renewLease: async ({
			callerContext,
			gateway,
			payload,
		}: LeaseMutationExecutionContext<GatewayControlLeaseIdPayload>) => {
			const { leaseId } = payload;
			const authorityDecision = resolveCurrentLeaseAuthorityDecision({
				callerContext,
				gateway,
				leaseId,
			});
			if (authorityDecision.status === 'rejected') {
				return authorityDecision.rejection;
			}
			if (authorityDecision.status === 'absent') {
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
		startLeaseUse: async ({
			attachmentGeneration,
			callerContext,
			gateway,
			payload,
			processEpoch,
			proof,
		}: LeaseMutationExecutionContext<GatewayControlLeaseUseStartPayload>): Promise<GatewayControlLeaseSemanticMutationResult> => {
			const { correlation, leaseId, useId } = payload;
			const authorityDecision = resolveCurrentLeaseAuthorityDecision({
				callerContext,
				gateway,
				leaseId,
			});
			if (authorityDecision.status === 'rejected') {
				return authorityDecision.rejection;
			}
			if (authorityDecision.status === 'absent') {
				return undefined;
			}
			const activeUse = options.leaseManager.startActiveUse?.(leaseId, {
				authority: {
					gateway,
					principal: { agentId: callerContext.agentId, zoneId: callerContext.zoneId },
				},
				...(correlation === undefined
					? {}
					: { correlation: normalizeToolVmActiveUseCorrelation(correlation) }),
				operationPayloadDigest: `v1:sha256:${proof.operationPayloadDigest.digest}`,
				processEpoch,
				semanticOperationId: proof.semanticOperationId,
				sessionAttachmentGeneration: attachmentGeneration,
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

	async function prepareSemanticMutation(optionsToPrepare: {
		readonly attachmentGeneration: number;
		readonly callerContext: GatewayControlTrustedCallerContext;
		readonly gateway: GatewayEpochIdentity;
		readonly operation: GatewayControlLeaseSemanticMutationOperation;
		readonly payload: GatewayControlLeaseSemanticMutationPayload;
		readonly processEpoch: string;
	}): Promise<GatewayControlPreparedLeaseSemanticMutation> {
		const executeContext = <TPayload>(
			payload: TPayload,
			proof: GatewaySemanticExecutionProof,
		): LeaseMutationExecutionContext<TPayload> => ({
			attachmentGeneration: optionsToPrepare.attachmentGeneration,
			callerContext: optionsToPrepare.callerContext,
			gateway: optionsToPrepare.gateway,
			payload,
			processEpoch: optionsToPrepare.processEpoch,
			proof,
		});
		if (optionsToPrepare.operation === 'lease_create') {
			const payload = GatewayControlLeaseCreateIntentPayloadSchema.parse(optionsToPrepare.payload);
			const leaseOptions = await options.resolveLeaseCreateOptions({
				callerContext: optionsToPrepare.callerContext,
				gateway: optionsToPrepare.gateway,
				payload,
			});
			const compatibility = resolveToolVmLeaseCompatibility(leaseOptions);
			return {
				execute: async () =>
					await mutationOperations.createLease({
						callerContext: optionsToPrepare.callerContext,
						leaseCreateOptions: leaseOptions,
					}),
				profile: {
					compatibilityId: compatibility.policyFingerprint,
					currentLeafTargetId: null,
					kind: 'lease_authority' as const,
					stablePrincipal: optionsToPrepare.callerContext.stablePrincipal,
				},
				target: `principal:${optionsToPrepare.callerContext.stablePrincipal}`,
			};
		}
		const parseLeaseAuthorityProfile = (
			leaseId: string,
		): LeaseAuthoritySemanticProfileResolution => {
			const decision = resolveCurrentLeaseAuthorityDecision({
				callerContext: optionsToPrepare.callerContext,
				gateway: optionsToPrepare.gateway,
				leaseId,
			});
			return {
				decision,
				profile: {
					compatibilityId:
						decision.status === 'accepted'
							? decision.authority.compatibility.policyFingerprint
							: 'lease-authority-absent',
					currentLeafTargetId:
						decision.status === 'accepted' ? decision.authority.authority.leafGeneration : null,
					kind: 'lease_authority' as const,
					stablePrincipal: optionsToPrepare.callerContext.stablePrincipal,
				},
			};
		};
		switch (optionsToPrepare.operation) {
			case 'lease_reacquire': {
				const payload = GatewayControlLeaseReacquireIntentPayloadSchema.parse(
					optionsToPrepare.payload,
				);
				const { decision, profile } = parseLeaseAuthorityProfile(payload.oldLeaseId);
				const leaseCreateOptions =
					decision.status === 'accepted'
						? await options.resolveLeaseCreateOptions({
								callerContext: optionsToPrepare.callerContext,
								gateway: optionsToPrepare.gateway,
								payload: leaseCreatePayloadFromReacquirePayload(payload),
							})
						: undefined;
				const semanticProfile =
					leaseCreateOptions === undefined
						? profile
						: {
								...profile,
								compatibilityId:
									resolveToolVmLeaseCompatibility(leaseCreateOptions).policyFingerprint,
							};
				return {
					execute: async (proof: GatewaySemanticExecutionProof) =>
						await mutationOperations.reacquireLease({
							...executeContext(payload, proof),
							...(leaseCreateOptions === undefined ? {} : { leaseCreateOptions }),
						}),
					profile: semanticProfile,
					target: `lease:${payload.oldLeaseId}`,
				};
			}
			case 'lease_release':
			case 'lease_renew': {
				const payload = GatewayControlLeaseIdPayloadSchema.parse(optionsToPrepare.payload);
				const { profile } = parseLeaseAuthorityProfile(payload.leaseId);
				const execute =
					optionsToPrepare.operation === 'lease_release'
						? async (proof: GatewaySemanticExecutionProof) =>
								await mutationOperations.releaseLease(executeContext(payload, proof))
						: async (proof: GatewaySemanticExecutionProof) =>
								await mutationOperations.renewLease(executeContext(payload, proof));
				return { execute, profile, target: `lease:${payload.leaseId}` };
			}
			case 'lease_use_start':
			case 'lease_use_heartbeat':
			case 'lease_use_end': {
				const payload =
					optionsToPrepare.operation === 'lease_use_start'
						? GatewayControlLeaseUseStartPayloadSchema.parse(optionsToPrepare.payload)
						: optionsToPrepare.operation === 'lease_use_heartbeat'
							? GatewayControlLeaseUseHeartbeatPayloadSchema.parse(optionsToPrepare.payload)
							: GatewayControlLeaseUseEndPayloadSchema.parse(optionsToPrepare.payload);
				const decision = resolveCurrentLeaseAuthorityDecision({
					callerContext: optionsToPrepare.callerContext,
					gateway: optionsToPrepare.gateway,
					leaseId: payload.leaseId,
				});
				const profile = {
					kind: 'active_use' as const,
					leafGeneration:
						decision.status === 'accepted'
							? decision.authority.authority.leafGeneration
							: 'lease-authority-absent',
					processEpoch: optionsToPrepare.processEpoch,
					stablePrincipal: optionsToPrepare.callerContext.stablePrincipal,
					useId: payload.useId,
				};
				const execute = async (
					proof: GatewaySemanticExecutionProof,
				): Promise<GatewayControlLeaseSemanticMutationResult> => {
					if (optionsToPrepare.operation === 'lease_use_start') {
						return await mutationOperations.startLeaseUse(
							executeContext(GatewayControlLeaseUseStartPayloadSchema.parse(payload), proof),
						);
					}
					if (optionsToPrepare.operation === 'lease_use_heartbeat') {
						return await mutationOperations.heartbeatLeaseUse(
							executeContext(GatewayControlLeaseUseHeartbeatPayloadSchema.parse(payload), proof),
						);
					}
					return await mutationOperations.endLeaseUse(
						executeContext(GatewayControlLeaseUseEndPayloadSchema.parse(payload), proof),
					);
				};
				return { execute, profile, target: `lease:${payload.leaseId}:use:${payload.useId}` };
			}
		}
		optionsToPrepare.operation satisfies never;
		throw new Error('Unsupported gateway control lease semantic mutation operation.');
	}

	return {
		getLease: mutationOperations.getLease,
		prepareSemanticMutation,
	};
}
