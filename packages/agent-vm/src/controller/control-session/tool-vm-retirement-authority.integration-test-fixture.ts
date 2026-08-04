import { randomUUID } from 'node:crypto';

import {
	deriveGatewayControlStablePrincipal,
	type GatewayControlRpcMessage,
	type GatewayControlToolVmBindingPublication,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import {
	createGatewayControlBindingPublicationHandler,
	createGatewayControlCallerContextRegistrationClient,
	createGatewayControlDeferredApplicationMessageHandler,
	createGatewayControlOperationActiveUseRuntime,
	createGatewayControlPublishedBindingRuntime,
	createGatewayRuntimeControlCommandClient,
	startGatewayControlEndpoint,
	type GatewayControlAcceptedSession,
	type GatewayControlOperationActiveUseAcquisition,
	type GatewayControlService,
	type GatewayRuntimeControlCommandClient,
	type GatewayRuntimeSandboxProcessRegistry,
	type StrictToolVmSshClient,
	type StrictToolVmSshProcessChannelClient,
	type StrictToolVmSshTransportFailure,
} from '@agent-vm/gateway-runtime';
import type { ManagedVm } from '@agent-vm/managed-vm';
import { vi } from 'vitest';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import { createIdleReaper } from '../leases/idle-reaper.js';
import { createLeaseManager, type LeaseManager } from '../leases/lease-manager.js';
import { createTcpPool } from '../leases/tcp-pool.js';
import { createGatewayOwnershipCoordinator } from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	createControlSessionDispatcher,
	createControlSessionFenceRegistry,
} from './control-session-dispatcher.js';
import { createGatewayControlBindingPublicationCoordinator } from './gateway-control-binding-publication.js';
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	resolveGatewayControlInboundStablePrincipal,
} from './gateway-control-domain-handler.js';
import { createGatewayControlLeaseRpcOperations } from './gateway-control-lease-rpc.js';
import {
	buildGatewayControlEndpoint,
	connectGatewayControlSession,
	createGatewayControlSessionMaterial,
} from './gateway-control-session.js';
import { createGatewaySemanticResultLedger } from './gateway-semantic-result-ledger.js';

export const trustedContext = Object.freeze({
	principal: {
		agentId: 'main',
		frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
		profileAssignmentRevision: 'assignment-main',
		toolPortalProfileId: 'builder',
	},
}) satisfies GatewayRuntimeTrustedInvocationContext;

export const stablePrincipal = deriveGatewayControlStablePrincipal({
	principal: trustedContext.principal,
});
export const unrelatedTrustedContext = Object.freeze({
	principal: {
		agentId: 'unrelated',
		frameworkIdentity: { agentId: 'unrelated', kind: 'openclaw' },
		profileAssignmentRevision: 'assignment-unrelated',
		toolPortalProfileId: 'builder',
	},
}) satisfies GatewayRuntimeTrustedInvocationContext;
export const secretIdentityPem = '-----BEGIN OPENSSH PRIVATE KEY----- secret-causal-proof';

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

interface CausalEvidence {
	readonly agentKey: string;
	readonly connectionGeneration: number;
	readonly event: string;
	readonly leafGeneration: string;
	readonly leaseId: string;
	readonly sequence: number;
}

function deferred(): Deferred {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

function refuseUnexpectedOperation(): never {
	throw new Error('Operation is outside the deterministic causal integration proof.');
}

async function refuseUnexpectedAsyncOperation(): Promise<never> {
	return refuseUnexpectedOperation();
}

interface StrictSshFixture {
	readonly client: StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	emitTransportFailure(failure: StrictToolVmSshTransportFailure): void;
	setCloseObserver(observer: (options?: { readonly notifyTransportFailure?: true }) => void): void;
}

function createStrictSshFixture(): StrictSshFixture {
	const transportFailureObservers = new Set<(failure: StrictToolVmSshTransportFailure) => void>();
	let closeObserver: ((options?: { readonly notifyTransportFailure?: true }) => void) | undefined;
	const client = {
		close: vi.fn((options?: { readonly notifyTransportFailure?: true }) => {
			closeObserver?.(options);
		}),
		connect: vi.fn(async () => undefined),
		execute: refuseUnexpectedAsyncOperation,
		guestListDirectory: refuseUnexpectedAsyncOperation,
		guestMkdir: refuseUnexpectedAsyncOperation,
		guestReadFile: refuseUnexpectedAsyncOperation,
		guestRemove: refuseUnexpectedAsyncOperation,
		guestRename: refuseUnexpectedAsyncOperation,
		guestStat: refuseUnexpectedAsyncOperation,
		guestWriteFile: refuseUnexpectedAsyncOperation,
		listDirectory: refuseUnexpectedAsyncOperation,
		mkdir: refuseUnexpectedAsyncOperation,
		observeTransportFailure: (observer: (failure: StrictToolVmSshTransportFailure) => void) => {
			transportFailureObservers.add(observer);
			return { unsubscribe: () => transportFailureObservers.delete(observer) };
		},
		openProcessChannel: refuseUnexpectedAsyncOperation,
		openShellProcessChannel: refuseUnexpectedAsyncOperation,
		readFile: refuseUnexpectedAsyncOperation,
		remove: refuseUnexpectedAsyncOperation,
		rename: refuseUnexpectedAsyncOperation,
		stat: refuseUnexpectedAsyncOperation,
		writeFile: refuseUnexpectedAsyncOperation,
	} satisfies StrictToolVmSshClient & StrictToolVmSshProcessChannelClient;
	return {
		client,
		emitTransportFailure: (failure) => {
			for (const observer of transportFailureObservers) observer(failure);
		},
		setCloseObserver: (observer) => {
			closeObserver = observer;
		},
	};
}

function createProcessRegistry(): GatewayRuntimeSandboxProcessRegistry {
	return {
		cancel: refuseUnexpectedOperation,
		closeStream: refuseUnexpectedOperation,
		logs: refuseUnexpectedOperation,
		read: refuseUnexpectedOperation,
		resizeTerminal: refuseUnexpectedOperation,
		retire: async () => undefined,
		start: refuseUnexpectedAsyncOperation,
		startShell: refuseUnexpectedAsyncOperation,
		status: refuseUnexpectedOperation,
		terminalExitCode: refuseUnexpectedOperation,
		wait: refuseUnexpectedAsyncOperation,
		write: refuseUnexpectedAsyncOperation,
	};
}

export function assertPartialOrder(
	evidence: readonly CausalEvidence[],
	events: readonly string[],
): void {
	const sequenceByEvent = new Map<string, number>();
	for (const entry of evidence) {
		if (!sequenceByEvent.has(entry.event)) sequenceByEvent.set(entry.event, entry.sequence);
	}
	for (let index = 1; index < events.length; index += 1) {
		const predecessor = sequenceByEvent.get(events[index - 1] ?? '');
		const successor = sequenceByEvent.get(events[index] ?? '');
		if (predecessor === undefined || successor === undefined || predecessor >= successor) {
			throw new Error(
				`Causal partial order failed for ${events.join(' < ')}: ${JSON.stringify(evidence)}`,
			);
		}
	}
}

export interface CausalFixture {
	readonly activeUseRuntime: ReturnType<typeof createGatewayControlOperationActiveUseRuntime>;
	readonly connectionRotationCompleted: Promise<void>;
	readonly evidence: readonly CausalEvidence[];
	readonly firstLeaseCreationMayFinish: Deferred;
	readonly gatewayService: GatewayControlService;
	readonly gatewaySshCloseStarted: Promise<void>;
	readonly idleReaper: ReturnType<typeof createIdleReaper>;
	readonly leaseManager: LeaseManager;
	readonly predecessorDestructionObserved: Promise<void>;
	readonly predecessorExactAbsenceMayFinish: Deferred;
	readonly publishedBindingRuntime: ReturnType<typeof createGatewayControlPublishedBindingRuntime>;
	readonly stalePublicationRejected: Deferred;
	readonly successorProvisionalBootObserved: Promise<void>;
	armPredecessorExactAbsenceBarrier(): void;
	close(): Promise<void>;
	emitCurrentBindingTransportFailure(): void;
	rejectNextReadyUseWithStaleGatewayBinding(): void;
	recordWaitingCallCompleted(acquisition: GatewayControlOperationActiveUseAcquisition): void;
}

export async function createCausalFixture(options: {
	readonly commandResultTimeoutMs: number;
	readonly commandTtlMs: number;
	readonly effectiveIdleTtlMs?: number;
	readonly now?: () => number;
}): Promise<CausalFixture> {
	const now = options.now ?? Date.now;
	const evidence: CausalEvidence[] = [];
	const record = (
		event: string,
		leaseId: string,
		leafGeneration: string,
		connectionGeneration: number,
		agentKey: string = trustedContext.principal.agentId,
	): void => {
		evidence.push({
			agentKey,
			connectionGeneration,
			event,
			leafGeneration,
			leaseId,
			sequence: evidence.length + 1,
		});
	};
	const material = createGatewayControlSessionMaterial({
		agentIds: [trustedContext.principal.agentId, unrelatedTrustedContext.principal.agentId],
		controllerEpoch: 'controller-retirement-proof',
		generationId: 'gateway-retirement-proof',
		processEpoch: 'process-retirement-proof',
		zoneId: 'zone-retirement-proof',
	});
	const ownershipCoordinator = createGatewayOwnershipCoordinator({
		controllerEpoch: material.controllerEpoch,
		createGatewayEpochId: () => material.generationId,
	});
	const gateway = ownershipCoordinator
		.beginGatewayEpoch({
			bootId: material.bootId,
			generationId: material.generationId,
			zoneId: material.zoneId,
		})
		.attachGatewayVm('gateway-vm-retirement-proof');
	const deferredHandler = createGatewayControlDeferredApplicationMessageHandler();
	const gatewayEndpoint = await startGatewayControlEndpoint({
		applicationMessageHandler: deferredHandler.handler,
		identity: {
			bootId: material.bootId,
			controllerEpoch: material.controllerEpoch,
			generationId: material.generationId,
			peerId: material.peerId,
			processEpoch: material.processEpoch,
			zoneId: material.zoneId,
		},
		listen: { host: '127.0.0.1', port: 0 },
		verifierPublicKeyPem: material.verifierPublicKeyPem,
	});
	const gatewayService = gatewayEndpoint.service;
	const gatewaySshCloseStarted = deferred();
	const predecessorManagedVmCloseMayFinish = deferred();
	let predecessorIdleRetirementArmed = false;
	const strictSshFixtures: StrictSshFixture[] = [];
	const publishedBindingRuntime = createGatewayControlPublishedBindingRuntime({
		controlService: gatewayService,
		createStrictSshClient: () => {
			const fixture = createStrictSshFixture();
			if (strictSshFixtures.length === 0) {
				fixture.setCloseObserver((closeOptions) => {
					predecessorManagedVmCloseMayFinish.resolve();
					if (!predecessorIdleRetirementArmed || closeOptions?.notifyTransportFailure !== true)
						return;
					const lookup = publishedBindingRuntime.lookupReadyConnection({ trustedContext });
					if (lookup.kind !== 'unavailable') {
						throw new Error('Gateway predecessor binding remained available during SSH close.');
					}
					record(
						'gateway-binding-unrouted',
						'lease-causal-1',
						'leaf-causal-1',
						currentAuthority?.attachmentGeneration ?? 0,
					);
					record(
						'gateway-ssh-close-started',
						'lease-causal-1',
						'leaf-causal-1',
						currentAuthority?.attachmentGeneration ?? 0,
					);
					gatewaySshCloseStarted.resolve();
					record(
						'gateway-ssh-close-completed',
						'lease-causal-1',
						'leaf-causal-1',
						currentAuthority?.attachmentGeneration ?? 0,
					);
				});
			}
			strictSshFixtures.push(fixture);
			return fixture.client;
		},
		now,
	});
	deferredHandler.bind(
		createGatewayControlBindingPublicationHandler({
			applyPublication: publishedBindingRuntime.applyPublication,
		}),
	);
	const firstLeaseCreationMayFinish = deferred();
	const predecessorDestructionObserved = deferred();
	const predecessorExactAbsenceMayFinish = deferred();
	const stalePublicationRejected = deferred();
	const successorProvisionalBootObserved = deferred();
	const leaseIds = ['lease-causal-1', 'lease-causal-2', 'lease-causal-3', 'lease-causal-4'];
	const leafGenerations = ['leaf-causal-1', 'leaf-causal-2', 'leaf-causal-3', 'leaf-causal-4'];
	let leaseIdIndex = 0;
	let leafGenerationIndex = 0;
	let vmIndex = 0;
	let mainVmCreationCount = 0;
	let mainSuccessorLeaseId: string | undefined;
	let predecessorExactAbsenceBarrierArmed = false;
	let predecessorExactAbsenceBarrierConsumed = false;
	const leaseManager = createLeaseManager({
		controllerPort: 18_800,
		createLeaseId: () => leaseIds[leaseIdIndex++] ?? refuseUnexpectedOperation(),
		createLeafGeneration: () =>
			leafGenerations[leafGenerationIndex++] ?? refuseUnexpectedOperation(),
		createManagedVm: async ({ agentId }): Promise<ManagedVm> => {
			const currentVmIndex = vmIndex++;
			const currentLeaseId = leaseIds[currentVmIndex] ?? refuseUnexpectedOperation();
			const currentLeafGeneration = leafGenerations[currentVmIndex] ?? refuseUnexpectedOperation();
			const currentMainVmCreation =
				agentId === trustedContext.principal.agentId ? mainVmCreationCount++ : undefined;
			const isMainSuccessor = currentMainVmCreation === 1;
			if (isMainSuccessor) mainSuccessorLeaseId = currentLeaseId;
			if (currentVmIndex === 0) {
				record('waiting-acquire-observed', currentLeaseId, currentLeafGeneration, 1, agentId);
				await firstLeaseCreationMayFinish.promise;
			}
			if (isMainSuccessor && predecessorExactAbsenceBarrierArmed) {
				record(
					'successor-provisional-boot-observed',
					currentLeaseId,
					currentLeafGeneration,
					currentAuthority?.attachmentGeneration ?? 0,
					agentId,
				);
				successorProvisionalBootObserved.resolve();
			}
			let hostPidReadCount = 0;
			return {
				close: vi.fn(async () => {
					if (currentVmIndex === 0 && predecessorIdleRetirementArmed) {
						await predecessorManagedVmCloseMayFinish.promise;
					}
				}),
				configureIngressRoutes: vi.fn(),
				enableIngress: vi.fn(async () => ({
					close: async () => undefined,
					host: '127.0.0.1',
					port: 18_791,
				})),
				enableSsh: vi.fn(async () => {
					if (isMainSuccessor && predecessorExactAbsenceBarrierArmed) {
						record(
							'successor-ssh-observed',
							currentLeaseId,
							currentLeafGeneration,
							currentAuthority?.attachmentGeneration ?? 0,
							agentId,
						);
						record(
							'successor-ssh-enabled',
							currentLeaseId,
							currentLeafGeneration,
							currentAuthority?.attachmentGeneration ?? 0,
							agentId,
						);
					}
					return {
						close: async () => undefined,
						command: 'ssh sandbox@127.0.0.1',
						host: '127.0.0.1',
						identityFile: `/tmp/secret-tool-vm-key-${String(currentVmIndex)}`,
						port: 19_000 + currentVmIndex,
						serverHostKey: TEST_SSH_SERVER_HOST_KEY,
						user: 'sandbox',
					};
				}),
				exec: vi.fn(() => createManagedExecProcessStub()),
				getHostProcessId: () => (hostPidReadCount++ === 0 ? 12_345 + currentVmIndex : null),
				id: `tool-vm-${String(currentVmIndex + 1)}`,
				start: vi.fn(async () => undefined),
			};
		},
		deleteToolVmRuntimeRecord: vi.fn(async () => undefined),
		managedVmExactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => {
				if (
					predecessorExactAbsenceBarrierArmed &&
					!predecessorExactAbsenceBarrierConsumed &&
					identity.hostProcessId === 12_345
				) {
					predecessorExactAbsenceBarrierConsumed = true;
					if (leaseManager.getCurrentLeaseBinding('lease-causal-1') !== undefined) {
						throw new Error(
							'Controller predecessor binding remained current after retirement fence.',
						);
					}
					record(
						'retirement-fenced',
						leaseIds[0] ?? '',
						leafGenerations[0] ?? '',
						currentAuthority?.attachmentGeneration ?? 0,
					);
					record(
						'tool-vm-termination-started',
						leaseIds[0] ?? '',
						leafGenerations[0] ?? '',
						currentAuthority?.attachmentGeneration ?? 0,
					);
					record(
						'predecessor-destruction-observed',
						leaseIds[0] ?? '',
						leafGenerations[0] ?? '',
						currentAuthority?.attachmentGeneration ?? 0,
					);
					predecessorDestructionObserved.resolve();
					await predecessorExactAbsenceMayFinish.promise;
					record(
						'predecessor-exact-absence-proved',
						leaseIds[0] ?? '',
						leafGenerations[0] ?? '',
						currentAuthority?.attachmentGeneration ?? 0,
					);
					record(
						'tool-vm-absence-proven',
						leaseIds[0] ?? '',
						leafGenerations[0] ?? '',
						currentAuthority?.attachmentGeneration ?? 0,
					);
					record(
						'successor-admission-released',
						mainSuccessorLeaseId ?? '',
						mainSuccessorLeaseId === undefined
							? ''
							: (leafGenerations[leaseIds.indexOf(mainSuccessorLeaseId)] ?? ''),
						currentAuthority?.attachmentGeneration ?? 0,
					);
				}
				return {
					hostProcessId: identity.hostProcessId,
					kind: 'already-absent',
				};
			},
		},
		managedVmTerminationSleep: async () => undefined,
		now,
		ownershipCoordinator,
		projectNamespace: 'tool-vm-retirement-authority-integration',
		readProcessIdentity: async () => ({ command: 'qemu-system-x86_64', lstart: 'start' }),
		readTcpListenPortOwner: async () => null,
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool: createTcpPool({ basePort: 19_000, size: 4 }),
		toolLeaseRecordsTargetFor: (zoneId) =>
			({
				directoryPath: `/tmp/tool-vm-retirement-authority/${zoneId}`,
				kind: 'controller-tool-lease-records',
				zoneId,
			}) satisfies ControllerToolLeaseRecordsTarget,
		writeToolVmRuntimeRecord: vi.fn(async () => undefined),
	});
	const idleReaper = createIdleReaper({
		getLeases: () =>
			leaseManager.listLeases().map((lease) => ({
				activeUseCount: leaseManager.getActiveUseCount(lease.id),
				effectiveIdleTtlMs: lease.effectiveIdleTtlMs,
				id: lease.id,
				lastUsedAt: lease.lastUsedAt,
			})),
		now,
		releaseLease: async (leaseId, releaseOptions) => {
			await leaseManager.releaseLease(leaseId, releaseOptions);
		},
	});
	const leaseRpc = createGatewayControlLeaseRpcOperations({
		leaseManager,
		readIdentityPem: async () => secretIdentityPem,
		resolveLeaseCreateOptions: async ({ callerContext }) => ({
			agentId: callerContext.agentId,
			effectiveIdleTtlMs: options.effectiveIdleTtlMs ?? 60_000,
			expectedGateway: gateway,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: '/host/gitdirs/main',
			hostWorkspaceRoot: '/host/workspace',
			profile: { cpus: 1, imageProfile: 'tool-default', memory: '1G' },
			profileId: 'builder',
			zoneId: material.zoneId,
		}),
	});
	let currentAuthority: GatewayControlToolVmBindingPublication['authority'] | undefined;
	const controllerClientState: {
		current: Awaited<ReturnType<typeof connectGatewayControlSession>> | undefined;
	} = { current: undefined };
	const realPublicationCoordinator = createGatewayControlBindingPublicationCoordinator({
		createBinding: leaseRpc.createBinding,
		now,
		publish: async (publication, publicationOptions) => {
			if (controllerClientState.current === undefined)
				throw new Error('Controller session is not connected.');
			const messageId = randomUUID();
			const message = {
				kind: 'command',
				operation: 'tool_vm_binding_publish',
				payload: publication,
			} satisfies GatewayControlRpcMessage;
			if (publication.kind === 'current' && publication.binding.leaseId === mainSuccessorLeaseId) {
				record(
					'successor-current-committed',
					publication.binding.leaseId,
					publication.binding.leafGeneration,
					publication.authority.attachmentGeneration,
					publication.binding.agentId,
				);
				record(
					'successor-binding-published',
					publication.binding.leaseId,
					publication.binding.leafGeneration,
					publication.authority.attachmentGeneration,
					publication.binding.agentId,
				);
			}
			await controllerClientState.current.emitApplicationMessage(
				{
					bootId: publication.authority.processEpoch,
					commandId: randomUUID(),
					connectionId: publication.authority.connectionId,
					controllerEpoch: publication.authority.controllerEpoch,
					createdAtMs: publication.observedAtMs,
					deliveryPolicy: 'critical_idempotent',
					domain: 'gateway_control',
					expiresAtMs: Math.min(
						publication.observedAtMs + 1_000,
						publicationOptions?.sourceCommandExpiresAtMs ?? Number.POSITIVE_INFINITY,
					),
					idempotencyKey: `publish:${publication.kind}:${publication.binding.leaseId}`,
					kind: 'command',
					messageId,
					operation: 'tool_vm_binding_publish',
					peerId: material.peerId,
					protocolVersion: 1,
					sequence: 1,
					sessionId: publication.authority.sessionId,
					zoneId: publication.authority.zoneId,
				},
				{ kind: 'command', operation: 'tool_vm_binding_publish' },
				message,
				{ commandResultTimeoutMs: 1_000 },
			);
			if (publication.kind === 'current' && publication.binding.leaseId === mainSuccessorLeaseId) {
				record(
					'successor-ssh-ready',
					publication.binding.leaseId,
					publication.binding.leafGeneration,
					publication.authority.attachmentGeneration,
					publication.binding.agentId,
				);
			}
			if (publication.kind === 'current') {
				record(
					'fresh-binding-published',
					publication.binding.leaseId,
					publication.binding.leafGeneration,
					publication.authority.attachmentGeneration,
				);
				if (publication.binding.leaseId === 'lease-causal-4') {
					record(
						'rejected-use-recovery-binding-published',
						publication.binding.leaseId,
						publication.binding.leafGeneration,
						publication.authority.attachmentGeneration,
					);
				}
				if (publication.binding.leaseId === (leaseIds[1] ?? '')) {
					record(
						'successor-fresh-binding-published',
						publication.binding.leaseId,
						publication.binding.leafGeneration,
						publication.authority.attachmentGeneration,
					);
				}
			}
		},
		readCurrentAuthority: () => currentAuthority,
	});
	const bindingPublication = {
		requestBinding: async (
			request: Parameters<typeof realPublicationCoordinator.requestBinding>[0],
		) => {
			try {
				return await realPublicationCoordinator.requestBinding(request);
			} catch (error: unknown) {
				if (error instanceof Error && /authority is stale|command expired/u.test(error.message)) {
					record(
						'stale-binding-publication-rejected',
						leaseIds[0] ?? '',
						leafGenerations[0] ?? '',
						request.authority.attachmentGeneration,
					);
					stalePublicationRejected.resolve();
				}
				throw error;
			}
		},
		retireBinding: realPublicationCoordinator.retireBinding,
	};
	const unsubscribeBindingRetirements = leaseRpc.subscribeBindingRetirement(async (event) => {
		const authority = currentAuthority;
		if (authority === undefined) {
			throw new Error('Gateway retirement publication has no current Controller authority.');
		}
		record(
			'gateway-binding-retirement-requested',
			event.leaseId,
			leafGenerations[leaseIds.indexOf(event.leaseId)] ?? '',
			authority.attachmentGeneration,
		);
		const result = await realPublicationCoordinator.retireBinding({
			authority,
			leaseId: event.leaseId,
			reason: event.reason,
		});
		if (result !== 'publication-applied') {
			throw new Error(`Gateway retirement was not applied to the current publication: ${result}.`);
		}
		record(
			'gateway-retirement-acknowledged',
			event.leaseId,
			leafGenerations[leaseIds.indexOf(event.leaseId)] ?? '',
			authority.attachmentGeneration,
		);
	});
	const callerContexts = createGatewayControlCallerContextRegistry({
		agentAuthorityKeys: material.agentAuthorityKeys,
		callerContextProofKey: material.callerContextProofKey,
		validateRegistration: () => undefined,
	});
	const sessionFenceRegistry = createControlSessionFenceRegistry();
	const dispatcher = createControlSessionDispatcher({
		semanticLedger: createGatewaySemanticResultLedger({ gateway, nowMs: now }),
		sessionFenceRegistry,
	});
	dispatcher.register(
		'gateway_control',
		createGatewayControlDomainHandler({
			bindingPublication,
			callerContexts,
			gateway,
			leaseRpc,
			now,
			session: {
				bootId: material.processEpoch,
				controllerEpoch: material.controllerEpoch,
				peerId: material.peerId,
				zoneId: material.zoneId,
			},
		}),
	);
	let observedDisconnect = false;
	let firstAcceptedSession: GatewayControlAcceptedSession | undefined;
	const rotatedConnectionObserved = deferred();
	const controllerAuthorityRotated = deferred();
	const sessionObservation = gatewayService.observeSessionState((session) => {
		if (session === undefined) {
			observedDisconnect = firstAcceptedSession !== undefined;
			return;
		}
		if (firstAcceptedSession === undefined) {
			firstAcceptedSession = session;
			return;
		}
		if (observedDisconnect) {
			record(
				'control-connection-rotated',
				leaseIds[0] ?? '',
				leafGenerations[0] ?? '',
				session.attachmentGeneration,
			);
			rotatedConnectionObserved.resolve();
		}
	}, refuseUnexpectedOperation);
	controllerClientState.current = await connectGatewayControlSession({
		dispatcher,
		endpoint: buildGatewayControlEndpoint(gatewayEndpoint.readiness),
		material,
		onHelloResponse: (response) => {
			currentAuthority =
				response.outcome === 'accepted'
					? {
							attachmentGeneration: response.attachmentGeneration,
							connectionId: response.connectionId,
							controllerEpoch: response.controllerEpoch,
							gatewayEpoch: material.generationId,
							processEpoch: material.processEpoch,
							sessionId: response.sessionId,
							zoneId: material.zoneId,
						}
					: undefined;
			if (response.outcome === 'accepted' && response.attachmentGeneration > 1) {
				controllerAuthorityRotated.resolve();
			}
		},
		resolveInboundStablePrincipal: ({ envelope, message }) =>
			resolveGatewayControlInboundStablePrincipal({ callerContexts, envelope, message }),
		sessionFenceRegistry,
	});
	const realCommandClient = createGatewayRuntimeControlCommandClient({
		controlService: gatewayService,
	});
	const deadlineCommandClient = createGatewayRuntimeControlCommandClient({
		controlService: {
			emitApplicationMessage: async (intent, emitOptions) =>
				await gatewayService.emitApplicationMessage(intent, {
					...emitOptions,
					...(intent.payload.operation === 'tool_vm_binding_request'
						? { commandResultTimeoutMs: options.commandResultTimeoutMs }
						: {}),
				}),
		},
	});
	const timeoutObservingCommandClient = {
		sendCommand: async (request) => {
			try {
				return await deadlineCommandClient.sendCommand(request);
			} catch (error: unknown) {
				if (
					request.message.operation === 'tool_vm_binding_request' &&
					error instanceof Error &&
					/command result timed out/u.test(error.message)
				) {
					record(
						'binding-result-timeout-observed',
						leaseIds[0] ?? '',
						leafGenerations[0] ?? '',
						currentAuthority?.attachmentGeneration ?? 0,
					);
				}
				throw error;
			}
		},
	} satisfies GatewayRuntimeControlCommandClient;
	let rejectNextReadyUseWithStaleGatewayBinding = false;
	const observingCommandClient = {
		sendCommand: async (request) => {
			if (
				rejectNextReadyUseWithStaleGatewayBinding &&
				request.message.operation === 'lease_use_start'
			) {
				rejectNextReadyUseWithStaleGatewayBinding = false;
				await leaseManager.releaseLease(request.message.payload.leaseId);
			}
			const response = await timeoutObservingCommandClient.sendCommand(request);
			if (
				request.message.operation === 'lease_reacquire' &&
				response.response.operation === 'lease_reacquire' &&
				response.response.payload.result === 'ok'
			) {
				const replacementLease = response.response.payload.lease;
				if (leaseManager.getCurrentLeaseBinding(replacementLease.leaseId) === undefined) {
					throw new Error('Successful lease reacquire did not commit the successor binding.');
				}
				record(
					'successor-commit-observed',
					replacementLease.leaseId,
					replacementLease.leafGeneration,
					response.acceptedSession.attachmentGeneration,
				);
				record(
					'lease-reacquire-succeeded',
					replacementLease.leaseId,
					replacementLease.leafGeneration,
					response.acceptedSession.attachmentGeneration,
				);
			}
			if (
				request.message.operation === 'lease_use_start' &&
				response.response.operation === 'lease_use_start' &&
				response.response.payload.result === 'rejected'
			) {
				const state = publishedBindingRuntime.readState({ trustedContext });
				record(
					'rejected-use-observed',
					state.kind === 'unbound' ? '' : state.generation.leaseId,
					state.kind === 'unbound' ? '' : state.generation.leafGeneration,
					response.acceptedSession.attachmentGeneration,
				);
			}
			if (
				request.message.operation === 'lease_use_start' &&
				response.response.operation === 'lease_use_start' &&
				response.response.payload.result === 'ok' &&
				response.response.payload.leaseUse.leaseId === mainSuccessorLeaseId
			) {
				record(
					'successor-use-succeeded',
					response.response.payload.leaseUse.leaseId,
					leafGenerations[leaseIds.indexOf(response.response.payload.leaseUse.leaseId)] ?? '',
					response.acceptedSession.attachmentGeneration,
				);
			}
			if (
				request.message.operation === 'lease_use_start' &&
				response.response.operation === 'lease_use_start' &&
				response.response.payload.result === 'ok' &&
				response.response.payload.leaseUse.leaseId === 'lease-causal-4'
			) {
				record(
					'rejected-use-recovery-succeeded',
					response.response.payload.leaseUse.leaseId,
					'leaf-causal-4',
					response.acceptedSession.attachmentGeneration,
				);
			}
			return response;
		},
	} satisfies GatewayRuntimeControlCommandClient;
	const callerContextRegistrationClient = createGatewayControlCallerContextRegistrationClient({
		agentAuthorityKeys: material.agentAuthorityKeys,
		callerContextProofKey: material.callerContextProofKey,
		controlCommandClient: realCommandClient,
		controlService: gatewayService,
	});
	let useIdIndex = 1;
	const activeUseRuntime = createGatewayControlOperationActiveUseRuntime({
		callerContextRegistrationClient,
		commandTtlMs: options.commandTtlMs,
		controlCommandClient: observingCommandClient,
		controlService: gatewayService,
		createCommandId: randomUUID,
		createProcessRegistry,
		createUseId: () => `0190a5f1-1234-7abc-8def-${String(useIdIndex++).padStart(12, '0')}`,
		now,
		publishedBindingRuntime,
		scheduler: { schedule: () => ({ cancel: () => undefined }) },
	});
	const connectionRotationCompleted = Promise.all([
		rotatedConnectionObserved.promise,
		controllerAuthorityRotated.promise,
	]).then(() => undefined);
	return {
		activeUseRuntime,
		armPredecessorExactAbsenceBarrier: () => {
			predecessorExactAbsenceBarrierArmed = true;
			predecessorIdleRetirementArmed = true;
		},
		connectionRotationCompleted,
		evidence,
		emitCurrentBindingTransportFailure: () => {
			const currentFixture = strictSshFixtures.at(-1);
			if (currentFixture === undefined) {
				throw new Error('No published Tool VM SSH binding is available to fail.');
			}
			currentFixture.emitTransportFailure({ kind: 'transport-error' });
		},
		firstLeaseCreationMayFinish,
		gatewayService,
		gatewaySshCloseStarted: gatewaySshCloseStarted.promise,
		idleReaper,
		leaseManager,
		predecessorDestructionObserved: predecessorDestructionObserved.promise,
		predecessorExactAbsenceMayFinish,
		publishedBindingRuntime,
		rejectNextReadyUseWithStaleGatewayBinding: () => {
			unsubscribeBindingRetirements();
			rejectNextReadyUseWithStaleGatewayBinding = true;
		},
		recordWaitingCallCompleted: (acquisition) => {
			record(
				'waiting-call-completed',
				acquisition.operationContext.leaseId,
				acquisition.operationContext.leafGeneration,
				currentAuthority?.attachmentGeneration ?? 0,
				trustedContext.principal.agentId,
			);
		},
		stalePublicationRejected,
		successorProvisionalBootObserved: successorProvisionalBootObserved.promise,
		close: async () => {
			firstLeaseCreationMayFinish.resolve();
			predecessorExactAbsenceMayFinish.resolve();
			predecessorManagedVmCloseMayFinish.resolve();
			unsubscribeBindingRetirements();
			sessionObservation.unsubscribe();
			await activeUseRuntime.retire().catch(() => undefined);
			await publishedBindingRuntime.close().catch(() => undefined);
			controllerClientState.current?.close();
			await gatewayEndpoint.close().catch(() => undefined);
		},
	};
}

export function requireBound(
	result: Awaited<ReturnType<CausalFixture['activeUseRuntime']['acquisitionPort']['acquire']>>,
): GatewayControlOperationActiveUseAcquisition {
	if (result.kind !== 'bound') {
		throw new Error(`Expected a bound Tool VM acquisition, received ${JSON.stringify(result)}.`);
	}
	return result;
}
