import { createHmac } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlRpcMessage,
	type GatewayControlRpcOperation,
	GatewayControlRpcCommandResultMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import {
	mapHealthEventToTelemetry,
	stableTelemetryHash,
} from '../../observability/health-event-telemetry.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
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
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
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
};

const TEST_GATEWAY_EPOCH = {
	bootId: acceptedSession.bootId,
	controllerEpoch: acceptedSession.controllerEpoch,
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayEpochIdentity;

function refuseUnexpectedGatewayOwnershipOperation(): never {
	throw new Error('unexpected Gateway ownership operation in lifecycle event integration test');
}

function createOwnershipCoordinatorStub(): GatewayOwnershipCoordinator {
	return {
		beginGatewayEpoch: () => refuseUnexpectedGatewayOwnershipOperation(),
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

const callerContextProofKey = 'test-caller-context-proof-key-with-enough-length';
const agentAuthorityKeys: Readonly<Record<string, string>> = {
	main: 'test-main-agent-authority-key-with-enough-length',
};

function signCallerContextEvidence(
	evidence: Omit<
		GatewayControlCallerContextRegisterPayload['adapterEvidence'],
		'agentAuthority' | 'proof'
	>,
): GatewayControlCallerContextRegisterPayload['adapterEvidence'] {
	return {
		...evidence,
		agentAuthority: {
			algorithm: 'hmac-sha256',
			digest: createHmac('sha256', agentAuthorityKeys[evidence.agentId] ?? 'missing')
				.update(buildGatewayControlCallerContextAgentAuthorityPayload(evidence), 'utf8')
				.digest('base64url'),
			keyId: evidence.agentId,
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
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/workspace',
		sessionKey: 'agent:main:test-session',
		workMountDir: '/host/sandbox-work',
		zoneId: acceptedSession.zoneId,
	}),
} satisfies GatewayControlCallerContextRegisterPayload;

function createEnvelope(operation: GatewayControlRpcOperation, sequence: number): ControlEnvelope {
	return {
		bootId: acceptedSession.bootId,
		commandId: `55555555-5555-4555-8555-${String(sequence).padStart(12, '0')}`,
		connectionId: acceptedSession.connectionId,
		controllerEpoch: acceptedSession.controllerEpoch,
		createdAtMs: sequence,
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation[operation],
		domain: 'gateway_control',
		expiresAtMs: 60_000 + sequence,
		idempotencyKey: `${operation}:${String(sequence)}`,
		kind: operation === 'health_event' ? 'event' : 'command',
		messageId: `66666666-6666-4666-8666-${String(sequence).padStart(12, '0')}`,
		operation,
		peerId: acceptedSession.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence,
		sessionId: acceptedSession.sessionId,
		zoneId: acceptedSession.zoneId,
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
			fs: createManagedVmFsStub(),
			getHostPid: () => {
				hostPidReadCount += 1;
				return hostPidReadCount === 1 ? 12345 : null;
			},
			getVmInstance: () => vm,
			id: 'tool-vm-1',
			setIngressRoutes: vi.fn(),
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
		managedVmKillDependencies: {
			isProcessAlive: () => false,
			killProcess: vi.fn(),
			readProcessCommand: async () => null,
			readProcessIdentity: async () => null,
			sleep: async () => {},
		},
		now: () => 1_000,
		ownershipCoordinator: createOwnershipCoordinatorStub(),
		projectNamespace: 'gateway-control-lifecycle-events-integration-tests',
		readProcessIdentity: async () => ({
			command: 'qemu-system-x86_64 -m 1G',
			lstart: 'Fri May 22 10:00:00 2026',
		}),
		readTcpListenPortOwner: async () => null,
		stateDirFor: (zoneId) => `/tmp/gateway-control-lifecycle-events-integration-tests/${zoneId}`,
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		toolVmUsePolicy: {
			endedUseTombstoneTtlMs: 10_000,
			heartbeatAfterMs: 1_000,
			heartbeatStaleMs: 4_000,
		},
		writeToolVmRuntimeRecord: vi.fn(async () => {}),
	});
}

async function dispatchGatewayControl(
	dispatcher: ReturnType<typeof createControlSessionDispatcher>,
	operation: GatewayControlRpcOperation,
	sequence: number,
	message: GatewayControlRpcMessage,
): Promise<GatewayControlCommandResultMessage | undefined> {
	const response = await dispatcher.dispatch({
		attachmentGeneration: 1,
		envelope: createEnvelope(operation, sequence),
		payload: message,
	});
	if (response === undefined) {
		return undefined;
	}
	return GatewayControlRpcCommandResultMessageSchema.parse(response);
}

describe('gateway control lifecycle event integration', () => {
	it('preserves plugin observations, controller final decisions, and safe telemetry projection', async () => {
		let callerContextIdIndex = 0;
		const callerContextIds = [
			'44444444-4444-4444-8444-444444444444',
			'99999999-9999-4999-8999-999999999999',
		] as const;
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys,
			callerContextProofKey,
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
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event: AgentVmHealthEvent) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions: async ({ callerContext, gateway }) => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
				expectedGateway: gateway,
				gatewayWorkMountDir: callerContext.workMountDir,
				guestWorkdir: '/workspace',
				hostWorkMountDir: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
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
				recordHealthEvent: (event: AgentVmHealthEvent) => {
					recordedHealthEvents.push(event);
				},
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
		await dispatchGatewayControl(dispatcher, 'health_event', 4, {
			kind: 'event',
			operation: 'health_event',
			payload: {
				activeUseId: 'active-use-secret-canary',
				agentId: 'main',
				callerContextState: 'stale',
				correlation: {
					correlationId: 'correlation-main',
					requestId: 'request-main',
					runId: 'run-main',
					sessionKeyDigest: 'a'.repeat(64),
					toolCallId: 'tool-call-main',
					traceId: '0123456789abcdef0123456789abcdef',
				},
				elapsedMs: 25,
				errorCode: 'ssh-command-failed',
				eventKind: 'tool-vm-ssh',
				leaseId: oldLeaseId,
				leaseRejectionReason: 'caller_context_stale',
				lifecycleEventRole: 'plugin_observation',
				lifecycleTransition: 'current_to_stale',
				observedAtMs: 1_100,
				oldLeaseId,
				operation: 'command',
				result: 'failed',
				transitionId: `plugin:${oldLeaseId}`,
			},
		});

		const secondRegisterResponse = await dispatchGatewayControl(
			dispatcher,
			'caller_context_register',
			5,
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
		const reacquireResponse = await dispatchGatewayControl(dispatcher, 'lease_reacquire', 6, {
			kind: 'command',
			operation: 'lease_reacquire',
			payload: {
				callerContext: { callerContextId: secondCallerContextId },
				oldLeaseId,
				staleEvidence: {
					errorCode: 'ssh-command-failed',
					kind: 'tool-vm-ssh',
					observedAtMs: 1_100,
					operation: 'command',
				},
			},
		});
		const replacementLeaseId = reacquireResponse?.payload.lease?.leaseId;
		if (replacementLeaseId === undefined) {
			throw new Error('expected replacement lease id');
		}

		expect(replacementLeaseId).toBe('lease-new');
		expect(replacementLeaseId).not.toBe(oldLeaseId);
		expect(recordedHealthEvents).toEqual([
			expect.objectContaining({
				correlationId: 'correlation-main',
				kind: 'tool-vm-ssh',
				leaseId: oldLeaseId,
				lifecycleEventRole: 'plugin_observation',
				lifecycleTransition: 'current_to_stale',
				oldLeaseId,
				operation: 'command',
				result: 'failed',
				traceId: '0123456789abcdef0123456789abcdef',
			}),
			expect.objectContaining({
				kind: 'tool-vm-ssh',
				leaseId: replacementLeaseId,
				lifecycleEventRole: 'controller_final',
				lifecycleTransition: 'stale_to_reacquired',
				oldLeaseId,
				operation: 'command',
				replacementLeaseId,
				result: 'ok',
				transitionId: `lease_reacquire:${oldLeaseId}`,
			}),
		]);

		const pluginObservationEvent = recordedHealthEvents[0];
		const controllerFinalEvent = recordedHealthEvents[1];
		if (pluginObservationEvent === undefined || controllerFinalEvent === undefined) {
			throw new Error('expected plugin observation and controller final health events');
		}
		const pluginObservationTelemetry = mapHealthEventToTelemetry(pluginObservationEvent);
		const controllerFinalTelemetry = mapHealthEventToTelemetry(controllerFinalEvent);
		expect(pluginObservationTelemetry.log.attributes).toMatchObject({
			'agent_vm.correlation.id': 'correlation-main',
			'agent_vm.lease.lifecycle_event_role': 'plugin_observation',
			'agent_vm.lease.lifecycle_transition': 'current_to_stale',
			'agent_vm.trace.id': '0123456789abcdef0123456789abcdef',
		});
		expect(controllerFinalTelemetry.log.attributes).toMatchObject({
			'agent_vm.lease.lifecycle_event_role': 'controller_final',
			'agent_vm.lease.lifecycle_transition': 'stale_to_reacquired',
			'agent_vm.lease.old_id_hash': stableTelemetryHash(oldLeaseId),
			'agent_vm.lease.replacement_id_hash': stableTelemetryHash(replacementLeaseId),
			'agent_vm.lease.transition_id_hash': stableTelemetryHash(`lease_reacquire:${oldLeaseId}`),
			'agent_vm.tool_vm.ssh.operation': 'command',
		});
		const serializedTelemetry = JSON.stringify({
			controllerFinalTelemetry,
			pluginObservationTelemetry,
		});
		expect(serializedTelemetry).not.toContain('active-use-secret-canary');
		expect(serializedTelemetry).not.toContain('identity-pem');
	});
});
