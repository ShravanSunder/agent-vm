import type {
	GatewayControlLeaseCreateIntentPayload,
	GatewayControlLeaseIdPayload,
	GatewayControlLeaseReacquireIntentPayload,
	GatewayControlLeaseSnapshot,
	GatewayControlLeaseUseEndPayload,
	GatewayControlLeaseUseHeartbeatPayload,
	GatewayControlLeaseUseStartPayload,
	GatewayControlToolVmBindingAccessGrant,
} from '@agent-vm/gateway-control-contracts';
import {
	GatewayControlLeaseCreateIntentPayloadSchema,
	GatewayControlLeaseIdPayloadSchema,
	GatewayControlLeaseReacquireIntentPayloadSchema,
	GatewayControlLeaseUseEndPayloadSchema,
	GatewayControlLeaseUseHeartbeatPayloadSchema,
	GatewayControlLeaseUseStartPayloadSchema,
	GatewayControlPrivateLeaseSnapshotSchema,
	GatewayControlToolVmBindingAccessGrantSchema,
} from '@agent-vm/gateway-control-contracts';
import {
	normalizeToolVmActiveUseCorrelation,
	type AgentVmHealthEvent,
} from '@agent-vm/gateway-lifecycle';

import {
	type ControllerLeaseManager,
	readIdentityPemFromFile,
} from '../http/controller-http-route-support.js';
import { resolveToolVmLeaseCompatibility, type LeaseManager } from '../leases/lease-manager.js';
import type { ToolVmLeaseRetirementEvent } from '../leases/lease-manager.js';
import type { ObservedControllerLeaseCreateRequest } from '../leases/observed-lease-create-request.js';
import type {
	AuthorizedToolVmLeafBinding,
	StableToolVmLeasePrincipal,
} from '../leases/tool-vm-lease-authority-contracts.js';
import { stableToolVmLeasePrincipalsEqual } from '../leases/tool-vm-lease-authority-state-helpers.js';
import type { ToolVmLeaseCompatibility } from '../leases/tool-vm-lease-authority-state.js';
import { buildToolVmKnownHostsLine } from '../leases/tool-vm-ssh-server-identity.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { GatewayControlToolVmBindingCreator } from './gateway-control-binding-publication.js';
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
type GatewayControlLease = NonNullable<ReturnType<ControllerLeaseManager['peekLease']>>['lease'];
type GatewayControlLeaseManager = ControllerLeaseManager &
	Required<
		Pick<
			LeaseManager,
			| 'getCurrentNonterminalUses'
			| 'getCurrentLeaseBinding'
			| 'getLeaseAuthority'
			| 'reacquireLease'
			| 'subscribeLeaseRetirement'
		>
	>;
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
	}) => Promise<Omit<LeaseCreateOptions, 'principal'>>;
}

export interface GatewayControlBindingPublicationSource extends GatewayControlToolVmBindingCreator {
	readonly subscribeBindingRetirement: (
		listener: (event: ToolVmLeaseRetirementEvent) => Promise<void>,
	) => () => void;
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

function leasePrincipalFromCallerContext(
	callerContext: GatewayControlTrustedCallerContext,
): StableToolVmLeasePrincipal {
	return callerContext.principal;
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
		optionsToCompare.authorityCompatibility.profileAssignmentRevision ===
			optionsToCompare.currentCompatibility.profileAssignmentRevision
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

function assertCurrentBindingMatchesLiveLease(options: {
	readonly currentBinding: AuthorizedToolVmLeafBinding;
	readonly lease: GatewayControlLease;
}): void {
	const expectedSshUser = options.lease.sshAccess.user ?? 'root';
	const expectedServerIdentity = JSON.stringify(
		Reflect.get(options.lease.sshAccess, 'serverHostKey'),
	);
	if (
		options.currentBinding.leaseId !== options.lease.id ||
		options.currentBinding.runtimeBinding.runtimeRecordId !== options.lease.runtimeRecordId ||
		options.currentBinding.runtimeBinding.tcpSlot !== options.lease.tcpSlot ||
		options.currentBinding.runtimeBinding.vmId !== options.lease.vm.id ||
		options.currentBinding.sshBinding.host !== options.lease.sshAccess.host ||
		options.currentBinding.sshBinding.identityFile !== options.lease.sshAccess.identityFile ||
		options.currentBinding.sshBinding.port !== options.lease.sshAccess.port ||
		options.currentBinding.sshBinding.serverIdentity !== expectedServerIdentity ||
		options.currentBinding.sshBinding.user !== expectedSshUser
	) {
		throw new Error(
			`Lease '${options.lease.id}' current authority binding does not match its live runtime.`,
		);
	}
}

function serializeGatewayControlLeaseSnapshot(options: {
	readonly currentBinding?: AuthorizedToolVmLeafBinding | undefined;
	readonly includeSsh: 'private' | 'public' | false;
	readonly lease: GatewayControlLease;
	readonly readCurrentBinding?:
		| ((leaseId: string) => AuthorizedToolVmLeafBinding | undefined)
		| undefined;
	readonly readCurrentNonterminalUses?: LeaseManager['getCurrentNonterminalUses'] | undefined;
	readonly state?: GatewayControlLeaseSnapshot['state'];
	readonly readIdentityPem: (identityFilePath: string) => Promise<string>;
}): Promise<GatewayControlLeaseSnapshot> {
	return (async (): Promise<GatewayControlLeaseSnapshot> => {
		const baseSnapshot = {
			agentId: options.lease.agentId,
			idleTtlMs: options.lease.effectiveIdleTtlMs,
			leaseId: options.lease.id,
			tcpSlot: options.lease.tcpSlot,
			transport: 'ssh-sandbox' as const,
			workdir: options.lease.guestWorkdir,
			zoneId: options.lease.zoneId,
		} satisfies Omit<GatewayControlLeaseSnapshot, 'activeUseId' | 'expiresAtMs' | 'ssh' | 'state'>;
		const readStateFields = (): Pick<
			GatewayControlLeaseSnapshot,
			'activeUseId' | 'expiresAtMs' | 'state'
		> => {
			if (options.state !== undefined) {
				return { state: options.state };
			}
			const currentUses = options.readCurrentNonterminalUses?.(options.lease.id) ?? [];
			const currentUse = currentUses[0];
			if (currentUse === undefined) {
				return { state: 'idle' };
			}
			return currentUses.length === 1
				? {
						activeUseId: currentUse.useId,
						expiresAtMs: currentUse.expiresAtMs,
						state: 'active',
					}
				: { state: 'active' };
		};
		if (options.includeSsh === false) {
			return { ...baseSnapshot, ...readStateFields() };
		}
		const publicSshAccess = {
			host: `tool-${options.lease.tcpSlot}.vm.host`,
			port: 22,
			user: options.lease.sshAccess.user ?? 'root',
		};
		if (options.includeSsh === 'public') {
			return {
				...baseSnapshot,
				...readStateFields(),
				ssh: publicSshAccess,
			};
		}
		const currentBinding = options.currentBinding;
		if (currentBinding === undefined) {
			throw new Error(`Lease '${options.lease.id}' does not have a current authority binding.`);
		}
		if (!options.lease.sshAccess.identityFile) {
			throw new Error(`Lease '${options.lease.id}' does not have an SSH identity file.`);
		}
		assertCurrentBindingMatchesLiveLease({ currentBinding, lease: options.lease });
		const identityPem = await options.readIdentityPem(options.lease.sshAccess.identityFile);
		if (identityPem.trim().length === 0) {
			throw new Error(`Lease '${options.lease.id}' SSH identity file is empty.`);
		}
		const revalidatedBinding = options.readCurrentBinding?.(options.lease.id);
		if (
			revalidatedBinding === undefined ||
			revalidatedBinding.leafGeneration !== currentBinding.leafGeneration ||
			revalidatedBinding.sshBinding.bindingId !== currentBinding.sshBinding.bindingId
		) {
			throw new Error(
				`Lease '${options.lease.id}' current authority binding changed during private serialization.`,
			);
		}
		assertCurrentBindingMatchesLiveLease({
			currentBinding: revalidatedBinding,
			lease: options.lease,
		});
		const knownHostsLine = buildToolVmKnownHostsLine({
			leaseId: options.lease.id,
			serverHostKey: Reflect.get(options.lease.sshAccess, 'serverHostKey'),
			tcpSlot: options.lease.tcpSlot,
		});
		return GatewayControlPrivateLeaseSnapshotSchema.parse({
			...baseSnapshot,
			...readStateFields(),
			leafGeneration: currentBinding.leafGeneration,
			ssh: {
				...publicSshAccess,
				identityPem,
				knownHostsLine,
			},
			sshBindingId: currentBinding.sshBinding.bindingId,
		});
	})();
}

async function serializeGatewayControlToolVmBindingAccessGrant(options: {
	readonly currentBinding: AuthorizedToolVmLeafBinding | undefined;
	readonly lease: GatewayControlLease;
	readonly profileAssignmentRevision: string;
	readonly readCurrentBinding: (leaseId: string) => AuthorizedToolVmLeafBinding | undefined;
	readonly readIdentityPem: (identityFilePath: string) => Promise<string>;
	readonly stablePrincipal: string;
}): Promise<GatewayControlToolVmBindingAccessGrant> {
	const currentBinding = options.currentBinding;
	if (currentBinding === undefined) {
		throw new Error(`Lease '${options.lease.id}' does not have a current authority binding.`);
	}
	if (!options.lease.sshAccess.identityFile) {
		throw new Error(`Lease '${options.lease.id}' does not have an SSH identity file.`);
	}
	assertCurrentBindingMatchesLiveLease({ currentBinding, lease: options.lease });
	const identityPem = await options.readIdentityPem(options.lease.sshAccess.identityFile);
	if (identityPem.trim().length === 0) {
		throw new Error(`Lease '${options.lease.id}' SSH identity file is empty.`);
	}
	const revalidatedBinding = options.readCurrentBinding(options.lease.id);
	if (
		revalidatedBinding === undefined ||
		revalidatedBinding.leafGeneration !== currentBinding.leafGeneration ||
		revalidatedBinding.sshBinding.bindingId !== currentBinding.sshBinding.bindingId
	) {
		throw new Error(
			`Lease '${options.lease.id}' current authority binding changed during private serialization.`,
		);
	}
	assertCurrentBindingMatchesLiveLease({
		currentBinding: revalidatedBinding,
		lease: options.lease,
	});
	return GatewayControlToolVmBindingAccessGrantSchema.parse({
		agentId: options.lease.agentId,
		idleTtlMs: options.lease.effectiveIdleTtlMs,
		leafGeneration: revalidatedBinding.leafGeneration,
		leaseId: options.lease.id,
		profileAssignmentRevision: options.profileAssignmentRevision,
		ssh: {
			host: `tool-${options.lease.tcpSlot}.vm.host`,
			identityPem,
			knownHostsLine: buildToolVmKnownHostsLine({
				leaseId: options.lease.id,
				serverHostKey: Reflect.get(options.lease.sshAccess, 'serverHostKey'),
				tcpSlot: options.lease.tcpSlot,
			}),
			port: 22,
			user: options.lease.sshAccess.user ?? 'root',
		},
		sshBindingId: revalidatedBinding.sshBinding.bindingId,
		stablePrincipal: options.stablePrincipal,
		tcpSlot: options.lease.tcpSlot,
		transport: 'ssh-sandbox',
		workdir: options.lease.guestWorkdir,
		zoneId: options.lease.zoneId,
	});
}

export function createGatewayControlLeaseRpcOperations(
	options: GatewayControlLeaseRpcControllerOptions,
): GatewayControlLeaseRpcOperations & GatewayControlBindingPublicationSource {
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
			!stableToolVmLeasePrincipalsEqual(
				authority.authority.principal,
				leasePrincipalFromCallerContext(payload.callerContext),
			)
		) {
			return {
				rejection: leaseRpcRejection('ownership_denied'),
				status: 'rejected',
			};
		}
		return { authority, status: 'accepted' };
	}

	function recordLeaseCreateRequest(
		callerContext: GatewayControlTrustedCallerContext,
		leaseCreateOptions: Pick<LeaseCreateOptions, 'effectiveIdleTtlMs' | 'profileId' | 'zoneId'>,
	): void {
		options.onLeaseCreateRequest?.({
			agentId: callerContext.agentId,
			...(leaseCreateOptions.effectiveIdleTtlMs === undefined
				? {}
				: { idleTtlMs: leaseCreateOptions.effectiveIdleTtlMs }),
			profileId: leaseCreateOptions.profileId,
			zoneId: leaseCreateOptions.zoneId,
		});
	}

	const mutationOperations = {
		createLease: async ({
			callerContext,
			leaseCreateOptions,
		}: {
			readonly callerContext: GatewayControlTrustedCallerContext;
			readonly leaseCreateOptions: LeaseCreateOptions;
		}) => {
			let stage = 'lease_manager_create_lease';
			try {
				recordLeaseCreateRequest(callerContext, leaseCreateOptions);
				const lease = await options.leaseManager.createLease(leaseCreateOptions);
				stage = 'serialize_lease_snapshot';
				return await serializeGatewayControlLeaseSnapshot({
					currentBinding: options.leaseManager.getCurrentLeaseBinding(lease.id),
					includeSsh: 'private',
					lease,
					readCurrentBinding: options.leaseManager.getCurrentLeaseBinding,
					readCurrentNonterminalUses: options.leaseManager.getCurrentNonterminalUses,
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
					principal: leasePrincipalFromCallerContext(callerContext),
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
				...(includeSsh === 'private'
					? { currentBinding: options.leaseManager.getCurrentLeaseBinding(leaseId) }
					: {}),
				includeSsh,
				lease: leaseSnapshot.lease,
				readCurrentBinding: options.leaseManager.getCurrentLeaseBinding,
				readCurrentNonterminalUses: options.leaseManager.getCurrentNonterminalUses,
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
			const replacementLease = await options.leaseManager.reacquireLease(
				payload.oldLeaseId,
				leaseCreateOptions,
			);
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
				currentBinding: options.leaseManager.getCurrentLeaseBinding(replacementLease.id),
				includeSsh: 'private',
				lease: replacementLease,
				readCurrentBinding: options.leaseManager.getCurrentLeaseBinding,
				readCurrentNonterminalUses: options.leaseManager.getCurrentNonterminalUses,
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
					principal: leasePrincipalFromCallerContext(callerContext),
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
				currentBinding: options.leaseManager.getCurrentLeaseBinding(leaseId),
				includeSsh: 'private',
				lease: renewal.lease,
				readCurrentBinding: options.leaseManager.getCurrentLeaseBinding,
				readCurrentNonterminalUses: options.leaseManager.getCurrentNonterminalUses,
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
					principal: leasePrincipalFromCallerContext(callerContext),
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
			const resolvedLeaseOptions = await options.resolveLeaseCreateOptions({
				callerContext: optionsToPrepare.callerContext,
				gateway: optionsToPrepare.gateway,
				payload,
			});
			const leaseOptions = {
				...resolvedLeaseOptions,
				principal: leasePrincipalFromCallerContext(optionsToPrepare.callerContext),
			} satisfies LeaseCreateOptions;
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
				const resolvedLeaseCreateOptions =
					decision.status === 'accepted'
						? await options.resolveLeaseCreateOptions({
								callerContext: optionsToPrepare.callerContext,
								gateway: optionsToPrepare.gateway,
								payload: leaseCreatePayloadFromReacquirePayload(payload),
							})
						: undefined;
				const leaseCreateOptions =
					resolvedLeaseCreateOptions === undefined
						? undefined
						: ({
								...resolvedLeaseCreateOptions,
								principal: leasePrincipalFromCallerContext(optionsToPrepare.callerContext),
							} satisfies LeaseCreateOptions);
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
		createBinding: async ({ callerContext, gateway, payload }) => {
			const resolvedLeaseOptions = await options.resolveLeaseCreateOptions({
				callerContext,
				gateway,
				payload,
			});
			recordLeaseCreateRequest(callerContext, resolvedLeaseOptions);
			const lease = await options.leaseManager.createLease({
				...resolvedLeaseOptions,
				principal: leasePrincipalFromCallerContext(callerContext),
			});
			return await serializeGatewayControlToolVmBindingAccessGrant({
				currentBinding: options.leaseManager.getCurrentLeaseBinding(lease.id),
				lease,
				profileAssignmentRevision: callerContext.principal.profileAssignmentRevision,
				readCurrentBinding: options.leaseManager.getCurrentLeaseBinding,
				readIdentityPem,
				stablePrincipal: callerContext.stablePrincipal,
			});
		},
		getLease: mutationOperations.getLease,
		prepareSemanticMutation,
		subscribeBindingRetirement: (listener) =>
			options.leaseManager.subscribeLeaseRetirement(listener),
	};
}
