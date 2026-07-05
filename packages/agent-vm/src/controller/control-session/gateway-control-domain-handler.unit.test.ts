import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	type GatewayControlLeaseSnapshot,
	type GatewayControlLeaseUseSnapshot,
	GatewayControlRpcMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import type { OpenClawRuntimeStatusReport } from '../openclaw-runtime-status.js';
import { createControlSessionDispatcher } from './control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	type GatewayControlControllerHostActionOperations,
	type GatewayControlLeaseRpcOperations,
} from './gateway-control-domain-handler.js';

const acceptedSession = {
	bootId: 'gateway-boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
};

const callerContextRegisterEnvelope = {
	bootId: acceptedSession.bootId,
	commandId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: acceptedSession.controllerEpoch,
	createdAtMs: 1,
	deliveryPolicy: 'critical_idempotent',
	domain: 'gateway_control',
	idempotencyKey: 'register-context-main',
	kind: 'command',
	messageId: '22222222-2222-4222-8222-222222222222',
	operation: 'caller_context_register',
	peerId: acceptedSession.peerId,
	protocolVersion: CONTROL_PROTOCOL_VERSION,
	sequence: 1,
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: acceptedSession.zoneId,
} as const;

const callerContextRegisterPayload = {
	adapterEvidence: {
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/workspace',
		sessionKey: 'agent:main:test-session',
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
		zoneId: 'zone-a',
	},
};

const callerContextRegisterMessage = GatewayControlRpcMessageSchema.parse({
	kind: 'command',
	operation: 'caller_context_register',
	payload: callerContextRegisterPayload,
});

const leaseSnapshot = {
	agentId: 'main',
	idleTtlMs: 120_000,
	leaseId: 'lease-main',
	ssh: {
		host: 'tool-7.vm.host',
		identityPem: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----',
		knownHostsLine: '',
		port: 22,
		user: 'root',
	},
	state: 'idle',
	tcpSlot: 7,
	transport: 'ssh-sandbox',
	workdir: '/workspace',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayControlLeaseSnapshot;

const activeLeaseUseSnapshot = {
	expiresAt: 120_000,
	heartbeatAfterMs: 30_000,
	leaseId: 'lease-main',
	state: 'active',
	useId: '01890f00-0000-4000-8000-000000000000',
} satisfies GatewayControlLeaseUseSnapshot;

const releasedLeaseSnapshot = {
	agentId: leaseSnapshot.agentId,
	idleTtlMs: leaseSnapshot.idleTtlMs,
	leaseId: leaseSnapshot.leaseId,
	state: 'released',
	tcpSlot: leaseSnapshot.tcpSlot,
	transport: leaseSnapshot.transport,
	workdir: leaseSnapshot.workdir,
	zoneId: leaseSnapshot.zoneId,
} satisfies GatewayControlLeaseSnapshot;

const endedLeaseUseSnapshot = {
	leaseId: activeLeaseUseSnapshot.leaseId,
	state: 'ended',
	useId: activeLeaseUseSnapshot.useId,
} satisfies GatewayControlLeaseUseSnapshot;

const callerContextPayload = {
	callerContext: {
		callerContextId: '44444444-4444-4444-8444-444444444444',
	},
};

function createLeaseRpcStub(
	overrides: Partial<GatewayControlLeaseRpcOperations> = {},
): GatewayControlLeaseRpcOperations {
	return {
		createLease: vi.fn(async () => leaseSnapshot),
		endLeaseUse: vi.fn(async () => endedLeaseUseSnapshot),
		getLease: vi.fn(async () => leaseSnapshot),
		heartbeatLeaseUse: vi.fn(async () => activeLeaseUseSnapshot),
		releaseLease: vi.fn(async () => releasedLeaseSnapshot),
		renewLease: vi.fn(async () => leaseSnapshot),
		startLeaseUse: vi.fn(async () => activeLeaseUseSnapshot),
		...overrides,
	};
}

function createEnvelope(
	operation: keyof typeof gatewayControlDeliveryPolicyByOperation,
	overrides: Partial<ControlEnvelope> = {},
): ControlEnvelope {
	return {
		...callerContextRegisterEnvelope,
		commandId: '55555555-5555-4555-8555-555555555555',
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation[operation],
		idempotencyKey: `${operation}-idempotency`,
		messageId: '66666666-6666-4666-8666-666666666666',
		operation,
		sequence: 2,
		...overrides,
	};
}

function createAuthorizedControllerHostActions(
	pushZoneGit: GatewayControlControllerHostActionOperations['pushZoneGit'],
): GatewayControlControllerHostActionOperations {
	return {
		authorizeControllerHostAction: vi.fn(async () => ({ authorized: true }) as const),
		pushZoneGit,
	};
}

function createRegisteredCallerContexts(
	options: { readonly purpose?: 'tool_portal_controller_host_action' | 'tool_vm_lease' } = {},
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	const callerContexts = createGatewayControlCallerContextRegistry({
		createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
	});
	callerContexts.register({
		payload: {
			adapterEvidence: {
				...callerContextRegisterPayload.adapterEvidence,
				...(options.purpose === undefined ? {} : { purpose: options.purpose }),
			},
		},
		session: acceptedSession,
	});
	return callerContexts;
}

describe('gateway control domain handler', () => {
	it('issues callerContextId through the dispatcher without exposing raw evidence in the result', async () => {
		const callerContexts = createGatewayControlCallerContextRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: callerContextRegisterEnvelope,
			payload: callerContextRegisterMessage,
		});

		expect(response).toEqual({
			kind: 'command_result',
			operation: 'caller_context_register',
			payload: {
				callerContext: {
					callerContextId: '44444444-4444-4444-8444-444444444444',
				},
				responseToMessageId: '22222222-2222-4222-8222-222222222222',
				result: 'ok',
			},
		});
		expect(JSON.stringify(response)).not.toContain('agent:main:test-session');
	});

	it('creates a lease only through a registered callerContextId', async () => {
		const callerContexts = createGatewayControlCallerContextRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				leaseRpc,
				session: acceptedSession,
			}),
		);
		await dispatcher.dispatch({
			envelope: callerContextRegisterEnvelope,
			payload: callerContextRegisterMessage,
		});

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('lease_create'),
			payload: {
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: {
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
				},
			},
		});

		expect(createLease).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
				zoneId: acceptedSession.zoneId,
			}),
			payload: {
				callerContext: {
					callerContextId: '44444444-4444-4444-8444-444444444444',
				},
			},
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'lease_create',
			payload: {
				lease: leaseSnapshot,
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'ok',
			},
		});
	});

	it('rejects lease_create that claims idempotent delivery without an idempotency key', async () => {
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createRegisteredCallerContexts(),
				leaseRpc,
				session: acceptedSession,
			}),
		);

		await expect(
			dispatcher.dispatch({
				envelope: createEnvelope('lease_create', {
					deliveryPolicy: 'critical_idempotent',
					idempotencyKey: undefined,
				}),
				payload: {
					kind: 'command',
					operation: 'lease_create',
					payload: callerContextPayload,
				},
			}),
		).rejects.toThrow(/delivery policy mismatch/u);
		expect(createLease).not.toHaveBeenCalled();
	});

	it('rejects lease_create when callerContextId is unknown', async () => {
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				leaseRpc,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('lease_create'),
			payload: {
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: {
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
				},
			},
		});

		expect(createLease).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'lease_create',
			payload: {
				leaseRejectionReason: 'absent',
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects lease_create when callerContextId belongs to a previous gateway boot', async () => {
		const callerContexts = createGatewayControlCallerContextRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		callerContexts.register({
			payload: callerContextRegisterPayload,
			session: acceptedSession,
		});
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				leaseRpc,
				session: {
					...acceptedSession,
					bootId: 'gateway-boot-b',
				},
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('lease_create', {
				bootId: 'gateway-boot-b',
			}),
			payload: {
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: {
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
				},
			},
		});

		expect(createLease).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'lease_create',
			payload: {
				leaseRejectionReason: 'absent',
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects lease_create when callerContextId belongs to a previous accepted session', async () => {
		const callerContexts = createGatewayControlCallerContextRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		callerContexts.register({
			payload: callerContextRegisterPayload,
			session: acceptedSession,
		});
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				leaseRpc,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('lease_create', {
				connectionId: '99999999-9999-4999-8999-999999999999',
				sessionId: '88888888-8888-4888-8888-888888888888',
			}),
			payload: {
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: {
						callerContextId: '44444444-4444-4444-8444-444444444444',
					},
				},
			},
		});

		expect(createLease).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'lease_create',
			payload: {
				leaseRejectionReason: 'absent',
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it.each([
		['lease_get', 'getLease', 'private'],
		['lease_peek', 'getLease', 'public'],
		['lease_renew', 'renewLease', undefined],
		['lease_release', 'releaseLease', undefined],
	] as const)(
		'routes %s through lease RPC operations',
		async (operation, operationMethod, includeSsh) => {
			const leaseRpc = createLeaseRpcStub();
			const dispatcher = createControlSessionDispatcher();
			dispatcher.register(
				'gateway_control',
				createGatewayControlDomainHandler({
					callerContexts: createRegisteredCallerContexts(),
					leaseRpc,
					session: acceptedSession,
				}),
			);

			const response = await dispatcher.dispatch({
				envelope: createEnvelope(operation),
				payload: {
					kind: 'command',
					operation,
					payload: {
						...callerContextPayload,
						leaseId: 'lease-main',
					},
				},
			});

			if (includeSsh === undefined) {
				expect(leaseRpc[operationMethod]).toHaveBeenCalledWith({
					callerContext: expect.objectContaining({
						agentId: 'main',
						callerContextId: '44444444-4444-4444-8444-444444444444',
						purpose: 'tool_vm_lease',
						zoneId: acceptedSession.zoneId,
					}),
					payload: { ...callerContextPayload, leaseId: 'lease-main' },
				});
			} else {
				expect(leaseRpc[operationMethod]).toHaveBeenCalledWith(
					{
						callerContext: expect.objectContaining({
							agentId: 'main',
							callerContextId: '44444444-4444-4444-8444-444444444444',
							purpose: 'tool_vm_lease',
							zoneId: acceptedSession.zoneId,
						}),
						payload: { ...callerContextPayload, leaseId: 'lease-main' },
					},
					{ includeSsh },
				);
			}
			expect(response).toMatchObject({
				kind: 'command_result',
				operation,
				payload: {
					responseToMessageId: '66666666-6666-4666-8666-666666666666',
					result: 'ok',
				},
			});
		},
	);

	it('routes active-use commands through lease RPC operations with allowlisted correlation', async () => {
		const startLeaseUse = vi.fn(async () => activeLeaseUseSnapshot);
		const heartbeatLeaseUse = vi.fn(async () => activeLeaseUseSnapshot);
		const endLeaseUse = vi.fn(async () => endedLeaseUseSnapshot);
		const leaseRpc = createLeaseRpcStub({
			endLeaseUse,
			heartbeatLeaseUse,
			startLeaseUse,
		});
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createRegisteredCallerContexts(),
				leaseRpc,
				session: acceptedSession,
			}),
		);

		const startResponse = await dispatcher.dispatch({
			envelope: createEnvelope('lease_use_start'),
			payload: {
				kind: 'command',
				operation: 'lease_use_start',
				payload: {
					...callerContextPayload,
					correlation: {
						capability: {
							name: 'shell',
							namespace: 'tool_vm',
						},
						runId: 'run-a',
						sessionKeyDigest: '0123456789abcdef0123456789abcdef',
						toolCallId: 'tool-call-a',
						traceId: 'fedcba9876543210fedcba9876543210',
					},
					leaseId: 'lease-main',
					useId: activeLeaseUseSnapshot.useId,
				},
			},
		});
		const heartbeatResponse = await dispatcher.dispatch({
			envelope: createEnvelope('lease_use_heartbeat', {
				commandId: '77777777-7777-4777-8777-777777777777',
				idempotencyKey: 'lease-use-heartbeat-idempotency',
				messageId: '88888888-8888-4888-8888-888888888888',
				sequence: 3,
			}),
			payload: {
				kind: 'command',
				operation: 'lease_use_heartbeat',
				payload: {
					...callerContextPayload,
					leaseId: 'lease-main',
					useId: activeLeaseUseSnapshot.useId,
				},
			},
		});
		const endResponse = await dispatcher.dispatch({
			envelope: createEnvelope('lease_use_end', {
				commandId: '99999999-9999-4999-8999-999999999999',
				idempotencyKey: 'lease-use-end-idempotency',
				messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				sequence: 4,
			}),
			payload: {
				kind: 'command',
				operation: 'lease_use_end',
				payload: {
					...callerContextPayload,
					leaseId: 'lease-main',
					reason: 'completed',
					useId: activeLeaseUseSnapshot.useId,
				},
			},
		});

		expect(startLeaseUse).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
				purpose: 'tool_vm_lease',
				zoneId: acceptedSession.zoneId,
			}),
			payload: {
				...callerContextPayload,
				correlation: {
					runId: 'run-a',
					sessionKeyDigest: '0123456789abcdef0123456789abcdef',
					toolCallId: 'tool-call-a',
					traceId: 'fedcba9876543210fedcba9876543210',
				},
				leaseId: 'lease-main',
				useId: activeLeaseUseSnapshot.useId,
			},
		});
		expect(heartbeatLeaseUse).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
				purpose: 'tool_vm_lease',
				zoneId: acceptedSession.zoneId,
			}),
			payload: {
				...callerContextPayload,
				leaseId: 'lease-main',
				useId: activeLeaseUseSnapshot.useId,
			},
		});
		expect(endLeaseUse).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
				purpose: 'tool_vm_lease',
				zoneId: acceptedSession.zoneId,
			}),
			payload: {
				...callerContextPayload,
				leaseId: 'lease-main',
				reason: 'completed',
				useId: activeLeaseUseSnapshot.useId,
			},
		});
		expect(startResponse).toMatchObject({
			operation: 'lease_use_start',
			payload: { leaseUse: activeLeaseUseSnapshot, result: 'ok' },
		});
		expect(heartbeatResponse).toMatchObject({
			operation: 'lease_use_heartbeat',
			payload: { leaseUse: activeLeaseUseSnapshot, result: 'ok' },
		});
		expect(endResponse).toMatchObject({
			operation: 'lease_use_end',
			payload: { leaseUse: { state: 'ended' }, result: 'ok' },
		});
	});

	it('rejects a lease_create payload that tries to carry raw authority fields', async () => {
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				session: acceptedSession,
			}),
		);

		await expect(
			dispatcher.dispatch({
				envelope: {
					...callerContextRegisterEnvelope,
					commandId: '55555555-5555-4555-8555-555555555555',
					idempotencyKey: 'lease-create-raw-fields',
					messageId: '66666666-6666-4666-8666-666666666666',
					operation: 'lease_create',
					sequence: 2,
				},
				payload: {
					kind: 'command',
					operation: 'lease_create',
					payload: {
						agentId: 'main',
						agentWorkspaceDir: '/home/openclaw/workspace',
						profileId: 'standard',
						sessionKey: 'agent:main:test-session',
						workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
						zoneId: 'zone-a',
					},
				},
			}),
		).rejects.toThrow();
	});

	it('records gateway health events from the accepted control session', async () => {
		const recordHealthEvent = vi.fn<(event: AgentVmHealthEvent) => void>();
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				recordHealthEvent,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('health_event', {
				deliveryPolicy: 'append_only_observation',
				kind: 'event',
			}),
			payload: {
				kind: 'event',
				operation: 'health_event',
				payload: {
					agentId: 'main',
					elapsedMs: 25,
					eventKind: 'tool-vm-ssh',
					leaseId: 'lease-main',
					observedAtMs: 1_000,
					operation: 'probe',
					result: 'ok',
				},
			},
		});

		expect(response).toBeUndefined();
		expect(recordHealthEvent).toHaveBeenCalledWith({
			kind: 'tool-vm-ssh',
			agentId: 'main',
			elapsedMs: 25,
			leaseId: 'lease-main',
			observedAtMs: 1_000,
			operation: 'probe',
			result: 'ok',
			zoneId: acceptedSession.zoneId,
		});
	});

	it('rejects malformed gateway health events before recording them', async () => {
		const recordHealthEvent = vi.fn<(event: AgentVmHealthEvent) => void>();
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				recordHealthEvent,
				session: acceptedSession,
			}),
		);

		await expect(
			dispatcher.dispatch({
				envelope: createEnvelope('health_event', {
					deliveryPolicy: 'append_only_observation',
					kind: 'event',
				}),
				payload: {
					kind: 'event',
					operation: 'health_event',
					payload: {
						agentId: 'main',
						elapsedMs: 25,
						eventKind: 'tool-vm-ssh',
						leaseId: 'lease-main',
						observedAtMs: 1_000,
						operation: 'bogus-tool-op',
						result: 'ok',
					},
				},
			}),
		).rejects.toThrow();
		expect(recordHealthEvent).not.toHaveBeenCalled();
	});

	it('records priority heartbeat as gateway control-session liveness', async () => {
		const recordHealthEvent = vi.fn<(event: AgentVmHealthEvent) => void>();
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				recordHealthEvent,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: {
				...createEnvelope('health_event', {
					deliveryPolicy: 'critical_idempotent',
					kind: 'heartbeat',
				}),
				operation: undefined,
			},
			payload: {
				kind: 'heartbeat',
				payload: {
					elapsedMs: 3,
					observedAtMs: 1_000,
				},
			},
		});

		expect(response).toBeUndefined();
		expect(recordHealthEvent).toHaveBeenCalledWith({
			domain: 'gateway_control',
			elapsedMs: 3,
			kind: 'gateway-control-session',
			observedAtMs: 1_000,
			operation: 'control-session-heartbeat',
			peerId: acceptedSession.peerId,
			result: 'ok',
			zoneId: acceptedSession.zoneId,
		});
	});

	it('records runtime status from the accepted control session', async () => {
		const recordRuntimeStatus = vi.fn<(report: OpenClawRuntimeStatusReport) => void>();
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				recordRuntimeStatus,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('runtime_status', {
				deliveryPolicy: 'latest_wins',
				kind: 'event',
			}),
			payload: {
				kind: 'event',
				operation: 'runtime_status',
				payload: {
					findings: [{ id: 'runtime-config', ok: true }],
					observedAtMs: 2_000,
					statusKind: 'gondolin',
				},
			},
		});

		expect(response).toBeUndefined();
		expect(recordRuntimeStatus).toHaveBeenCalledWith({
			findings: [{ hint: 'runtime-config', id: 'runtime-config', ok: true }],
			pluginId: 'gondolin',
			zoneId: acceptedSession.zoneId,
		});
	});

	it('routes tool_portal_controller_host_action through the narrow zone git push handler', async () => {
		const pushZoneGit = vi.fn(async () => ({
			branch: 'main',
			localHead: 'abc123',
			pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
			remoteHead: 'abc123',
		}));
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_host_action',
		});
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				controllerHostActions: createAuthorizedControllerHostActions(pushZoneGit),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_host_action', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload: {
					actionId: 'zone_git_push',
					...callerContextPayload,
					correlation: {
						capability: {
							name: 'zone_git_push',
							namespace: 'controller_host_action',
						},
					},
					expectedHead: 'abc123',
				},
			},
		});

		expect(pushZoneGit).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
			}),
			payload: {
				actionId: 'zone_git_push',
				...callerContextPayload,
				correlation: {
					capability: {
						name: 'zone_git_push',
						namespace: 'controller_host_action',
					},
				},
				expectedHead: 'abc123',
			},
			session: acceptedSession,
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_host_action',
			payload: {
				controllerHostAction: {
					actionId: 'zone_git_push',
					result: {
						branch: 'main',
						localHead: 'abc123',
						pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
						remoteHead: 'abc123',
					},
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'ok',
			},
		});
		expect(callerContexts.resolve('44444444-4444-4444-8444-444444444444')).toBeUndefined();
	});

	it('rejects tool_portal_controller_host_action when callerContextId was registered for a lease', async () => {
		const pushZoneGit = vi.fn(async () => ({
			branch: 'main',
			localHead: 'abc123',
			pushedCommits: [],
			remoteHead: 'abc123',
		}));
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createRegisteredCallerContexts({ purpose: 'tool_vm_lease' }),
				controllerHostActions: createAuthorizedControllerHostActions(pushZoneGit),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_host_action', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload: {
					actionId: 'zone_git_push',
					...callerContextPayload,
					correlation: {
						capability: {
							name: 'zone_git_push',
							namespace: 'controller_host_action',
						},
					},
					expectedHead: 'abc123',
				},
			},
		});

		expect(pushZoneGit).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_host_action',
			payload: {
				error: {
					errorClass: 'controller_host_action_caller_context_stale',
					retryable: false,
					safeMessage: 'controller host action caller context does not match session',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects tool_portal_controller_host_action when no controller handler is configured', async () => {
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_host_action', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload: {
					actionId: 'zone_git_push',
					...callerContextPayload,
					correlation: {
						capability: {
							name: 'zone_git_push',
							namespace: 'controller_host_action',
						},
					},
					expectedHead: 'abc123',
				},
			},
		});

		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_host_action',
			payload: {
				error: {
					errorClass: 'controller_host_action_unconfigured',
					retryable: false,
					safeMessage: 'controller host action handler is not configured',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects tool_portal_controller_host_action when callerContextId is not registered', async () => {
		const pushZoneGit = vi.fn(async () => ({
			branch: 'main',
			localHead: 'abc123',
			pushedCommits: [],
			remoteHead: 'abc123',
		}));
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				controllerHostActions: createAuthorizedControllerHostActions(pushZoneGit),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_host_action', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload: {
					actionId: 'zone_git_push',
					...callerContextPayload,
					correlation: {
						capability: {
							name: 'zone_git_push',
							namespace: 'controller_host_action',
						},
					},
					expectedHead: 'abc123',
				},
			},
		});

		expect(pushZoneGit).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_host_action',
			payload: {
				error: {
					errorClass: 'controller_host_action_caller_context_absent',
					retryable: false,
					safeMessage: 'controller host action caller context is not registered',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects tool_portal_controller_host_action before push when authorization denies it', async () => {
		const pushZoneGit = vi.fn(async () => ({
			branch: 'main',
			localHead: 'abc123',
			pushedCommits: [],
			remoteHead: 'abc123',
		}));
		const authorizeControllerHostAction = vi.fn(
			async () =>
				({
					authorized: false,
					errorClass: 'controller_host_action_policy_denied',
					safeMessage: 'controller host action policy denied the requested capability',
				}) as const,
		);
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_host_action',
		});
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts,
				controllerHostActions: {
					authorizeControllerHostAction,
					pushZoneGit,
				},
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_host_action', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload: {
					actionId: 'zone_git_push',
					...callerContextPayload,
					correlation: {
						capability: {
							name: 'zone_git_push',
							namespace: 'controller_host_action',
						},
					},
					expectedHead: 'abc123',
				},
			},
		});

		expect(authorizeControllerHostAction).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
			}),
			payload: {
				actionId: 'zone_git_push',
				...callerContextPayload,
				correlation: {
					capability: {
						name: 'zone_git_push',
						namespace: 'controller_host_action',
					},
				},
				expectedHead: 'abc123',
			},
			session: acceptedSession,
		});
		expect(pushZoneGit).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_host_action',
			payload: {
				error: {
					errorClass: 'controller_host_action_policy_denied',
					retryable: false,
					safeMessage: 'controller host action policy denied the requested capability',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
		expect(callerContexts.resolve('44444444-4444-4444-8444-444444444444')).toBeUndefined();
	});

	it('rejects inbound operation_cancel without pretending an active operation was cancelled', async () => {
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('operation_cancel', {
				deliveryPolicy: 'acked_idempotent',
			}),
			payload: {
				kind: 'command',
				operation: 'operation_cancel',
				payload: {
					activeOperationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
					initiatedBy: 'gateway',
					reason: 'caller_cancelled',
				},
			},
		});

		expect(response).toEqual({
			kind: 'command_result',
			operation: 'operation_cancel',
			payload: {
				activeOperationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
				error: {
					errorClass: 'active_operation_not_found',
					retryable: false,
					safeMessage: 'active operation is not tracked by this controller session',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects inbound recovery_command as controller-only control', async () => {
		const dispatcher = createControlSessionDispatcher();
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createGatewayControlCallerContextRegistry(),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('recovery_command', {
				deliveryPolicy: 'critical_idempotent',
			}),
			payload: {
				kind: 'command',
				operation: 'recovery_command',
				payload: {
					action: 'refresh_runtime_status',
				},
			},
		});

		expect(response).toEqual({
			kind: 'command_result',
			operation: 'recovery_command',
			payload: {
				error: {
					errorClass: 'controller_only_operation',
					retryable: false,
					safeMessage: 'recovery commands must be issued by the controller',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});
});
