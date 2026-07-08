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
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import { createLeaseManager } from '../leases/lease-manager.js';
import { createTcpPool } from '../leases/tcp-pool.js';
import { createControlSessionDispatcher } from './control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import { createGatewayControlDomainHandler } from './gateway-control-domain-handler.js';
import { createGatewayControlLeaseRpcOperations } from './gateway-control-lease-rpc.js';

const acceptedSession = {
	bootId: 'gateway-boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
};

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
		zoneId: 'zone-a',
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
		idempotencyKey: `${operation}:${String(sequence)}`,
		kind: 'command',
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
		const vm = {
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				host: '127.0.0.1',
				identityFile: '/tmp/tool-vm-key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			getHostPid: () => 12345,
			getVmInstance: () => vm,
			id: 'tool-vm-1',
			setIngressRoutes: vi.fn(),
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
		now: () => 1_000,
		projectNamespace: 'gateway-control-lease-rpc-integration-tests',
		readProcessIdentity: async () => ({
			command: 'qemu-system-x86_64 -m 1G',
			lstart: 'Fri May 22 10:00:00 2026',
		}),
		stateDirFor: (zoneId) => `/tmp/gateway-control-lease-rpc-integration-tests/${zoneId}`,
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
): Promise<GatewayControlCommandResultMessage> {
	return GatewayControlRpcCommandResultMessageSchema.parse(
		await dispatcher.dispatch({
			envelope: createEnvelope(operation, sequence),
			payload: message,
		}),
	);
}

describe('gateway control lease RPC integration', () => {
	it('reacquires a replacement lease through the real domain-handler seam after release', async () => {
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
		const leaseRpcOptions = {
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event: AgentVmHealthEvent) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions: async ({ callerContext }) => ({
				agentId: callerContext.agentId,
				agentWorkspaceDir: callerContext.agentWorkspaceDir,
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
		} satisfies Parameters<typeof createGatewayControlLeaseRpcOperations>[0];
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			...leaseRpcOptions,
		});
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				leaseRpc,
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
		await dispatchGatewayControl(dispatcher, 'lease_release', 3, {
			kind: 'command',
			operation: 'lease_release',
			payload: {
				callerContext: { callerContextId: firstCallerContextId },
				leaseId: oldLeaseId,
			},
		});
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
});
