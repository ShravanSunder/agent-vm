import { createHmac } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextProofPayloadInput,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlRpcMessage,
	type GatewayControlRpcOperation,
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it, vi } from 'vitest';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import { createLeaseManager } from '../leases/lease-manager.js';
import { createTcpPool } from '../leases/tcp-pool.js';
import type {
	GatewayOwnershipCoordinator,
	ToolVmMembershipHandle,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import { createControlSessionDispatcher } from './control-session-dispatcher.js';
import {
	createGatewayControlCallerContextRegistry,
	type GatewayControlCallerContextSessionRef,
} from './gateway-control-caller-context.js';
import { createGatewayControlDomainHandler } from './gateway-control-domain-handler.js';
import { createGatewayControlLeaseRpcOperations } from './gateway-control-lease-rpc.js';
import { createGatewaySemanticResultLedger } from './gateway-semantic-result-ledger.js';

const acceptedSession = {
	bootId: 'gateway-boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
} satisfies GatewayControlCallerContextSessionRef;

const callerContextProofKey = 'test-caller-context-proof-key-with-enough-length';
const testHostGitDirectoryRoot = '/host/runtime/zones/zone-a/gitdirs/agents/main';
const agentAuthorityKeys: Readonly<Record<string, string>> = {
	main: 'test-main-agent-authority-key-with-enough-length',
};
const invocationPrincipal = {
	agentId: 'main',
	frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
	profileAssignmentRevision: 'assignment-main',
	toolPortalProfileId: 'standard',
} as const;

const TEST_GATEWAY_EPOCH = {
	bootId: acceptedSession.bootId,
	controllerEpoch: acceptedSession.controllerEpoch,
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayEpochIdentity;

function refuseUnexpectedGatewayOwnershipOperation(): never {
	throw new Error('unexpected Gateway ownership operation in lease RPC integration test');
}

function createOwnershipCoordinatorStub(): GatewayOwnershipCoordinator {
	return {
		beginGatewayEpoch: () => refuseUnexpectedGatewayOwnershipOperation(),
		abandonUnattachedGatewaySeed: () => refuseUnexpectedGatewayOwnershipOperation(),
		admitProvisionalToolVm: (options) => {
			if (!gatewayIdentitiesEqual(TEST_GATEWAY_EPOCH, options.expectedGateway)) {
				throw new Error('Tool VM admission refused a stale Gateway VM epoch.');
			}
			let state: ReturnType<ToolVmMembershipHandle['snapshot']>['state'] = 'provisional';
			let toolVmId: string | undefined;
			return {
				agentId: options.agentId,
				leafId: options.leafId,
				attachToolVm(attachedToolVmId): void {
					toolVmId = attachedToolVmId;
				},
				beginDestroying(): void {
					state = 'destroying';
				},
				commitCurrent(): void {
					state = 'current';
				},
				recordAccessFenced(): void {
					state = 'retiring';
				},
				recordDestroyed(): void {
					state = 'destroyed';
				},
				recordUnavailable(): void {
					state = 'owner-unsafe';
				},
				snapshot: () => ({
					agentId: options.agentId,
					leafId: options.leafId,
					state,
					...(toolVmId === undefined ? {} : { toolVmId }),
				}),
			};
		},
		recordGatewayDestroyUnavailable: () => refuseUnexpectedGatewayOwnershipOperation(),
		resolveGatewayEpoch: () => TEST_GATEWAY_EPOCH,
		retireGateway: async () => refuseUnexpectedGatewayOwnershipOperation(),
		sealGatewayEpoch: () => refuseUnexpectedGatewayOwnershipOperation(),
		snapshotGateway: () => refuseUnexpectedGatewayOwnershipOperation(),
	};
}

function signCallerContextEvidence(
	evidence: GatewayControlCallerContextProofPayloadInput,
): GatewayControlCallerContextRegisterPayload['adapterEvidence'] {
	return {
		...evidence,
		agentAuthority: {
			algorithm: 'hmac-sha256',
			digest: createHmac('sha256', agentAuthorityKeys[evidence.principal.agentId] ?? 'missing')
				.update(buildGatewayControlCallerContextAgentAuthorityPayload(evidence), 'utf8')
				.digest('base64url'),
			keyId: evidence.principal.agentId,
		},
		proof: {
			algorithm: 'hmac-sha256',
			digest: createHmac('sha256', callerContextProofKey)
				.update(buildGatewayControlCallerContextProofPayload(evidence), 'utf8')
				.digest('base64url'),
		},
	};
}

const callerContextRegisterPayload = {
	adapterEvidence: signCallerContextEvidence({
		principal: invocationPrincipal,
		zoneId: 'zone-a',
	}),
} satisfies GatewayControlCallerContextRegisterPayload;

const validateCallerContextRegistration = (): void => {};

function createEnvelope(
	operation: GatewayControlRpcOperation,
	sequence: number,
	session: GatewayControlCallerContextSessionRef = acceptedSession,
): ControlEnvelope {
	return {
		bootId: session.bootId,
		commandId: `55555555-5555-4555-8555-${String(sequence).padStart(12, '0')}`,
		connectionId: session.connectionId,
		controllerEpoch: session.controllerEpoch,
		createdAtMs: sequence,
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation[operation],
		domain: 'gateway_control',
		expiresAtMs: 60_000 + sequence,
		idempotencyKey: `${operation}:${String(sequence)}`,
		kind: 'command',
		messageId: `66666666-6666-4666-8666-${String(sequence).padStart(12, '0')}`,
		operation,
		peerId: session.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence,
		sessionId: session.sessionId,
		zoneId: session.zoneId,
	};
}

type GatewayControlCommandResultMessage = Extract<
	GatewayControlRpcMessage,
	{ readonly kind: 'command_result' }
>;

function createManagedVmStub(): Parameters<typeof createLeaseManager>[0]['createManagedVm'] {
	return vi.fn(async () => {
		let hostPidReadCount = 0;
		const vm = {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({
				close: vi.fn(async () => {}),
				host: '127.0.0.1',
				port: 18791,
			})),
			enableSsh: vi.fn(async () => ({
				close: vi.fn(async () => {}),
				command: 'ssh sandbox@127.0.0.1',
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				host: '127.0.0.1',
				identityFile: '/tmp/tool-vm-key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			getHostProcessId: () => {
				hostPidReadCount += 1;
				return hostPidReadCount === 1 ? 12345 : null;
			},
			id: 'tool-vm-1',
			configureIngressRoutes: vi.fn(),
			start: vi.fn(async () => {}),
		};
		return vm;
	});
}

function createTestLeaseManager(): ReturnType<typeof createLeaseManager> {
	const leaseIds = ['lease-old', 'lease-new'] as const;
	let leaseIdIndex = 0;
	return createLeaseManager({
		controllerPort: 18800,
		managedVmExactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => ({
				hostProcessId: identity.hostProcessId,
				kind: 'already-absent',
			}),
		},
		managedVmTerminationSleep: async () => {},
		createLeaseId: () => {
			const leaseId = leaseIds[leaseIdIndex];
			if (leaseId === undefined) {
				throw new Error('test lease id exhausted');
			}
			leaseIdIndex += 1;
			return leaseId;
		},
		createManagedVm: createManagedVmStub(),
		deleteToolVmRuntimeRecord: vi.fn(async () => {}),
		now: () => 1_000,
		ownershipCoordinator: createOwnershipCoordinatorStub(),
		projectNamespace: 'gateway-control-lease-rpc-integration-tests',
		readProcessIdentity: async () => ({
			command: 'qemu-system-x86_64 -m 1G',
			lstart: 'Fri May 22 10:00:00 2026',
		}),
		readTcpListenPortOwner: async () => null,
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		toolLeaseRecordsTargetFor: (zoneId) =>
			({
				directoryPath: `/tmp/gateway-control-lease-rpc-integration-tests/${zoneId}/tool-leases`,
				kind: 'controller-tool-lease-records',
				zoneId,
			}) satisfies ControllerToolLeaseRecordsTarget,
		toolVmUsePolicy: {
			endedUseTombstoneTtlMs: 10_000,
			heartbeatAfterMs: 1_000,
			heartbeatStaleMs: 4_000,
		},
		writeToolVmRuntimeRecord: vi.fn(async () => {}),
	});
}

function createIntegrationLeaseRpcOptions(
	options: {
		readonly leaseManager?: ReturnType<typeof createLeaseManager>;
		readonly recordedHealthEvents?: AgentVmHealthEvent[];
	} = {},
): Parameters<typeof createGatewayControlLeaseRpcOperations>[0] {
	return {
		leaseManager: options.leaseManager ?? createTestLeaseManager(),
		readIdentityPem: async () => 'identity-pem',
		recordHealthEvent: (event: AgentVmHealthEvent) => {
			options.recordedHealthEvents?.push(event);
		},
		resolveLeaseCreateOptions: async ({ callerContext, gateway }) => ({
			agentId: callerContext.agentId,
			expectedGateway: gateway,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}),
	};
}

function createIntegrationDispatcher(options: {
	readonly callerContextIds: readonly string[];
	readonly leaseRpcOptions: Parameters<typeof createGatewayControlLeaseRpcOperations>[0];
}): ReturnType<typeof createControlSessionDispatcher> {
	let callerContextIdIndex = 0;
	const callerContexts = createGatewayControlCallerContextRegistry({
		agentAuthorityKeys,
		callerContextProofKey,
		validateRegistration: validateCallerContextRegistration,
		createCallerContextId: () => {
			const callerContextId = options.callerContextIds[callerContextIdIndex];
			if (callerContextId === undefined) {
				throw new Error('test caller context id exhausted');
			}
			callerContextIdIndex += 1;
			return callerContextId;
		},
	});
	const leaseRpc = createGatewayControlLeaseRpcOperations(options.leaseRpcOptions);
	return createIntegrationDispatcherForSession({
		callerContexts,
		leaseRpc,
		session: acceptedSession,
	});
}

function createIntegrationDispatcherForSession(options: {
	readonly callerContexts: ReturnType<typeof createGatewayControlCallerContextRegistry>;
	readonly leaseRpc: ReturnType<typeof createGatewayControlLeaseRpcOperations>;
	readonly session: GatewayControlCallerContextSessionRef;
}): ReturnType<typeof createControlSessionDispatcher> {
	const dispatcher = createControlSessionDispatcher({
		semanticLedger: createGatewaySemanticResultLedger({
			gateway: TEST_GATEWAY_EPOCH,
			nowMs: () => 1_000,
		}),
	});
	dispatcher.register(
		'gateway_control',
		createGatewayControlDomainHandler({
			callerContexts: options.callerContexts,
			gateway: TEST_GATEWAY_EPOCH,
			leaseRpc: options.leaseRpc,
			now: () => 1_000,
			session: options.session,
		}),
	);
	return dispatcher;
}

async function registerCallerContext(options: {
	readonly dispatcher: ReturnType<typeof createControlSessionDispatcher>;
	readonly payload?: GatewayControlCallerContextRegisterPayload;
	readonly sequence: number;
	readonly session?: GatewayControlCallerContextSessionRef;
}): Promise<string> {
	const response = await dispatchGatewayControl(
		options.dispatcher,
		'caller_context_register',
		options.sequence,
		{
			kind: 'command',
			operation: 'caller_context_register',
			payload: options.payload ?? callerContextRegisterPayload,
		},
		options.session,
	);
	const callerContextId = response?.payload.callerContext?.callerContextId;
	if (callerContextId === undefined) {
		throw new Error('expected caller context id');
	}
	return callerContextId;
}

async function dispatchGatewayControl(
	dispatcher: ReturnType<typeof createControlSessionDispatcher>,
	operation: GatewayControlRpcOperation,
	sequence: number,
	message: GatewayControlRpcMessage,
	session: GatewayControlCallerContextSessionRef = acceptedSession,
): Promise<GatewayControlCommandResultMessage> {
	return GatewayControlRpcCommandResultMessageSchema.parse(
		await dispatcher.dispatch({
			attachmentGeneration: 1,
			envelope: createEnvelope(operation, sequence, session),
			payload: message,
		}),
	);
}

describe('gateway control lease RPC integration', () => {
	it('admits concurrent active uses for one current Tool VM lease', async () => {
		const dispatcher = createIntegrationDispatcher({
			callerContextIds: ['44444444-4444-4444-8444-444444444444'],
			leaseRpcOptions: createIntegrationLeaseRpcOptions(),
		});
		const callerContextId = await registerCallerContext({ dispatcher, sequence: 1 });
		const createResponse = await dispatchGatewayControl(dispatcher, 'lease_create', 2, {
			kind: 'command',
			operation: 'lease_create',
			payload: { callerContext: { callerContextId } },
		});
		const leaseId = createResponse.payload.lease?.leaseId;
		if (leaseId === undefined) {
			throw new Error('expected created lease id');
		}

		const firstUseId = '01890f00-0000-7000-8000-000000000001';
		const secondUseId = '01890f00-0000-7000-8000-000000000002';
		const firstResponse = await dispatchGatewayControl(dispatcher, 'lease_use_start', 3, {
			kind: 'command',
			operation: 'lease_use_start',
			payload: {
				callerContext: { callerContextId },
				leaseId,
				useId: firstUseId,
			},
		});
		const secondResponse = await dispatchGatewayControl(dispatcher, 'lease_use_start', 4, {
			kind: 'command',
			operation: 'lease_use_start',
			payload: {
				callerContext: { callerContextId },
				leaseId,
				useId: secondUseId,
			},
		});

		expect(firstResponse).toMatchObject({
			operation: 'lease_use_start',
			payload: {
				leaseUse: { state: 'active', useId: firstUseId },
				result: 'ok',
			},
		});
		expect(secondResponse).toMatchObject({
			operation: 'lease_use_start',
			payload: {
				leaseUse: { state: 'active', useId: secondUseId },
				result: 'ok',
			},
		});

		const getResponse = await dispatchGatewayControl(dispatcher, 'lease_get', 5, {
			kind: 'command',
			operation: 'lease_get',
			payload: {
				callerContext: { callerContextId },
				leaseId,
			},
		});
		const renewResponse = await dispatchGatewayControl(dispatcher, 'lease_renew', 6, {
			kind: 'command',
			operation: 'lease_renew',
			payload: {
				callerContext: { callerContextId },
				leaseId,
			},
		});

		for (const response of [getResponse, renewResponse]) {
			expect(response.payload).toMatchObject({
				lease: { leaseId, state: 'active' },
				result: 'ok',
			});
			expect(response.payload.lease).not.toHaveProperty('activeUseId');
			expect(response.payload.lease).not.toHaveProperty('expiresAtMs');
		}
	});

	it('reacquires a replacement lease through the real domain-handler seam', async () => {
		let callerContextIdIndex = 0;
		const callerContextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
		] as const;
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys,
			callerContextProofKey,
			validateRegistration: validateCallerContextRegistration,
			createCallerContextId: () => {
				const callerContextId = callerContextIds[callerContextIdIndex];
				if (callerContextId === undefined) {
					throw new Error('test caller context id exhausted');
				}
				callerContextIdIndex += 1;
				return callerContextId;
			},
		});
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const leaseRpcOptions = {
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event: AgentVmHealthEvent) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions: async ({ callerContext, gateway }) => ({
				agentId: callerContext.agentId,
				expectedGateway: gateway,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		} satisfies Parameters<typeof createGatewayControlLeaseRpcOperations>[0];
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			...leaseRpcOptions,
		});
		const dispatcher = createControlSessionDispatcher({
			semanticLedger: createGatewaySemanticResultLedger({
				gateway: TEST_GATEWAY_EPOCH,
				nowMs: () => 1_000,
			}),
		});
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				gateway: TEST_GATEWAY_EPOCH,
				leaseRpc,
				now: () => 1_000,
				session: acceptedSession,
			}),
		);

		const firstRegisterResponse = await dispatchGatewayControl(
			dispatcher,
			'caller_context_register',
			1,
			{
				kind: 'command',
				operation: 'caller_context_register',
				payload: callerContextRegisterPayload,
			},
		);
		const firstCallerContextId = firstRegisterResponse?.payload.callerContext?.callerContextId;
		if (firstCallerContextId === undefined) {
			throw new Error('expected first caller context id');
		}
		const createResponse = await dispatchGatewayControl(dispatcher, 'lease_create', 2, {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: { callerContextId: firstCallerContextId },
			},
		});
		const oldLeaseId = createResponse?.payload.lease?.leaseId;
		if (oldLeaseId === undefined) {
			throw new Error('expected old lease id');
		}
		const secondRegisterResponse = await dispatchGatewayControl(
			dispatcher,
			'caller_context_register',
			4,
			{
				kind: 'command',
				operation: 'caller_context_register',
				payload: callerContextRegisterPayload,
			},
		);
		const secondCallerContextId = secondRegisterResponse?.payload.callerContext?.callerContextId;
		if (secondCallerContextId === undefined) {
			throw new Error('expected second caller context id');
		}

		const reacquireResponse = await dispatchGatewayControl(dispatcher, 'lease_reacquire', 5, {
			kind: 'command',
			operation: 'lease_reacquire',
			payload: {
				callerContext: { callerContextId: secondCallerContextId },
				oldLeaseId,
				staleEvidence: {
					kind: 'lease-manager',
					observedAtMs: 1_100,
					reason: 'released',
				},
			},
		});

		expect(reacquireResponse).toEqual({
			kind: 'command_result',
			operation: 'lease_reacquire',
			payload: {
				lease: expect.objectContaining({
					leaseId: 'lease-new',
					state: 'idle',
				}),
				responseToMessageId: '66666666-6666-4666-8666-000000000005',
				result: 'ok',
			},
		});
		expect(reacquireResponse?.payload.lease?.leaseId).not.toBe(oldLeaseId);
		expect(recordedHealthEvents).toEqual([
			expect.objectContaining({
				agentId: 'main',
				kind: 'tool-vm-ssh',
				leaseId: 'lease-new',
				lifecycleEventRole: 'controller_final',
				lifecycleTransition: 'stale_to_reacquired',
				oldLeaseId,
				replacementLeaseId: 'lease-new',
				result: 'ok',
				transitionId: `lease_reacquire:${oldLeaseId}`,
				zoneId: acceptedSession.zoneId,
			}),
		]);
	});

	it('returns lease_authority_absent through the domain-handler seam when old authority is gone', async () => {
		const dispatcher = createIntegrationDispatcher({
			callerContextIds: ['44444444-4444-4444-8444-444444444444'],
			leaseRpcOptions: createIntegrationLeaseRpcOptions(),
		});
		const callerContextId = await registerCallerContext({ dispatcher, sequence: 1 });

		const reacquireResponse = await dispatchGatewayControl(dispatcher, 'lease_reacquire', 2, {
			kind: 'command',
			operation: 'lease_reacquire',
			payload: {
				callerContext: { callerContextId },
				oldLeaseId: 'lease-missing',
				staleEvidence: {
					kind: 'caller-context',
					observedAtMs: 1_100,
					reason: 'lease_authority_absent',
				},
			},
		});

		expect(reacquireResponse).toEqual({
			kind: 'command_result',
			operation: 'lease_reacquire',
			payload: {
				leaseRejectionReason: 'lease_authority_absent',
				responseToMessageId: '66666666-6666-4666-8666-000000000002',
				result: 'rejected',
			},
		});
	});

	it('rejects current work and reacquire through the domain-handler seam after Gateway epoch drift', async () => {
		const replacementSession = {
			...acceptedSession,
			bootId: 'gateway-boot-b',
			connectionId: '22222222-2222-4222-8222-222222222222',
			controllerEpoch: 'epoch-b',
			peerId: 'gateway-zone-b',
			sessionId: '77777777-7777-4777-8777-777777777777',
		} satisfies GatewayControlCallerContextSessionRef;
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys,
			callerContextProofKey,
			validateRegistration: validateCallerContextRegistration,
			createCallerContextId: (() => {
				const callerContextIds = [
					'44444444-4444-4444-8444-444444444444',
					'99999999-9999-4999-8999-999999999999',
				] as const;
				let callerContextIdIndex = 0;
				return () => {
					const callerContextId = callerContextIds[callerContextIdIndex];
					if (callerContextId === undefined) {
						throw new Error('test caller context id exhausted');
					}
					callerContextIdIndex += 1;
					return callerContextId;
				};
			})(),
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations(createIntegrationLeaseRpcOptions());
		const oldSessionDispatcher = createControlSessionDispatcher({
			semanticLedger: createGatewaySemanticResultLedger({
				gateway: TEST_GATEWAY_EPOCH,
				nowMs: () => 1_000,
			}),
		});
		oldSessionDispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				gateway: TEST_GATEWAY_EPOCH,
				leaseRpc,
				now: () => 1_000,
				session: acceptedSession,
			}),
		);
		const replacementGateway = {
			...TEST_GATEWAY_EPOCH,
			bootId: replacementSession.bootId,
			controllerEpoch: replacementSession.controllerEpoch,
			gatewayEpochId: 'gateway-epoch-b',
			gatewayVmId: 'gateway-vm-b',
			generationId: 'gateway-generation-b',
		} satisfies GatewayEpochIdentity;
		const replacementSessionDispatcher = createControlSessionDispatcher({
			semanticLedger: createGatewaySemanticResultLedger({
				gateway: replacementGateway,
				nowMs: () => 1_000,
			}),
		});
		replacementSessionDispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				gateway: replacementGateway,
				leaseRpc,
				now: () => 1_000,
				session: replacementSession,
			}),
		);
		const oldCallerContextId = await registerCallerContext({
			dispatcher: oldSessionDispatcher,
			sequence: 1,
		});
		const createResponse = await dispatchGatewayControl(oldSessionDispatcher, 'lease_create', 2, {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: { callerContextId: oldCallerContextId },
			},
		});
		const oldLeaseId = createResponse?.payload.lease?.leaseId;
		if (oldLeaseId === undefined) {
			throw new Error('expected old lease id');
		}
		const replacementCallerContextId = await registerCallerContext({
			dispatcher: replacementSessionDispatcher,
			sequence: 3,
			session: replacementSession,
		});

		const renewResponse = await dispatchGatewayControl(
			replacementSessionDispatcher,
			'lease_renew',
			4,
			{
				kind: 'command',
				operation: 'lease_renew',
				payload: {
					callerContext: { callerContextId: replacementCallerContextId },
					leaseId: oldLeaseId,
				},
			},
			replacementSession,
		);
		const startUseResponse = await dispatchGatewayControl(
			replacementSessionDispatcher,
			'lease_use_start',
			5,
			{
				kind: 'command',
				operation: 'lease_use_start',
				payload: {
					callerContext: { callerContextId: replacementCallerContextId },
					leaseId: oldLeaseId,
					useId: '01890f00-0000-7000-8000-000000000001',
				},
			},
			replacementSession,
		);
		const reacquireResponse = await dispatchGatewayControl(
			replacementSessionDispatcher,
			'lease_reacquire',
			7,
			{
				kind: 'command',
				operation: 'lease_reacquire',
				payload: {
					callerContext: { callerContextId: replacementCallerContextId },
					oldLeaseId,
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'session_mismatch',
					},
				},
			},
			replacementSession,
		);

		expect(renewResponse).toEqual({
			kind: 'command_result',
			operation: 'lease_renew',
			payload: {
				leaseRejectionReason: 'ownership_denied',
				responseToMessageId: '66666666-6666-4666-8666-000000000004',
				result: 'rejected',
			},
		});
		expect(startUseResponse).toEqual({
			kind: 'command_result',
			operation: 'lease_use_start',
			payload: {
				leaseRejectionReason: 'ownership_denied',
				responseToMessageId: '66666666-6666-4666-8666-000000000005',
				result: 'rejected',
			},
		});
		expect(reacquireResponse).toEqual({
			kind: 'command_result',
			operation: 'lease_reacquire',
			payload: {
				leaseRejectionReason: 'ownership_denied',
				responseToMessageId: '66666666-6666-4666-8666-000000000007',
				result: 'rejected',
			},
		});
	});

	it('denies replayed old-lease reacquire after replacement ownership moves to another same-agent caller context', async () => {
		const callerContextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		] as const;
		let callerContextIdIndex = 0;
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys,
			callerContextProofKey,
			validateRegistration: validateCallerContextRegistration,
			createCallerContextId: () => {
				const callerContextId = callerContextIds[callerContextIdIndex];
				if (callerContextId === undefined) {
					throw new Error('test caller context id exhausted');
				}
				callerContextIdIndex += 1;
				return callerContextId;
			},
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations(createIntegrationLeaseRpcOptions());
		const dispatcher = createIntegrationDispatcherForSession({
			callerContexts,
			leaseRpc,
			session: acceptedSession,
		});
		const firstCallerContextId = await registerCallerContext({ dispatcher, sequence: 1 });
		const createResponse = await dispatchGatewayControl(dispatcher, 'lease_create', 2, {
			kind: 'command',
			operation: 'lease_create',
			payload: {
				callerContext: { callerContextId: firstCallerContextId },
			},
		});
		const oldLeaseId = createResponse?.payload.lease?.leaseId;
		if (oldLeaseId === undefined) {
			throw new Error('expected old lease id');
		}
		const refreshedCallerContextId = await registerCallerContext({ dispatcher, sequence: 4 });
		const firstReacquireResponse = await dispatchGatewayControl(dispatcher, 'lease_reacquire', 5, {
			kind: 'command',
			operation: 'lease_reacquire',
			payload: {
				callerContext: { callerContextId: refreshedCallerContextId },
				oldLeaseId,
				staleEvidence: {
					kind: 'lease-manager',
					observedAtMs: 1_100,
					reason: 'released',
				},
			},
		});
		expect(firstReacquireResponse?.payload.lease?.leaseId).toBe('lease-new');

		const secondSession = {
			...acceptedSession,
			connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
		} satisfies GatewayControlCallerContextSessionRef;
		const secondSessionDispatcher = createIntegrationDispatcherForSession({
			callerContexts,
			leaseRpc,
			session: secondSession,
		});
		const sameAgentDifferentSessionCallerContextId = await registerCallerContext({
			dispatcher: secondSessionDispatcher,
			sequence: 6,
			session: secondSession,
		});
		const sameAgentCreateResponse = await dispatchGatewayControl(
			secondSessionDispatcher,
			'lease_create',
			7,
			{
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: { callerContextId: sameAgentDifferentSessionCallerContextId },
				},
			},
			secondSession,
		);
		expect(sameAgentCreateResponse?.payload.lease?.leaseId).toBe('lease-new');

		const replayedReacquireResponse = await dispatchGatewayControl(
			dispatcher,
			'lease_reacquire',
			8,
			{
				kind: 'command',
				operation: 'lease_reacquire',
				payload: {
					callerContext: { callerContextId: refreshedCallerContextId },
					oldLeaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_200,
						reason: 'released',
					},
				},
			},
		);

		expect(replayedReacquireResponse).toEqual({
			kind: 'command_result',
			operation: 'lease_reacquire',
			payload: {
				leaseRejectionReason: 'caller_context_stale',
				responseToMessageId: '66666666-6666-4666-8666-000000000008',
				result: 'rejected',
			},
		});
	});
});
