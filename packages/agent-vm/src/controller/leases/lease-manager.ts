import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
	createToolVmLeaseId,
	isToolVmActiveUseId,
	normalizeToolVmActiveUseCorrelation,
	type EndToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseRequest,
	type HeartbeatToolVmActiveUseResponse,
	type StartToolVmActiveUseRequest,
	type StartToolVmActiveUseResponse,
	type ToolVmActiveUseCorrelation,
	type ToolVmActiveUseOperationReport,
} from '@agent-vm/gateway-lifecycle';
import type {
	ManagedVm,
	ManagedVmExactProcessTerminationCapability,
	ManagedVmSshAccess,
	ManagedVmSshServerHostKey,
} from '@agent-vm/managed-vm';

import { terminateRecordedManagedVmProcess } from '../../shared/controller-managed-vm-termination.js';
import type { readProcessIdentity } from '../../shared/managed-vm-process.js';
import { readTcpListenPortOwner } from '../../shared/port-owner.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import { settleGatewayChildDestructionTasks } from '../vm-ownership/gateway-child-destruction.js';
import type {
	GatewayOwnershipCoordinator,
	ToolVmMembershipHandle,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import {
	createAgentLeaseOperationLock,
	type AgentLeaseOperationIdentity,
} from './agent-lease-operation-lock.js';
import { defaultToolVmLeaseIdleTtlMs } from './lease-idle-policy.js';
import type { TcpPool } from './tcp-pool.js';
import { gatewayAuthorityKey } from './tool-vm-lease-authority-runtime-identity.js';
import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import { stableToolVmLeasePrincipalsEqual } from './tool-vm-lease-authority-state-helpers.js';
import type {
	AuthorizedToolVmLeafBinding,
	ObservationGapToolVmActiveUse,
	RunningToolVmActiveUse,
	StableToolVmLeasePrincipal,
	ToolVmActiveUse,
	ToolVmLeafAuthorityReference,
	ToolVmLeaseCompatibility,
} from './tool-vm-lease-authority-state.js';
import { createToolVmLeaseCreationRegistry } from './tool-vm-lease-creation-registry.js';
import { classifyToolVmLeaseRenewal, isToolVmLeaseExpired } from './tool-vm-lease-lifecycle.js';
import { isToolVmLeaseVmLive } from './tool-vm-lease-liveness.js';
import {
	buildToolVmRuntimeRecord,
	deleteToolVmRuntimeRecord,
	type ToolVmRuntimeRecord,
	writeToolVmRuntimeRecord,
} from './tool-vm-runtime-record.js';
import { buildToolVmKnownHostsLine } from './tool-vm-ssh-server-identity.js';

export interface ToolVmProfile {
	readonly cpus: number;
	readonly imageProfile: string;
	readonly memory: string;
	readonly runtimeRootfsSize?: string | undefined;
}

export interface Lease {
	readonly agentId: string;
	readonly createdAt: number;
	readonly effectiveIdleTtlMs: number;
	readonly guestWorkdir: string;
	readonly hostGitDirectoryRoot: string;
	readonly hostWorkspaceRoot: string;
	readonly id: string;
	readonly lastUsedAt: number;
	readonly profileId: string;
	readonly runtimeRecordId: string;
	readonly sshAccess: {
		close(): Promise<void>;
		readonly command?: string;
		readonly host: string;
		readonly identityFile?: string;
		readonly port: number;
		readonly serverHostKey: ManagedVmSshServerHostKey;
		readonly user?: string;
	};
	readonly tcpSlot: number;
	readonly vm: ManagedVm;
	readonly profileAssignmentRevision: string;
	readonly zoneId: string;
}

interface ToolVmLeaseCleanupContext {
	readonly membership?: ToolVmMembershipHandle;
	readonly persistedRuntimeRecord?: {
		readonly recordId: string;
		readonly recordsTarget: ControllerToolLeaseRecordsTarget;
	};
	readonly processTarget?: {
		readonly hostPid: number;
		readonly processIdentity: ToolVmRuntimeRecord['processIdentity'];
		readonly vmId: string;
	};
	readonly sshAccess?: ManagedVmSshAccess;
	readonly tcpSlot: number;
	readonly vm?: ManagedVm;
}

export interface ToolVmProvisioningHandle {
	readonly vm: ManagedVm;
	prepareStartedVm(): Promise<void>;
}

export type LeaseRenewal =
	| {
			readonly kind: 'renewed';
			readonly lastUsedAt: number;
			readonly lease: Lease;
	  }
	| {
			readonly kind: 'not-found';
			readonly reason: 'dead' | 'expired' | 'missing';
	  };

export interface LeaseSnapshot {
	readonly kind: 'snapshot';
	readonly lease: Lease;
}

export interface ToolVmActiveUseSnapshot {
	readonly correlation?: ToolVmActiveUseCorrelation;
	readonly expiresAt: number;
	readonly latestReport?: ToolVmActiveUseOperationReport;
	readonly leaseId: string;
	readonly startedAt: number;
	readonly useId: string;
}

export interface ToolVmLeaseCurrentNonterminalUse {
	readonly expiresAtMs: number;
	readonly useId: string;
}

export type ToolVmLeaseRetirementReason = 'dead' | 'expired' | 'released';

export interface ToolVmLeaseRetirementEvent {
	readonly leaseId: string;
	readonly reason: ToolVmLeaseRetirementReason;
}

export interface ToolVmLeaseRetirementProgress {
	readonly accessFenced: Promise<void>;
	readonly completion: Promise<void>;
}

export interface ToolVmProcessEpochLossBarrier {
	readonly affectedLeaseIds: readonly string[];
	destroyAffectedLeases(): Promise<void>;
}

export interface ToolVmLeaseRequestAuthority {
	readonly gateway: GatewayEpochIdentity;
	readonly principal: StableToolVmLeasePrincipal;
}

export interface ToolVmLeaseActiveUseExecutionProof {
	readonly operationPayloadDigest: string;
	readonly processEpoch: string;
	readonly semanticOperationId: string;
	readonly sessionAttachmentGeneration: number;
}

export interface ToolVmLeaseCreateOptions {
	readonly agentId: string;
	readonly effectiveIdleTtlMs?: number;
	readonly expectedGateway: GatewayEpochIdentity;
	readonly guestWorkdir: string;
	readonly hostGitDirectoryRoot: string;
	readonly hostWorkspaceRoot: string;
	readonly profile: ToolVmProfile;
	readonly profileId: string;
	readonly principal: StableToolVmLeasePrincipal;
	readonly zoneId: string;
}

export interface LeaseManager {
	beginProcessEpochLoss(options: {
		readonly ambiguousAtMs: number;
		readonly gateway: GatewayEpochIdentity;
		readonly processEpoch: string;
	}): ToolVmProcessEpochLossBarrier;
	createLease(options: ToolVmLeaseCreateOptions): Promise<Lease>;
	reacquireLease(oldLeaseId: string, options: ToolVmLeaseCreateOptions): Promise<Lease>;
	destroyGatewayOwnedLeases(
		expectedGateway: GatewayEpochIdentity,
		signal?: AbortSignal,
	): Promise<void>;
	endActiveUse(
		leaseId: string,
		useId: string,
		request: EndToolVmActiveUseRequest &
			Pick<ToolVmLeaseActiveUseExecutionProof, 'processEpoch' | 'sessionAttachmentGeneration'> & {
				readonly authority: ToolVmLeaseRequestAuthority;
			},
	): { readonly kind: 'ended' | 'unknown-use' } | undefined;
	getActiveUses(leaseId: string): readonly ToolVmActiveUseSnapshot[];
	getActiveUseCount(leaseId: string): number;
	getCurrentNonterminalUses(leaseId: string): readonly ToolVmLeaseCurrentNonterminalUse[];
	getCurrentLeaseBinding(leaseId: string): AuthorizedToolVmLeafBinding | undefined;
	getLeaseAuthority(leaseId: string):
		| {
				readonly authority: ToolVmLeafAuthorityReference;
				readonly compatibility: ToolVmLeaseCompatibility;
		  }
		| undefined;
	markControlSessionDisconnected(options: {
		readonly gateway: GatewayEpochIdentity;
		readonly observedAtMs: number;
		readonly processEpoch: string;
		readonly sessionAttachmentGeneration: number;
	}): void;
	heartbeatActiveUse(
		leaseId: string,
		useId: string,
		request: HeartbeatToolVmActiveUseRequest &
			Pick<ToolVmLeaseActiveUseExecutionProof, 'processEpoch' | 'sessionAttachmentGeneration'> & {
				readonly authority: ToolVmLeaseRequestAuthority;
			},
	): HeartbeatToolVmActiveUseResponse | undefined;
	renewLease(leaseId: string): Promise<LeaseRenewal>;
	listLeases(): readonly Lease[];
	peekLease(leaseId: string): LeaseSnapshot | undefined;
	reapDeadIdleLeases(): Promise<void>;
	reapExpiredActiveUses(): void;
	releaseLease(
		leaseId: string,
		options?: { readonly force?: boolean; readonly ifLastUsedAtBeforeOrAt?: number },
	): Promise<void>;
	startActiveUse(
		leaseId: string,
		request: StartToolVmActiveUseRequest &
			ToolVmLeaseActiveUseExecutionProof & { readonly authority: ToolVmLeaseRequestAuthority },
	): StartToolVmActiveUseResponse | undefined;
	subscribeLeaseRetirement(listener: (event: ToolVmLeaseRetirementEvent) => void): () => void;
}

export class AgentLeaseCompatibilityConflictError extends Error {
	public constructor(
		message: string,
		public readonly mismatchedFields: readonly string[],
	) {
		super(message);
		this.name = 'AgentLeaseCompatibilityConflictError';
	}
}
export class LeaseActiveUseConflictError extends Error {}

function isCurrentNonterminalUse(
	activeUse: ToolVmActiveUse,
): activeUse is ObservationGapToolVmActiveUse | RunningToolVmActiveUse {
	return activeUse.kind === 'running' || activeUse.kind === 'observation-gap';
}

export interface ToolVmUsePolicy {
	readonly endedUseTombstoneTtlMs: number;
	readonly heartbeatAfterMs: number;
	readonly heartbeatStaleMs: number;
}

const defaultToolVmUsePolicy = {
	endedUseTombstoneTtlMs: 10 * 60 * 1000,
	heartbeatAfterMs: 30 * 1000,
	heartbeatStaleMs: 2 * 60 * 1000,
} satisfies ToolVmUsePolicy;
const leaseAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;

function assertValidLeaseAgentId(agentId: string): void {
	if (!leaseAgentIdPattern.test(agentId)) {
		throw new Error(
			`Invalid Tool VM lease agentId '${agentId}': expected an OpenClaw agent id matching /^[a-z0-9][a-z0-9_-]{0,63}$/i.`,
		);
	}
}

function assertValidLeaseRootBinding(leaseOptions: ToolVmLeaseCreateOptions): void {
	if (
		!path.isAbsolute(leaseOptions.hostGitDirectoryRoot) ||
		!path.isAbsolute(leaseOptions.hostWorkspaceRoot)
	) {
		throw new Error(
			'Tool VM lease requires absolute controller-selected workspace and Git directory roots.',
		);
	}
	if (leaseOptions.guestWorkdir !== '/work') {
		throw new Error("Managed Tool VM lease default cwd must be '/work'.");
	}
}

function assertValidToolVmUsePolicy(policy: ToolVmUsePolicy): void {
	if (policy.heartbeatAfterMs <= 0) {
		throw new Error('Tool VM active-use heartbeatAfterMs must be positive.');
	}
	if (policy.heartbeatStaleMs < policy.heartbeatAfterMs * 3) {
		throw new Error('Tool VM active-use heartbeatStaleMs must be at least 3x heartbeatAfterMs.');
	}
	if (policy.endedUseTombstoneTtlMs <= 0) {
		throw new Error('Tool VM active-use endedUseTombstoneTtlMs must be positive.');
	}
}

function formatLeaseManagerError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeLeaseManagerWarning(message: string): void {
	process.stderr.write(`[lease-manager] ${message}\n`);
}

function assertCompatibleAgentLeaseRequest(
	existingLease: Lease,
	requestedLease: {
		readonly effectiveIdleTtlMs?: number;
		readonly guestWorkdir: string;
		readonly hostGitDirectoryRoot: string;
		readonly hostWorkspaceRoot: string;
		readonly principal: StableToolVmLeasePrincipal;
		readonly profileId: string;
	},
): void {
	const mismatchedFields: string[] = [];
	if (
		requestedLease.effectiveIdleTtlMs !== undefined &&
		existingLease.effectiveIdleTtlMs !== requestedLease.effectiveIdleTtlMs
	) {
		mismatchedFields.push('effectiveIdleTtlMs');
	}
	if (existingLease.profileId !== requestedLease.profileId) {
		mismatchedFields.push('profileId');
	}
	if (existingLease.hostWorkspaceRoot !== requestedLease.hostWorkspaceRoot) {
		mismatchedFields.push('hostWorkspaceRoot');
	}
	if (existingLease.hostGitDirectoryRoot !== requestedLease.hostGitDirectoryRoot) {
		mismatchedFields.push('hostGitDirectoryRoot');
	}
	if (
		existingLease.profileAssignmentRevision !== requestedLease.principal.profileAssignmentRevision
	) {
		mismatchedFields.push('profileAssignmentRevision');
	}
	if (existingLease.guestWorkdir !== requestedLease.guestWorkdir) {
		mismatchedFields.push('guestWorkdir');
	}
	if (mismatchedFields.length > 0) {
		throw new AgentLeaseCompatibilityConflictError(
			`existing Tool VM lease for agent '${existingLease.agentId}' is not compatible with this request; mismatched fields: ${mismatchedFields.join(', ')}`,
			mismatchedFields,
		);
	}
}

function toolVmLeasePolicyFingerprint(options: {
	readonly effectiveIdleTtlMs: number;
	readonly guestWorkdir: string;
	readonly hostGitDirectoryRoot: string;
	readonly hostWorkspaceRoot: string;
	readonly profileAssignmentRevision: string;
	readonly profile: ToolVmProfile;
}): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				effectiveIdleTtlMs: options.effectiveIdleTtlMs,
				guestWorkdir: options.guestWorkdir,
				hostGitDirectoryRoot: options.hostGitDirectoryRoot,
				hostWorkspaceRoot: options.hostWorkspaceRoot,
				profileAssignmentRevision: options.profileAssignmentRevision,
				profile: options.profile,
			}),
			'utf8',
		)
		.digest('hex');
}

export function resolveToolVmLeaseCompatibility(
	leaseOptions: ToolVmLeaseCreateOptions,
): ToolVmLeaseCompatibility {
	const effectiveIdleTtlMs = leaseOptions.effectiveIdleTtlMs ?? defaultToolVmLeaseIdleTtlMs;
	return {
		policyFingerprint: toolVmLeasePolicyFingerprint({
			effectiveIdleTtlMs,
			guestWorkdir: leaseOptions.guestWorkdir,
			hostGitDirectoryRoot: leaseOptions.hostGitDirectoryRoot,
			hostWorkspaceRoot: leaseOptions.hostWorkspaceRoot,
			profileAssignmentRevision: leaseOptions.principal.profileAssignmentRevision,
			profile: leaseOptions.profile,
		}),
		profileId: leaseOptions.profileId,
		purpose: 'tool_vm_lease',
		profileAssignmentRevision: leaseOptions.principal.profileAssignmentRevision,
	};
}

function stableToolVmLeasePrincipal(
	agentLease: Pick<ToolVmLeaseCreateOptions, 'agentId' | 'principal' | 'zoneId'>,
): StableToolVmLeasePrincipal {
	if (agentLease.principal.agentId !== agentLease.agentId) {
		throw new Error('Tool VM lease principal does not match the requested agent.');
	}
	return agentLease.principal;
}

function agentLeaseOperationIdentity(options: {
	readonly agentId: string;
	readonly gateway: GatewayEpochIdentity;
}): AgentLeaseOperationIdentity {
	return {
		agentId: options.agentId,
		gateway: options.gateway,
	};
}

function createToolVmLeaseRetainedCleanupError(options: {
	readonly agentId: string;
	readonly cleanupError: unknown;
	readonly creationError: unknown;
	readonly zoneId: string;
}): AggregateError {
	return new AggregateError(
		[options.creationError, options.cleanupError],
		`Tool VM lease creation failed and exact retained cleanup was not proven for zone '${options.zoneId}' agent '${options.agentId}'.`,
		{ cause: options.cleanupError },
	);
}

async function fenceToolVmAccess(options: {
	readonly cleanupContext: ToolVmLeaseCleanupContext;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
}): Promise<void> {
	const { cleanupContext } = options;
	const membershipState = cleanupContext.membership?.snapshot().state;
	if (
		membershipState === 'provisional' ||
		membershipState === 'current' ||
		membershipState === 'owner-unsafe'
	) {
		cleanupContext.membership?.beginDestroying();
	}
	if (cleanupContext.vm === undefined) {
		cleanupContext.membership?.recordAccessFenced();
		return;
	}
	if (cleanupContext.processTarget === undefined) {
		throw new Error(
			`Tool VM '${cleanupContext.vm.id}' has no recorded process identity for exact access fencing.`,
		);
	}
	if (cleanupContext.vm.id !== cleanupContext.processTarget.vmId) {
		throw new Error(
			`Tool VM cleanup target '${cleanupContext.processTarget.vmId}' does not match live VM '${cleanupContext.vm.id}'.`,
		);
	}
	const liveHostProcessId = cleanupContext.vm.getHostProcessId();
	if (liveHostProcessId !== null && liveHostProcessId !== cleanupContext.processTarget.hostPid) {
		throw new Error(
			`Tool VM '${cleanupContext.vm.id}' reports pid ${String(liveHostProcessId)}, not recorded pid ${String(cleanupContext.processTarget.hostPid)}.`,
		);
	}
	await terminateRecordedManagedVmProcess({
		contextLabel: `Tool VM lease process '${cleanupContext.processTarget.vmId}'`,
		exactProcessTermination: options.exactProcessTermination,
		target: cleanupContext.processTarget,
	});
	cleanupContext.membership?.recordAccessFenced();
}

export function createLeaseManager(options: {
	readonly controllerPort: number;
	readonly createLeaseId?: () => string;
	readonly createLeafGeneration?: () => string;
	readonly createRuntimeRecordId?: () => string;
	readonly createManagedVm: (leaseOptions: {
		readonly effectiveIdleTtlMs?: number;
		readonly agentId: string;
		readonly profile: ToolVmProfile;
		readonly profileId: string;
		readonly tcpSlot: number;
		readonly guestWorkdir: string;
		readonly hostGitDirectoryRoot: string;
		readonly hostWorkspaceRoot: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm | ToolVmProvisioningHandle>;
	readonly deleteToolVmRuntimeRecord?: typeof deleteToolVmRuntimeRecord;
	readonly now: () => number;
	readonly ownershipCoordinator: GatewayOwnershipCoordinator;
	readonly projectNamespace: string;
	readonly prepareLeasePersistentState?: (leaseOptions: ToolVmLeaseCreateOptions) => Promise<void>;
	// Injected for tests so we don't shell out to `ps` against a fake pid.
	// Production uses the default real implementation.
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmTerminationSleep?: (delayMs: number) => Promise<void>;
	readonly readProcessIdentity?: typeof readProcessIdentity;
	readonly readTcpListenPortOwner?: typeof readTcpListenPortOwner;
	readonly systemConfigPath: string;
	readonly tcpPool: TcpPool;
	readonly toolLeaseRecordsTargetFor: (zoneId: string) => ControllerToolLeaseRecordsTarget;
	readonly toolVmUsePolicy?: ToolVmUsePolicy;
	readonly writeToolVmRuntimeRecord?: typeof writeToolVmRuntimeRecord;
}): LeaseManager {
	const leaseRetirementListeners = new Set<(event: ToolVmLeaseRetirementEvent) => void>();
	const agentLeaseOperationLock = createAgentLeaseOperationLock();
	const toolVmUsePolicy = options.toolVmUsePolicy ?? defaultToolVmUsePolicy;
	assertValidToolVmUsePolicy(toolVmUsePolicy);
	const authorityRuntime = createToolVmLeaseAuthorityRuntime<Lease, ToolVmLeaseCleanupContext>({
		retentionPolicy: {
			observationGapGraceMs: toolVmUsePolicy.heartbeatStaleMs,
			terminalUseTombstoneTtlMs: toolVmUsePolicy.endedUseTombstoneTtlMs,
		},
	});
	const leaseCreationRegistry = createToolVmLeaseCreationRegistry();
	const lostProcessEpochsByGateway = new Map<string, Set<string>>();
	const retirementProgressByCompletion = new WeakMap<
		Promise<unknown>,
		ToolVmLeaseRetirementProgress
	>();

	function markProcessEpochLost(gateway: GatewayEpochIdentity, processEpoch: string): void {
		const gatewayKey = gatewayAuthorityKey(gateway);
		const lostProcessEpochs = lostProcessEpochsByGateway.get(gatewayKey) ?? new Set<string>();
		lostProcessEpochs.add(processEpoch);
		lostProcessEpochsByGateway.set(gatewayKey, lostProcessEpochs);
	}

	function assertProcessEpochCanStartUse(
		gateway: GatewayEpochIdentity,
		processEpoch: string,
	): void {
		if (lostProcessEpochsByGateway.get(gatewayAuthorityKey(gateway))?.has(processEpoch) === true) {
			throw new LeaseActiveUseConflictError(
				`OpenClaw process epoch '${processEpoch}' was lost and cannot start new Tool VM work.`,
			);
		}
	}

	function touchLease(lease: Lease): Lease {
		const authority = authorityRuntime.authorityForLease(lease.id);
		if (authority === undefined) {
			throw new Error(`Tool VM lease '${lease.id}' has no current authority.`);
		}
		const nowMs = options.now();
		if (nowMs <= lease.lastUsedAt) {
			return lease;
		}
		return authorityRuntime.touchLease(
			authority,
			nowMs,
			nowMs + lease.effectiveIdleTtlMs,
			(currentLease) => ({ ...currentLease, lastUsedAt: nowMs }),
		);
	}

	function assertLeaseGatewayAdmitting(lease: Lease): void {
		const expectedGateway = authorityRuntime.authorityForLease(lease.id)?.gateway;
		if (expectedGateway === undefined) {
			throw new Error(`Tool VM lease '${lease.id}' has no current Gateway VM ownership.`);
		}
		const resolvedGateway = options.ownershipCoordinator.resolveGatewayEpoch(expectedGateway);
		if (!gatewayIdentitiesEqual(resolvedGateway, expectedGateway)) {
			throw new Error(`Tool VM lease '${lease.id}' belongs to a stale Gateway VM epoch.`);
		}
	}

	function requireAuthorizedLeaseAuthority(optionsToAuthorize: {
		readonly authority: ToolVmLeaseRequestAuthority;
		readonly leaseId: string;
	}): ToolVmLeafAuthorityReference {
		const authority = authorityRuntime.authorityForLease(optionsToAuthorize.leaseId);
		if (
			authority === undefined ||
			!gatewayIdentitiesEqual(authority.gateway, optionsToAuthorize.authority.gateway) ||
			!stableToolVmLeasePrincipalsEqual(authority.principal, optionsToAuthorize.authority.principal)
		) {
			throw new Error(`Tool VM lease '${optionsToAuthorize.leaseId}' authority is not current.`);
		}
		return authority;
	}

	function activeUseCountForLease(leaseId: string): number {
		return authorityRuntime.activeUseCount(leaseId);
	}

	function notifyLeaseRetired(event: ToolVmLeaseRetirementEvent): void {
		for (const listener of leaseRetirementListeners) {
			listener(event);
		}
	}

	function isLeaseExpired(lease: Lease): boolean {
		return isToolVmLeaseExpired({
			activeUseCount: activeUseCountForLease(lease.id),
			effectiveIdleTtlMs: lease.effectiveIdleTtlMs,
			lastUsedAt: lease.lastUsedAt,
			nowMs: options.now(),
		});
	}

	const writeRuntimeRecord = options.writeToolVmRuntimeRecord ?? writeToolVmRuntimeRecord;
	const deleteRuntimeRecord = options.deleteToolVmRuntimeRecord ?? deleteToolVmRuntimeRecord;
	const createLeaseId = options.createLeaseId ?? createToolVmLeaseId;
	const createRuntimeRecordId = options.createRuntimeRecordId ?? randomUUID;
	const readToolVmPortOwner = options.readTcpListenPortOwner ?? readTcpListenPortOwner;
	const releaseTcpSlotAfterCompleteDestruction = (tcpSlot: number): void => {
		options.tcpPool.release(tcpSlot);
		options.tcpPool.releaseQuarantined(tcpSlot);
	};
	async function assertToolVmPortReleased(
		cleanupContext: ToolVmLeaseCleanupContext,
	): Promise<void> {
		if (cleanupContext.sshAccess === undefined) {
			return;
		}
		const portOwner = await readToolVmPortOwner(
			options.tcpPool.portForSlot(cleanupContext.tcpSlot),
		);
		if (portOwner !== null) {
			throw new Error(
				`Tool VM tcp slot ${String(cleanupContext.tcpSlot)} is still held by pid ${String(portOwner.pid)} (${portOwner.command}) after SSH and VM termination.`,
			);
		}
	}

	async function completeToolVmResourceCleanup(
		cleanupContext: ToolVmLeaseCleanupContext,
	): Promise<void> {
		const managedVm = cleanupContext.vm;
		if (managedVm !== undefined) {
			await managedVm.close();
			const postCloseHostProcessId = managedVm.getHostProcessId();
			if (postCloseHostProcessId !== null) {
				throw new Error(
					`Tool VM '${managedVm.id}' still reports runner pid ${String(postCloseHostProcessId)} after ManagedVm.close().`,
				);
			}
		}
		await cleanupContext.sshAccess?.close();
		await assertToolVmPortReleased(cleanupContext);
		if (cleanupContext.persistedRuntimeRecord !== undefined) {
			await deleteRuntimeRecord(
				cleanupContext.persistedRuntimeRecord.recordsTarget,
				cleanupContext.persistedRuntimeRecord.recordId,
			);
		}
		const membership = cleanupContext.membership;
		const membershipState = membership?.snapshot().state;
		if (membershipState === 'destroying' || membershipState === 'retiring') {
			membership?.recordDestroyed();
		}
	}

	function observeToolVmCleanupContextRetirement(optionsToObserve: {
		readonly cleanupContext: ToolVmLeaseCleanupContext;
		readonly destruction: {
			readonly accessFenced: Promise<void>;
			readonly completion: Promise<unknown>;
		};
		readonly notifyRetirement?: ToolVmLeaseRetirementReason;
		readonly retiredLeaseId: string;
	}): ToolVmLeaseRetirementProgress {
		const { cleanupContext, destruction } = optionsToObserve;
		const existingProgress = retirementProgressByCompletion.get(destruction.completion);
		if (existingProgress !== undefined) {
			return existingProgress;
		}
		const accessFenced = destruction.accessFenced.catch((error: unknown) => {
			const membershipState = cleanupContext.membership?.snapshot().state;
			if (
				membershipState !== undefined &&
				membershipState !== 'destroyed' &&
				membershipState !== 'retiring' &&
				membershipState !== 'owner-unsafe'
			) {
				cleanupContext.membership?.recordUnavailable();
			}
			options.tcpPool.quarantine(cleanupContext.tcpSlot);
			throw error;
		});
		const completion = destruction.completion.then(
			() => {
				releaseTcpSlotAfterCompleteDestruction(cleanupContext.tcpSlot);
				if (optionsToObserve.notifyRetirement !== undefined) {
					notifyLeaseRetired({
						leaseId: optionsToObserve.retiredLeaseId,
						reason: optionsToObserve.notifyRetirement,
					});
				}
			},
			(error: unknown) => {
				const membershipState = cleanupContext.membership?.snapshot().state;
				if (
					membershipState !== undefined &&
					membershipState !== 'destroyed' &&
					membershipState !== 'retiring' &&
					membershipState !== 'owner-unsafe'
				) {
					cleanupContext.membership?.recordUnavailable();
				}
				options.tcpPool.quarantine(cleanupContext.tcpSlot);
				throw error;
			},
		);
		void accessFenced.catch(() => {});
		void completion.catch(() => {});
		const progress = { accessFenced, completion } satisfies ToolVmLeaseRetirementProgress;
		retirementProgressByCompletion.set(destruction.completion, progress);
		return progress;
	}

	function beginToolVmCleanupContextRetirement(optionsToDestroy: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly cleanupContext: ToolVmLeaseCleanupContext;
		readonly notifyRetirement?: ToolVmLeaseRetirementReason;
		readonly reason: string;
	}): ToolVmLeaseRetirementProgress {
		const destruction = authorityRuntime.destroyExact({
			authority: optionsToDestroy.authority,
			cleanup: async () => await completeToolVmResourceCleanup(optionsToDestroy.cleanupContext),
			destroyedAtMs: options.now(),
			fenceAccess: async () =>
				await fenceToolVmAccess({
					cleanupContext: optionsToDestroy.cleanupContext,
					exactProcessTermination: options.managedVmExactProcessTermination,
				}),
			reason: optionsToDestroy.reason,
		});
		return observeToolVmCleanupContextRetirement({
			cleanupContext: optionsToDestroy.cleanupContext,
			destruction,
			...(optionsToDestroy.notifyRetirement === undefined
				? {}
				: { notifyRetirement: optionsToDestroy.notifyRetirement }),
			retiredLeaseId: optionsToDestroy.authority.leaseId,
		});
	}

	async function destroyToolVmCleanupContext(optionsToDestroy: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly cleanupContext: ToolVmLeaseCleanupContext;
		readonly notifyRetirement?: ToolVmLeaseRetirementReason;
		readonly reason: string;
	}): Promise<void> {
		await beginToolVmCleanupContextRetirement(optionsToDestroy).completion;
	}

	async function destroyRetainedLease(optionsToDestroy: {
		readonly lease: Lease;
		readonly notifyRetirement: boolean;
		readonly reason: ToolVmLeaseRetirementReason | 'create-retry';
	}): Promise<void> {
		const { lease, reason } = optionsToDestroy;
		const authority = authorityRuntime.authorityForLease(lease.id);
		if (authority === undefined) {
			return;
		}
		try {
			const cleanupContext = authorityRuntime.cleanupContextForLease(lease.id);
			if (cleanupContext === undefined) {
				throw new Error(`Tool VM lease '${lease.id}' has no retained cleanup context.`);
			}
			await destroyToolVmCleanupContext({
				authority,
				cleanupContext,
				...(optionsToDestroy.notifyRetirement && reason !== 'create-retry'
					? { notifyRetirement: reason }
					: {}),
				reason,
			});
		} catch (error) {
			options.tcpPool.quarantine(lease.tcpSlot);
			writeLeaseManagerWarning(
				`failed to close evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${lease.tcpSlot} and preserving runtime record for next-startup cleanup.`,
			);
			throw error;
		}
	}

	async function destroyProvisionalAuthority(optionsToDestroy: {
		readonly authority: ToolVmLeafAuthorityReference;
		readonly reason: string;
	}): Promise<void> {
		const cleanupContext = authorityRuntime.cleanupContextForLease(
			optionsToDestroy.authority.leaseId,
		);
		if (cleanupContext === undefined) {
			throw new Error(
				`Tool VM leaf '${optionsToDestroy.authority.leafGeneration}' has no retained cleanup context.`,
			);
		}
		await destroyToolVmCleanupContext({
			authority: optionsToDestroy.authority,
			cleanupContext,
			reason: optionsToDestroy.reason,
		});
	}

	async function evictLease(
		lease: Lease,
		reason: ToolVmLeaseRetirementReason,
	): Promise<ToolVmLeaseRetirementProgress | undefined> {
		const authority = authorityRuntime.authorityForLease(lease.id);
		if (authority === undefined) {
			return undefined;
		}
		const cleanupContext = authorityRuntime.cleanupContextForLease(lease.id);
		if (cleanupContext === undefined) {
			throw new Error(`Tool VM lease '${lease.id}' has no retained cleanup context.`);
		}
		const retirement = beginToolVmCleanupContextRetirement({
			authority,
			cleanupContext,
			notifyRetirement: reason,
			reason,
		});
		void retirement.completion.catch((error: unknown) => {
			writeLeaseManagerWarning(
				`failed to close evicted lease '${lease.id}' in zone '${lease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${lease.tcpSlot} and preserving runtime record for next-startup cleanup.`,
			);
		});
		await retirement.accessFenced;
		return retirement;
	}

	async function createLeaseWhileLocked(
		leaseOptions: ToolVmLeaseCreateOptions,
		creationOptions: {
			readonly admissionBarrier?: Promise<void>;
			readonly resolveCurrentLease?: boolean;
		} = {},
	): Promise<Lease> {
		assertValidLeaseAgentId(leaseOptions.agentId);
		assertValidLeaseRootBinding(leaseOptions);
		const principal = stableToolVmLeasePrincipal(leaseOptions);
		authorityRuntime.registerGateway(leaseOptions.expectedGateway);
		const currentAuthority =
			creationOptions.resolveCurrentLease === false
				? undefined
				: authorityRuntime.authorityForCurrentAgent({
						agentId: leaseOptions.agentId,
						gateway: leaseOptions.expectedGateway,
					});
		if (currentAuthority !== undefined) {
			if (!gatewayIdentitiesEqual(currentAuthority.gateway, leaseOptions.expectedGateway)) {
				throw new Error(
					`Current Tool VM lease for agent '${leaseOptions.agentId}' belongs to a different Gateway VM epoch.`,
				);
			}
			const currentLease = authorityRuntime.getCleanupLease(currentAuthority.leaseId);
			const currentLeaf = authorityRuntime.leafSnapshotForLease(currentAuthority.leaseId);
			const cleanupContext = authorityRuntime.cleanupContextForAuthority(currentAuthority);
			if (cleanupContext === undefined) {
				throw new Error(
					`Tool VM lease '${currentAuthority.leaseId}' has no retained cleanup context.`,
				);
			}
			let retirementReason: ToolVmLeaseRetirementReason | 'create-retry';
			if (currentLeaf?.kind !== 'current') {
				retirementReason = currentLease === undefined ? 'create-retry' : 'dead';
			} else if (
				currentLease !== undefined &&
				stableToolVmLeasePrincipalsEqual(currentAuthority.principal, principal)
			) {
				assertLeaseGatewayAdmitting(currentLease);
				if (isLeaseExpired(currentLease)) {
					retirementReason = 'expired';
				} else {
					assertCompatibleAgentLeaseRequest(currentLease, leaseOptions);
					if (await isToolVmLeaseVmLive(currentLease)) {
						return touchLease(currentLease);
					}
					retirementReason = 'dead';
				}
			} else {
				retirementReason = currentLease === undefined ? 'create-retry' : 'released';
			}
			const retirement = beginToolVmCleanupContextRetirement({
				authority: currentAuthority,
				cleanupContext,
				...(retirementReason === 'create-retry' ? {} : { notifyRetirement: retirementReason }),
				reason: retirementReason,
			});
			return await createReplacementLeaseWhileLocked({ leaseOptions, retirement });
		}
		const createdAt = options.now();
		const effectiveIdleTtlMs = leaseOptions.effectiveIdleTtlMs ?? defaultToolVmLeaseIdleTtlMs;
		const authority = {
			gateway: leaseOptions.expectedGateway,
			leaseId: createLeaseId(),
			leafGeneration: (options.createLeafGeneration ?? randomUUID)(),
			principal: stableToolVmLeasePrincipal(leaseOptions),
		} satisfies ToolVmLeafAuthorityReference;
		const compatibility = resolveToolVmLeaseCompatibility(leaseOptions);
		const tcpSlot = options.tcpPool.allocate();
		let authorityRetained = false;
		let persistedRuntimeRecord:
			| {
					readonly recordId: string;
					readonly recordsTarget: ControllerToolLeaseRecordsTarget;
			  }
			| undefined;
		let vm: ManagedVm | undefined;
		let prepareStartedVm: (() => Promise<void>) | undefined;
		try {
			authorityRuntime.beginProvisioning({
				authority,
				cleanupContext: { tcpSlot },
				compatibility,
				idleExpiresAtMs: createdAt + effectiveIdleTtlMs,
			});
			authorityRetained = true;
			const toolMembership = options.ownershipCoordinator.admitProvisionalToolVm({
				agentId: leaseOptions.agentId,
				expectedGateway: leaseOptions.expectedGateway,
				leafId: authority.leafGeneration,
			});
			authorityRuntime.setCleanupContext(authority, {
				membership: toolMembership,
				tcpSlot,
			});
			const createdToolVm = await options.createManagedVm({
				...leaseOptions,
				tcpSlot,
			});
			if ('vm' in createdToolVm) {
				vm = createdToolVm.vm;
				prepareStartedVm = async () => await createdToolVm.prepareStartedVm();
			} else {
				vm = createdToolVm;
			}
			toolMembership.attachToolVm(vm.id);
			authorityRuntime.setCleanupContext(authority, {
				membership: toolMembership,
				tcpSlot,
				vm,
			});
			await vm.start();
			const runtimeRecordId = createRuntimeRecordId();
			const runtimeRecord = await buildToolVmRuntimeRecord({
				controllerPort: options.controllerPort,
				agentId: leaseOptions.agentId,
				gatewayIdentity: leaseOptions.expectedGateway,
				leaseId: authority.leaseId,
				managedVm: vm,
				projectNamespace: options.projectNamespace,
				...(options.readProcessIdentity !== undefined
					? { readProcessIdentity: options.readProcessIdentity }
					: {}),
				recordId: runtimeRecordId,
				systemConfigPath: options.systemConfigPath,
				tcpSlot,
				zoneId: leaseOptions.zoneId,
			});
			authorityRuntime.setCleanupContext(authority, {
				membership: toolMembership,
				processTarget: {
					hostPid: runtimeRecord.qemuPid,
					processIdentity: runtimeRecord.processIdentity,
					vmId: runtimeRecord.vmId,
				},
				tcpSlot,
				vm,
			});
			const recordsTarget = options.toolLeaseRecordsTargetFor(leaseOptions.zoneId);
			await writeRuntimeRecord(recordsTarget, runtimeRecord);
			persistedRuntimeRecord = {
				recordId: runtimeRecordId,
				recordsTarget,
			};
			authorityRuntime.setCleanupContext(authority, {
				membership: toolMembership,
				persistedRuntimeRecord,
				processTarget: {
					hostPid: runtimeRecord.qemuPid,
					processIdentity: runtimeRecord.processIdentity,
					vmId: runtimeRecord.vmId,
				},
				tcpSlot,
				vm,
			});
			await creationOptions.admissionBarrier;
			await options.prepareLeasePersistentState?.(leaseOptions);
			await prepareStartedVm?.();
			const sshAccess = await vm.enableSsh({
				listenPort: options.tcpPool.portForSlot(tcpSlot),
			});
			authorityRuntime.setCleanupContext(authority, {
				membership: toolMembership,
				persistedRuntimeRecord,
				processTarget: {
					hostPid: runtimeRecord.qemuPid,
					processIdentity: runtimeRecord.processIdentity,
					vmId: runtimeRecord.vmId,
				},
				sshAccess,
				tcpSlot,
				vm,
			});
			buildToolVmKnownHostsLine({
				leaseId: authority.leaseId,
				serverHostKey: sshAccess.serverHostKey,
				tcpSlot,
			});
			const lease: Lease = {
				agentId: leaseOptions.agentId,
				createdAt,
				effectiveIdleTtlMs,
				guestWorkdir: leaseOptions.guestWorkdir,
				hostGitDirectoryRoot: leaseOptions.hostGitDirectoryRoot,
				hostWorkspaceRoot: leaseOptions.hostWorkspaceRoot,
				id: authority.leaseId,
				lastUsedAt: createdAt,
				profileAssignmentRevision: leaseOptions.principal.profileAssignmentRevision,
				profileId: leaseOptions.profileId,
				runtimeRecordId,
				sshAccess,
				tcpSlot,
				vm,
				zoneId: leaseOptions.zoneId,
			};
			toolMembership.commitCurrent();
			await authorityRuntime.commitCurrent({
				authority,
				lease,
				runtimeBinding: { runtimeRecordId, tcpSlot, vmId: vm.id },
				sshBinding: {
					bindingId: randomUUID(),
					host: sshAccess.host,
					identityFile: sshAccess.identityFile ?? '',
					port: sshAccess.port,
					serverIdentity: JSON.stringify(sshAccess.serverHostKey),
					user: sshAccess.user ?? 'root',
				},
			});
			return lease;
		} catch (error) {
			if (!authorityRetained) {
				options.tcpPool.release(tcpSlot);
				throw error;
			}
			try {
				let cleanupContext = authorityRuntime.cleanupContextForAuthority(authority);
				if (cleanupContext === undefined) {
					throw new Error(
						`Tool VM leaf '${authority.leafGeneration}' has no retained cleanup context.`,
						{ cause: error },
					);
				}
				if (
					cleanupContext.vm !== undefined &&
					cleanupContext.processTarget === undefined &&
					cleanupContext.vm.getHostProcessId() !== null
				) {
					const fallbackRuntimeRecordId = createRuntimeRecordId();
					const fallbackRuntimeRecord = await buildToolVmRuntimeRecord({
						agentId: leaseOptions.agentId,
						controllerPort: options.controllerPort,
						gatewayIdentity: leaseOptions.expectedGateway,
						leaseId: authority.leaseId,
						managedVm: cleanupContext.vm,
						projectNamespace: options.projectNamespace,
						...(options.readProcessIdentity !== undefined
							? { readProcessIdentity: options.readProcessIdentity }
							: {}),
						recordId: fallbackRuntimeRecordId,
						systemConfigPath: options.systemConfigPath,
						tcpSlot,
						zoneId: leaseOptions.zoneId,
					});
					await writeRuntimeRecord(
						options.toolLeaseRecordsTargetFor(leaseOptions.zoneId),
						fallbackRuntimeRecord,
					);
					persistedRuntimeRecord = {
						recordId: fallbackRuntimeRecordId,
						recordsTarget: options.toolLeaseRecordsTargetFor(leaseOptions.zoneId),
					};
					cleanupContext = {
						...cleanupContext,
						persistedRuntimeRecord,
						processTarget: {
							hostPid: fallbackRuntimeRecord.qemuPid,
							processIdentity: fallbackRuntimeRecord.processIdentity,
							vmId: fallbackRuntimeRecord.vmId,
						},
					};
					authorityRuntime.setCleanupContext(authority, cleanupContext);
				}
				await destroyToolVmCleanupContext({
					authority,
					cleanupContext,
					reason: 'create-failed',
				});
			} catch (cleanupError) {
				writeLeaseManagerWarning(
					`failed to close partially-created lease VM for zone '${leaseOptions.zoneId}' agent '${leaseOptions.agentId}': ${formatLeaseManagerError(cleanupError)}. Quarantining tcp slot ${tcpSlot} for exact retry.`,
				);
				throw createToolVmLeaseRetainedCleanupError({
					agentId: leaseOptions.agentId,
					cleanupError,
					creationError: error,
					zoneId: leaseOptions.zoneId,
				});
			}
			throw error;
		}
	}

	async function createReplacementLeaseWhileLocked(optionsToReplace: {
		readonly leaseOptions: ToolVmLeaseCreateOptions;
		readonly retirement: ToolVmLeaseRetirementProgress;
	}): Promise<Lease> {
		const admission = Promise.withResolvers<void>();
		const successorCreation = createLeaseWhileLocked(optionsToReplace.leaseOptions, {
			admissionBarrier: admission.promise,
			resolveCurrentLease: false,
		});
		void successorCreation.catch(() => {});
		try {
			await optionsToReplace.retirement.accessFenced;
			admission.resolve();
			return await successorCreation;
		} catch (error) {
			admission.reject(error);
			try {
				await successorCreation;
			} catch {
				// The provisional successor owns its own exact cleanup path. Preserve
				// the predecessor access-fence failure as the replacement result.
			}
			throw error;
		}
	}

	return {
		beginProcessEpochLoss(processLossOptions): ToolVmProcessEpochLossBarrier {
			// Process loss can precede the first Tool VM lease. Establish the
			// Gateway's lease-authority parent before applying the loss transition.
			authorityRuntime.registerGateway(processLossOptions.gateway);
			markProcessEpochLost(processLossOptions.gateway, processLossOptions.processEpoch);
			const affectedLeaseIds = authorityRuntime
				.listLeases()
				.filter((lease) => {
					const authority = authorityRuntime.authorityForLease(lease.id);
					return (
						authority !== undefined &&
						gatewayIdentitiesEqual(authority.gateway, processLossOptions.gateway) &&
						authorityRuntime
							.activeUseSnapshots(lease.id)
							.some(
								(activeUse) =>
									(activeUse.kind === 'running' || activeUse.kind === 'observation-gap') &&
									activeUse.processEpoch === processLossOptions.processEpoch,
							)
					);
				})
				.map((lease) => lease.id);
			authorityRuntime.applyAuthorityCommand({
				ambiguousAtMs: processLossOptions.ambiguousAtMs,
				gateway: processLossOptions.gateway,
				kind: 'process-epoch-lost',
				processEpoch: processLossOptions.processEpoch,
			});
			let destruction: Promise<void> | undefined;
			return {
				affectedLeaseIds,
				destroyAffectedLeases(): Promise<void> {
					destruction ??= (async (): Promise<void> => {
						const tasks = affectedLeaseIds.map((leaseId): (() => Promise<void>) => async () => {
							const retainedLease = authorityRuntime.getRetainedLease(leaseId);
							const retainedAuthority = authorityRuntime.authorityForLease(leaseId);
							if (retainedLease === undefined || retainedAuthority === undefined) {
								return;
							}
							await agentLeaseOperationLock.runExclusive(
								agentLeaseOperationIdentity({
									agentId: retainedAuthority.principal.agentId,
									gateway: retainedAuthority.gateway,
								}),
								async () => {
									const currentLease = authorityRuntime.getRetainedLease(leaseId);
									const currentAuthority = authorityRuntime.authorityForLease(leaseId);
									if (currentLease === undefined || currentAuthority === undefined) {
										return;
									}
									if (
										!gatewayIdentitiesEqual(currentAuthority.gateway, processLossOptions.gateway) ||
										!authorityRuntime
											.activeUseSnapshots(leaseId)
											.some(
												(activeUse) =>
													activeUse.kind === 'ambiguous' &&
													activeUse.processEpoch === processLossOptions.processEpoch,
											)
									) {
										throw new Error(
											`Tool VM lease '${leaseId}' no longer matches process epoch loss '${processLossOptions.processEpoch}'.`,
										);
									}
									await destroyRetainedLease({
										lease: currentLease,
										notifyRetirement: true,
										reason: 'dead',
									});
								},
							);
						});
						const results = await settleGatewayChildDestructionTasks(tasks);
						const failures = results.flatMap((result) =>
							result.status === 'rejected' ? [result.reason as unknown] : [],
						);
						if (failures.length === 1) {
							throw failures[0];
						}
						if (failures.length > 1) {
							throw new AggregateError(
								failures,
								`Process epoch '${processLossOptions.processEpoch}' has ${String(failures.length)} incomplete Tool VM dispositions.`,
							);
						}
					})();
					return destruction;
				},
			};
		},
		async createLease(leaseOptions) {
			assertValidLeaseAgentId(leaseOptions.agentId);
			stableToolVmLeasePrincipal(leaseOptions);
			const operationIdentity = agentLeaseOperationIdentity({
				agentId: leaseOptions.agentId,
				gateway: leaseOptions.expectedGateway,
			});
			const finishTrackingCreation = leaseCreationRegistry.trackCreation(operationIdentity);
			try {
				return await agentLeaseOperationLock.runExclusive(
					operationIdentity,
					async () => await createLeaseWhileLocked(leaseOptions),
				);
			} finally {
				finishTrackingCreation();
			}
		},
		async reacquireLease(oldLeaseId, leaseOptions) {
			assertValidLeaseAgentId(leaseOptions.agentId);
			const principal = stableToolVmLeasePrincipal(leaseOptions);
			const operationIdentity = agentLeaseOperationIdentity({
				agentId: leaseOptions.agentId,
				gateway: leaseOptions.expectedGateway,
			});
			const finishTrackingCreation = leaseCreationRegistry.trackCreation(operationIdentity);
			try {
				return await agentLeaseOperationLock.runExclusive(operationIdentity, async () => {
					authorityRuntime.registerGateway(leaseOptions.expectedGateway);
					const currentAuthority = authorityRuntime.authorityForCurrentAgent({
						agentId: leaseOptions.agentId,
						gateway: leaseOptions.expectedGateway,
					});
					if (
						currentAuthority === undefined ||
						currentAuthority.leaseId !== oldLeaseId ||
						!gatewayIdentitiesEqual(currentAuthority.gateway, leaseOptions.expectedGateway) ||
						!stableToolVmLeasePrincipalsEqual(currentAuthority.principal, principal)
					) {
						throw new Error(
							`Tool VM lease '${oldLeaseId}' is not the current lease for Gateway agent '${leaseOptions.agentId}'.`,
						);
					}
					const currentLease = authorityRuntime.getCleanupLease(oldLeaseId);
					const cleanupContext = authorityRuntime.cleanupContextForAuthority(currentAuthority);
					if (currentLease === undefined || cleanupContext === undefined) {
						throw new Error(
							`Tool VM lease '${oldLeaseId}' has no retained lease or cleanup context.`,
						);
					}
					const retirement = beginToolVmCleanupContextRetirement({
						authority: currentAuthority,
						cleanupContext,
						notifyRetirement: 'released',
						reason: 'released',
					});
					return await createReplacementLeaseWhileLocked({ leaseOptions, retirement }).catch(
						(error: unknown) => {
							writeLeaseManagerWarning(
								`failed to replace lease '${currentLease.id}' in zone '${currentLease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${currentLease.tcpSlot} and refusing successor admission.`,
							);
							throw error;
						},
					);
				});
			} finally {
				finishTrackingCreation();
			}
		},
		async destroyGatewayOwnedLeases(expectedGateway, signal) {
			// A Gateway with no Tool VM leaves may never have entered the lease
			// authority runtime. Registering its exact identity immediately before
			// sealing makes empty-subtree destruction explicit without reopening a
			// previously known parent or admitting a child.
			authorityRuntime.registerGateway(expectedGateway);
			authorityRuntime.sealGateway(expectedGateway);
			for (;;) {
				const agentIdentitiesByAgentId = new Map<string, AgentLeaseOperationIdentity>();
				for (const identity of leaseCreationRegistry.inFlightAgentIdentitiesForGateway(
					expectedGateway,
				)) {
					agentIdentitiesByAgentId.set(identity.agentId, identity);
				}
				for (const leaseId of authorityRuntime.leaseIdsOwnedByGateway(expectedGateway)) {
					const authority = authorityRuntime.authorityForLease(leaseId);
					if (authority !== undefined) {
						agentIdentitiesByAgentId.set(
							authority.principal.agentId,
							agentLeaseOperationIdentity({
								agentId: authority.principal.agentId,
								gateway: authority.gateway,
							}),
						);
					}
				}
				if (agentIdentitiesByAgentId.size === 0) {
					break;
				}
				const cleanupTasks = [...agentIdentitiesByAgentId.values()].map(
					(identity): (() => Promise<void>) =>
						async () =>
							await agentLeaseOperationLock.runExclusive(identity, async () => {
								for (;;) {
									const authoritiesForAgent = authorityRuntime
										.leaseIdsOwnedByGateway(expectedGateway)
										.flatMap((leaseId): readonly ToolVmLeafAuthorityReference[] => {
											const authority = authorityRuntime.authorityForLease(leaseId);
											return authority !== undefined &&
												authority.principal.agentId === identity.agentId
												? [authority]
												: [];
										});
									if (authoritiesForAgent.length === 0) {
										return;
									}
									for (const authority of authoritiesForAgent) {
										const lease = authorityRuntime.getCleanupLease(authority.leaseId);
										if (lease !== undefined) {
											// oxlint-disable-next-line no-await-in-loop -- exact authority cleanup is intentionally serialized per agent
											await destroyRetainedLease({
												lease,
												notifyRetirement: true,
												reason: 'released',
											});
										} else {
											// oxlint-disable-next-line no-await-in-loop -- exact authority cleanup is intentionally serialized per agent
											await destroyProvisionalAuthority({
												authority,
												reason: 'gateway-released',
											});
										}
									}
								}
							}),
				);
				// oxlint-disable-next-line no-await-in-loop -- a newly discovered authority cohort must settle before the next sweep
				const results = await settleGatewayChildDestructionTasks(
					cleanupTasks,
					signal === undefined ? {} : { signal },
				);
				const failures = results.flatMap((result): readonly unknown[] =>
					result.status === 'rejected' ? [result.reason as unknown] : [],
				);
				if (failures.length > 0) {
					throw new AggregateError(
						failures,
						`Gateway VM epoch '${expectedGateway.gatewayEpochId}' has ${String(failures.length)} incomplete Tool VM disposition${failures.length === 1 ? '' : 's'}.`,
					);
				}
			}
			authorityRuntime.retireGateway(expectedGateway);
			lostProcessEpochsByGateway.delete(gatewayAuthorityKey(expectedGateway));
		},
		endActiveUse(
			leaseId: string,
			useId: string,
			request,
		): { readonly kind: 'ended' | 'unknown-use' } | undefined {
			const lease = authorityRuntime.getLease(leaseId);
			if (!lease) {
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			const authority = requireAuthorizedLeaseAuthority({
				authority: request.authority,
				leaseId,
			});
			if (!authorityRuntime.activeUseSnapshots(leaseId).some((use) => use.useId === useId)) {
				return { kind: 'unknown-use' };
			}
			authorityRuntime.applyAuthorityCommand({
				authority,
				endedAtMs: options.now(),
				kind: 'end-active-use',
				...(request.report === undefined ? {} : { operationReport: request.report }),
				outcome: request.outcome === 'completed' ? 'completed' : 'failed-observed',
				processEpoch: request.processEpoch,
				sessionAttachmentGeneration: request.sessionAttachmentGeneration,
				useId,
			});
			touchLease(lease);
			return { kind: 'ended' };
		},
		getActiveUseCount(leaseId: string): number {
			return activeUseCountForLease(leaseId);
		},
		getCurrentNonterminalUses(leaseId: string): readonly ToolVmLeaseCurrentNonterminalUse[] {
			return authorityRuntime
				.activeUseSnapshots(leaseId)
				.filter(isCurrentNonterminalUse)
				.map((currentUse) => ({
					expiresAtMs:
						currentUse.kind === 'observation-gap'
							? currentUse.resumeDeadlineMs
							: currentUse.lastHeartbeatAtMs + toolVmUsePolicy.heartbeatStaleMs,
					useId: currentUse.useId,
				}));
		},
		getCurrentLeaseBinding(leaseId: string): AuthorizedToolVmLeafBinding | undefined {
			const leaf = authorityRuntime.leafSnapshotForLease(leaseId);
			if (leaf?.kind !== 'current') {
				return undefined;
			}
			return {
				idleExpiresAtMs: leaf.idleExpiresAtMs,
				leafGeneration: leaf.leafGeneration,
				leaseId: leaf.leaseId,
				runtimeBinding: leaf.runtimeBinding,
				sshBinding: leaf.sshBinding,
			};
		},
		getLeaseAuthority(leaseId) {
			const authority = authorityRuntime.authorityForLease(leaseId);
			const leaf = authorityRuntime.leafSnapshotForLease(leaseId);
			return authority === undefined || leaf?.kind !== 'current'
				? undefined
				: { authority, compatibility: leaf.compatibility };
		},
		getActiveUses(leaseId: string): readonly ToolVmActiveUseSnapshot[] {
			return authorityRuntime.activeUseSnapshots(leaseId).map((activeUse) =>
				Object.assign(
					{
						expiresAt:
							activeUse.kind === 'observation-gap'
								? activeUse.resumeDeadlineMs
								: activeUse.kind === 'ambiguous'
									? activeUse.ambiguousAtMs
									: activeUse.kind === 'terminal'
										? activeUse.endedAtMs
										: activeUse.lastHeartbeatAtMs + toolVmUsePolicy.heartbeatStaleMs,
						leaseId,
						startedAt: activeUse.startedAtMs,
						useId: activeUse.useId,
					},
					activeUse.correlation === undefined ? {} : { correlation: activeUse.correlation },
					activeUse.latestOperationReport === undefined
						? {}
						: { latestReport: activeUse.latestOperationReport },
				),
			);
		},
		markControlSessionDisconnected(disconnectOptions): void {
			authorityRuntime.applyAuthorityCommand({
				gateway: disconnectOptions.gateway,
				kind: 'session-disconnected',
				observedAtMs: disconnectOptions.observedAtMs,
				processEpoch: disconnectOptions.processEpoch,
				sessionAttachmentGeneration: disconnectOptions.sessionAttachmentGeneration,
			});
		},
		heartbeatActiveUse(leaseId, useId, request): HeartbeatToolVmActiveUseResponse | undefined {
			const lease = authorityRuntime.getLease(leaseId);
			const activeUse = authorityRuntime
				.activeUseSnapshots(leaseId)
				.find((use) => use.useId === useId);
			if (!lease || activeUse === undefined) {
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			if (isLeaseExpired(lease)) {
				return undefined;
			}
			const authority = requireAuthorizedLeaseAuthority({
				authority: request.authority,
				leaseId,
			});
			const now = options.now();
			if (activeUse.kind === 'observation-gap') {
				authorityRuntime.applyAuthorityCommand({
					authority,
					kind: 'resume-active-use',
					lastHeartbeatAtMs: now,
					nowMs: now,
					processEpoch: request.processEpoch,
					sessionAttachmentGeneration: request.sessionAttachmentGeneration,
					useId,
				});
			}
			authorityRuntime.applyAuthorityCommand({
				authority,
				heartbeatAtMs: now,
				kind: 'heartbeat-active-use',
				...(request.report === undefined ? {} : { operationReport: request.report }),
				processEpoch: request.processEpoch,
				sessionAttachmentGeneration: request.sessionAttachmentGeneration,
				useId,
			});
			touchLease(lease);
			return {
				expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
				heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
			};
		},
		async renewLease(leaseId: string): Promise<LeaseRenewal> {
			const lease = authorityRuntime.getLease(leaseId);
			if (!lease) {
				if (authorityRuntime.getRetainedLease(leaseId) !== undefined) {
					throw new Error(
						`Tool VM lease '${leaseId}' is releasing and retained for exact cleanup; it cannot be renewed.`,
					);
				}
				return { kind: 'not-found', reason: 'missing' };
			}
			const authority = authorityRuntime.authorityForLease(leaseId);
			if (authority === undefined) {
				throw new Error(`Tool VM lease '${leaseId}' has no current authority.`);
			}
			return await agentLeaseOperationLock.runExclusive(
				agentLeaseOperationIdentity({
					agentId: authority.principal.agentId,
					gateway: authority.gateway,
				}),
				async () => {
					const currentLease = authorityRuntime.getLease(leaseId);
					if (!currentLease) {
						return { kind: 'not-found', reason: 'missing' };
					}
					assertLeaseGatewayAdmitting(currentLease);
					const activeUseCount = activeUseCountForLease(currentLease.id);
					if (
						isToolVmLeaseExpired({
							activeUseCount,
							effectiveIdleTtlMs: currentLease.effectiveIdleTtlMs,
							lastUsedAt: currentLease.lastUsedAt,
							nowMs: options.now(),
						})
					) {
						await evictLease(currentLease, 'expired');
						return { kind: 'not-found', reason: 'expired' };
					}
					const renewalDecision = classifyToolVmLeaseRenewal({
						activeUseCount,
						effectiveIdleTtlMs: currentLease.effectiveIdleTtlMs,
						lastUsedAt: currentLease.lastUsedAt,
						nowMs: options.now(),
						vmLive: await isToolVmLeaseVmLive(currentLease),
					});
					if (renewalDecision.kind === 'evict-dead') {
						await evictLease(currentLease, 'dead');
						return { kind: 'not-found', reason: 'dead' };
					}
					const renewedLease = touchLease(currentLease);
					return {
						kind: 'renewed',
						lastUsedAt: renewedLease.lastUsedAt,
						lease: renewedLease,
					};
				},
			);
		},
		listLeases(): readonly Lease[] {
			return authorityRuntime.listLeases();
		},
		peekLease(leaseId: string): LeaseSnapshot | undefined {
			const lease = authorityRuntime.getRetainedLease(leaseId);
			return lease ? { kind: 'snapshot', lease } : undefined;
		},
		async reapDeadIdleLeases(): Promise<void> {
			const cleanupCompletions: Promise<unknown>[] = [];
			for (const lease of authorityRuntime.listLeases()) {
				const authority = authorityRuntime.authorityForLease(lease.id);
				if (authority === undefined) {
					continue;
				}
				// oxlint-disable-next-line eslint/no-await-in-loop -- per-agent lock serializes eviction with renew/create/release
				const retirement = await agentLeaseOperationLock.runExclusive(
					agentLeaseOperationIdentity({
						agentId: authority.principal.agentId,
						gateway: authority.gateway,
					}),
					async () => {
						const currentLease = authorityRuntime.getLease(lease.id);
						if (!currentLease || activeUseCountForLease(currentLease.id) > 0) {
							return undefined;
						}
						if (!(await isToolVmLeaseVmLive(currentLease))) {
							return await evictLease(currentLease, 'dead');
						}
						return undefined;
					},
				);
				if (retirement !== undefined) {
					cleanupCompletions.push(retirement.completion);
				}
			}
			await Promise.all(cleanupCompletions);
		},
		reapExpiredActiveUses(): void {
			const now = options.now();
			for (const lease of authorityRuntime.listLeases()) {
				const authority = authorityRuntime.authorityForLease(lease.id);
				if (authority === undefined) {
					continue;
				}
				for (const activeUse of authorityRuntime.activeUseSnapshots(lease.id)) {
					if (activeUse.kind === 'observation-gap' && activeUse.resumeDeadlineMs <= now) {
						authorityRuntime.applyAuthorityCommand({
							ambiguousAtMs: now,
							authority,
							expectedSessionAttachmentGeneration: activeUse.sessionAttachmentGeneration,
							kind: 'expire-observation-gap',
							nowMs: now,
							useId: activeUse.useId,
						});
					}
				}
			}
			authorityRuntime.applyAuthorityCommand({ kind: 'prune-tombstones', nowMs: now });
		},
		async releaseLease(
			leaseId: string,
			releaseOptions?: { readonly force?: boolean; readonly ifLastUsedAtBeforeOrAt?: number },
		): Promise<void> {
			const lease = authorityRuntime.getRetainedLease(leaseId);
			if (!lease) {
				return;
			}
			const retainedAuthority = authorityRuntime.authorityForLease(leaseId);
			if (retainedAuthority === undefined) {
				return;
			}
			await agentLeaseOperationLock.runExclusive(
				agentLeaseOperationIdentity({
					agentId: retainedAuthority.principal.agentId,
					gateway: retainedAuthority.gateway,
				}),
				async () => {
					const currentLease = authorityRuntime.getRetainedLease(leaseId);
					if (!currentLease) {
						return;
					}
					const authority = authorityRuntime.authorityForLease(leaseId);
					if (authority === undefined) {
						return;
					}
					const cleanupContext = authorityRuntime.cleanupContextForAuthority(authority);
					if (cleanupContext === undefined) {
						throw new Error(`Tool VM lease '${leaseId}' has no retained cleanup context.`);
					}
					const admission = authorityRuntime.admitExactDestruction({
						authority,
						cleanup: async (): Promise<void> => await completeToolVmResourceCleanup(cleanupContext),
						destroyedAtMs: options.now(),
						fenceAccess: async () =>
							await fenceToolVmAccess({
								cleanupContext,
								exactProcessTermination: options.managedVmExactProcessTermination,
							}),
						policy:
							releaseOptions?.force === true
								? { kind: 'force' }
								: {
										...(releaseOptions?.ifLastUsedAtBeforeOrAt === undefined
											? {}
											: {
													ifLastUsedAtBeforeOrAt: releaseOptions.ifLastUsedAtBeforeOrAt,
												}),
										kind: 'require-no-active-use',
									},
						reason: 'released',
					});
					if (admission.kind === 'skip-recently-used') {
						return;
					}
					if (admission.kind === 'blocked-active-use') {
						throw new LeaseActiveUseConflictError(
							`Tool VM lease '${leaseId}' is still in active use.`,
						);
					}
					const retirement = observeToolVmCleanupContextRetirement({
						cleanupContext,
						destruction: admission,
						notifyRetirement: 'released',
						retiredLeaseId: currentLease.id,
					});
					try {
						await retirement.completion;
					} catch (error) {
						writeLeaseManagerWarning(
							`failed to close released lease '${currentLease.id}' in zone '${currentLease.zoneId}': ${formatLeaseManagerError(error)}. Quarantining tcp slot ${currentLease.tcpSlot} and preserving runtime record for exact retry.`,
						);
						throw error;
					}
				},
			);
		},
		startActiveUse(leaseId, request): StartToolVmActiveUseResponse | undefined {
			const lease = authorityRuntime.getLease(leaseId);
			if (!lease) {
				if (authorityRuntime.leafSnapshotForLease(leaseId) !== undefined) {
					throw new LeaseActiveUseConflictError(
						`Tool VM lease '${leaseId}' is not available for new active work.`,
					);
				}
				return undefined;
			}
			assertLeaseGatewayAdmitting(lease);
			if (isLeaseExpired(lease)) {
				return undefined;
			}
			if (!isToolVmActiveUseId(request.useId)) {
				throw new TypeError(`Tool VM active-use id '${request.useId}' must be a UUIDv7.`);
			}
			const authority = requireAuthorizedLeaseAuthority({
				authority: request.authority,
				leaseId,
			});
			assertProcessEpochCanStartUse(authority.gateway, request.processEpoch);
			const existingUse = authorityRuntime
				.activeUseSnapshots(leaseId)
				.find((use) => use.useId === request.useId);
			const now = options.now();
			const correlation = normalizeToolVmActiveUseCorrelation(request.correlation);
			authorityRuntime.applyAuthorityCommand({
				authority,
				kind: 'start-active-use',
				use: {
					...(correlation === undefined ? {} : { correlation }),
					lastHeartbeatAtMs: now,
					...(request.report === undefined ? {} : { latestOperationReport: request.report }),
					operationPayloadDigest: request.operationPayloadDigest,
					processEpoch: request.processEpoch,
					semanticOperationId: request.semanticOperationId,
					sessionAttachmentGeneration: request.sessionAttachmentGeneration,
					startedAtMs: now,
					useId: request.useId,
				},
			});
			if (existingUse !== undefined) {
				return {
					expiresAt:
						existingUse.kind === 'observation-gap'
							? existingUse.resumeDeadlineMs
							: 'lastHeartbeatAtMs' in existingUse
								? existingUse.lastHeartbeatAtMs + toolVmUsePolicy.heartbeatStaleMs
								: options.now(),
					heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
					useId: existingUse.useId,
				};
			}
			touchLease(lease);
			return {
				expiresAt: now + toolVmUsePolicy.heartbeatStaleMs,
				heartbeatAfterMs: toolVmUsePolicy.heartbeatAfterMs,
				useId: request.useId,
			};
		},
		subscribeLeaseRetirement(listener) {
			leaseRetirementListeners.add(listener);
			return () => {
				leaseRetirementListeners.delete(listener);
			};
		},
	};
}
