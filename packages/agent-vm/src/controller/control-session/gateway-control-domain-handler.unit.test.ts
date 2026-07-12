import { createHmac } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlLeaseSnapshot,
	type GatewayControlLeaseUseSnapshot,
	GatewayControlRpcMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import { TEST_SSH_SERVER_HOST_KEY } from '../../testing/managed-vm-test-helpers.js';
import type { OpenClawRuntimeStatusReport } from '../openclaw-runtime-status.js';
import {
	createControlSessionDispatcher,
	type ControlSessionDispatcher,
} from './control-session-dispatcher.js';
import {
	createGatewayControlCallerContextRegistry,
	deriveGatewayControlStablePrincipal,
} from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	type GatewayControlControllerHostActionOperations,
	type GatewayControlDomainHandlerOptions,
	type GatewayControlLeaseRpcOperations,
	type GatewayControlPreparedLeaseSemanticMutation,
	type GatewayControlLeaseSemanticMutationPreparationOptions,
} from './gateway-control-domain-handler.js';
import { createGatewaySemanticResultLedger } from './gateway-semantic-result-ledger.js';

const acceptedSession = {
	bootId: 'gateway-boot-a',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
};

const gateway = {
	bootId: acceptedSession.bootId,
	controllerEpoch: acceptedSession.controllerEpoch,
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: acceptedSession.zoneId,
};
const stablePrincipal = deriveGatewayControlStablePrincipal({
	agentId: 'main',
	zoneId: gateway.zoneId,
});

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
	adapterEvidence: signCallerContextEvidence({
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/workspace',
		sessionKey: 'agent:main:test-session',
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
		zoneId: 'zone-a',
	}),
} satisfies GatewayControlCallerContextRegisterPayload;

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
		knownHostsLine: `tool-7.vm.host ${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}`,
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

type LeaseCreatePreparation = Extract<
	GatewayControlLeaseSemanticMutationPreparationOptions,
	{ readonly operation: 'lease_create' }
>;
type LeaseReacquirePreparation = Extract<
	GatewayControlLeaseSemanticMutationPreparationOptions,
	{ readonly operation: 'lease_reacquire' }
>;
type LeaseIdPreparation = Extract<
	GatewayControlLeaseSemanticMutationPreparationOptions,
	{ readonly operation: 'lease_release' | 'lease_renew' }
>;
type LeaseUseStartPreparation = Extract<
	GatewayControlLeaseSemanticMutationPreparationOptions,
	{ readonly operation: 'lease_use_start' }
>;
type LeaseUseHeartbeatPreparation = Extract<
	GatewayControlLeaseSemanticMutationPreparationOptions,
	{ readonly operation: 'lease_use_heartbeat' }
>;
type LeaseUseEndPreparation = Extract<
	GatewayControlLeaseSemanticMutationPreparationOptions,
	{ readonly operation: 'lease_use_end' }
>;

interface LeaseMutationExecutors {
	readonly createLease: (
		options: Pick<LeaseCreatePreparation, 'callerContext' | 'payload'>,
	) => Promise<GatewayControlLeaseSnapshot>;
	readonly endLeaseUse: (
		options: Pick<LeaseUseEndPreparation, 'callerContext' | 'payload'>,
	) => Promise<GatewayControlLeaseUseSnapshot | undefined>;
	readonly getLease: GatewayControlLeaseRpcOperations['getLease'];
	readonly heartbeatLeaseUse: (
		options: Pick<LeaseUseHeartbeatPreparation, 'callerContext' | 'payload'>,
	) => Promise<GatewayControlLeaseUseSnapshot | undefined>;
	readonly reacquireLease: (
		options: Pick<LeaseReacquirePreparation, 'callerContext' | 'payload'>,
	) => Promise<GatewayControlLeaseSnapshot | undefined>;
	readonly releaseLease: (
		options: Pick<LeaseIdPreparation, 'callerContext' | 'payload'>,
	) => Promise<GatewayControlLeaseSnapshot | undefined>;
	readonly renewLease: (
		options: Pick<LeaseIdPreparation, 'callerContext' | 'payload'>,
	) => Promise<GatewayControlLeaseSnapshot | undefined>;
	readonly startLeaseUse: (
		options: Pick<LeaseUseStartPreparation, 'callerContext' | 'payload'>,
	) => Promise<GatewayControlLeaseUseSnapshot | undefined>;
}

function createLeaseRpcStub(
	overrides: Partial<LeaseMutationExecutors> = {},
): GatewayControlLeaseRpcOperations {
	const executors = {
		createLease: vi.fn(async () => leaseSnapshot),
		endLeaseUse: vi.fn(async () => endedLeaseUseSnapshot),
		getLease: vi.fn(async () => leaseSnapshot),
		heartbeatLeaseUse: vi.fn(async () => activeLeaseUseSnapshot),
		reacquireLease: vi.fn(async () => leaseSnapshot),
		releaseLease: vi.fn(async () => releasedLeaseSnapshot),
		renewLease: vi.fn(async () => leaseSnapshot),
		startLeaseUse: vi.fn(async () => activeLeaseUseSnapshot),
		...overrides,
	} satisfies LeaseMutationExecutors;
	return {
		getLease: executors.getLease,
		prepareSemanticMutation: vi.fn(
			async (
				options: GatewayControlLeaseSemanticMutationPreparationOptions,
			): Promise<GatewayControlPreparedLeaseSemanticMutation> => ({
				execute: async () => {
					switch (options.operation) {
						case 'lease_create':
							return await executors.createLease({
								callerContext: options.callerContext,
								payload: options.payload,
							});
						case 'lease_reacquire':
							return await executors.reacquireLease({
								callerContext: options.callerContext,
								payload: options.payload,
							});
						case 'lease_release':
							return await executors.releaseLease({
								callerContext: options.callerContext,
								payload: options.payload,
							});
						case 'lease_renew':
							return await executors.renewLease({
								callerContext: options.callerContext,
								payload: options.payload,
							});
						case 'lease_use_start':
							return await executors.startLeaseUse({
								callerContext: options.callerContext,
								payload: options.payload,
							});
						case 'lease_use_heartbeat':
							return await executors.heartbeatLeaseUse({
								callerContext: options.callerContext,
								payload: options.payload,
							});
						case 'lease_use_end':
							return await executors.endLeaseUse({
								callerContext: options.callerContext,
								payload: options.payload,
							});
					}
					throw new Error('unsupported lease semantic mutation operation');
				},
				profile: {
					compatibilityId: 'compatibility-a',
					currentLeafTargetId: leaseSnapshot.leaseId,
					kind: 'lease_authority',
					stablePrincipal,
				},
				target: leaseSnapshot.leaseId,
			}),
		),
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
		expiresAtMs: 60_000,
		idempotencyKey: `${operation}-idempotency`,
		messageId: '66666666-6666-4666-8666-666666666666',
		operation,
		sequence: 2,
		...overrides,
	};
}

function createGatewayControlTestDispatcher(): ControlSessionDispatcher {
	const dispatcher = createControlSessionDispatcher({
		semanticLedger: createGatewaySemanticResultLedger({ gateway, nowMs: () => 1 }),
	});
	return {
		dispatch: async (context) =>
			await dispatcher.dispatch({
				...context,
				attachmentGeneration: context.attachmentGeneration ?? 1,
			}),
		register: (domain, handler) => {
			dispatcher.register(domain, handler);
		},
		validate: (context) => {
			dispatcher.validate(context);
		},
	};
}

function createTestGatewayControlDomainHandler(
	options: Omit<GatewayControlDomainHandlerOptions, 'gateway'>,
): ReturnType<typeof createGatewayControlDomainHandler> {
	return createGatewayControlDomainHandler({ gateway, ...options });
}

function createAuthorizedControllerHostActions(
	pushZoneGit: GatewayControlControllerHostActionOperations['pushZoneGit'],
	overrides: Partial<GatewayControlControllerHostActionOperations> = {},
): GatewayControlControllerHostActionOperations {
	return {
		authorizeControllerHostAction: vi.fn(async () => ({ authorized: true }) as const),
		pushZoneGit,
		runControllerHostProbe: vi.fn(async () => ({
			entryNames: ['agent-vm-host-probe.txt'],
			probeKind: 'controller_cache_dir_listing' as const,
		})),
		...overrides,
	};
}

function createRegisteredCallerContexts(
	options: { readonly purpose?: 'tool_portal_controller_host_action' | 'tool_vm_lease' } = {},
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	const callerContexts = createCallerContexts({
		createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
	});
	callerContexts.register({
		payload: {
			adapterEvidence: signCallerContextEvidence({
				agentId: callerContextRegisterPayload.adapterEvidence.agentId,
				agentWorkspaceDir: callerContextRegisterPayload.adapterEvidence.agentWorkspaceDir,
				...(options.purpose === undefined ? {} : { purpose: options.purpose }),
				sessionKey: callerContextRegisterPayload.adapterEvidence.sessionKey,
				workMountDir: callerContextRegisterPayload.adapterEvidence.workMountDir,
				zoneId: callerContextRegisterPayload.adapterEvidence.zoneId,
			}),
		},
		session: acceptedSession,
	});
	return callerContexts;
}

function createCallerContexts(
	options: {
		readonly createCallerContextId?: () => string;
		readonly maxContexts?: number;
	} = {},
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	return createGatewayControlCallerContextRegistry({
		agentAuthorityKeys,
		callerContextProofKey,
		...options,
	});
}

describe('gateway control domain handler', () => {
	it('issues callerContextId through the dispatcher without exposing raw evidence in the result', async () => {
		const callerContexts = createCallerContexts({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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
					admissionPrincipal: deriveGatewayControlStablePrincipal({
						agentId: 'main',
						zoneId: 'zone-a',
					}),
					callerContextId: '44444444-4444-4444-8444-444444444444',
				},
				responseToMessageId: '22222222-2222-4222-8222-222222222222',
				result: 'ok',
			},
		});
		expect(JSON.stringify(response)).not.toContain('agent:main:test-session');
	});

	it('creates a lease only through a registered callerContextId', async () => {
		const callerContexts = createCallerContexts({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
				leaseRejectionReason: 'caller_context_absent',
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects lease_create when callerContextId belongs to a previous gateway boot', async () => {
		const callerContexts = createCallerContexts({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		callerContexts.register({
			payload: callerContextRegisterPayload,
			session: acceptedSession,
		});
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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
				leaseRejectionReason: 'caller_context_session_mismatch',
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects lease_create when callerContextId belongs to a previous accepted session', async () => {
		const callerContexts = createCallerContexts({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		callerContexts.register({
			payload: callerContextRegisterPayload,
			session: acceptedSession,
		});
		const createLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ createLease });
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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
				leaseRejectionReason: 'caller_context_session_mismatch',
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects lease operations with a stale caller-context id', async () => {
		const callerContexts = createRegisteredCallerContexts();
		callerContexts.release('44444444-4444-4444-8444-444444444444');
		const renewLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ renewLease });
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				leaseRpc,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('lease_renew'),
			payload: {
				kind: 'command',
				operation: 'lease_renew',
				payload: {
					...callerContextPayload,
					leaseId: 'lease-main',
				},
			},
		});

		expect(renewLease).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'lease_renew',
			payload: {
				leaseRejectionReason: 'caller_context_stale',
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('routes lease_reacquire through lease RPC operations', async () => {
		const reacquireLease = vi.fn(async () => leaseSnapshot);
		const leaseRpc = createLeaseRpcStub({ reacquireLease });
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createRegisteredCallerContexts(),
				leaseRpc,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('lease_reacquire'),
			payload: {
				kind: 'command',
				operation: 'lease_reacquire',
				payload: {
					...callerContextPayload,
					oldLeaseId: 'lease-main',
					staleEvidence: {
						errorCode: 'ssh-command-failed',
						kind: 'tool-vm-ssh',
						observedAtMs: 1_000,
						operation: 'file-bridge',
					},
				},
			},
		});

		expect(reacquireLease).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
				purpose: 'tool_vm_lease',
				zoneId: 'zone-a',
			}),
			payload: {
				...callerContextPayload,
				oldLeaseId: 'lease-main',
				staleEvidence: {
					errorCode: 'ssh-command-failed',
					kind: 'tool-vm-ssh',
					observedAtMs: 1_000,
					operation: 'file-bridge',
				},
			},
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'lease_reacquire',
			payload: {
				lease: leaseSnapshot,
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'ok',
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
			const dispatcher = createGatewayControlTestDispatcher();
			dispatcher.register(
				'gateway_control',
				createTestGatewayControlDomainHandler({
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
				expect(leaseRpc.prepareSemanticMutation).toHaveBeenCalledWith(
					expect.objectContaining({
						attachmentGeneration: 1,
						callerContext: expect.objectContaining({
							agentId: 'main',
							callerContextId: '44444444-4444-4444-8444-444444444444',
							purpose: 'tool_vm_lease',
							zoneId: acceptedSession.zoneId,
						}),
						gateway,
						operation,
						payload: { ...callerContextPayload, leaseId: 'lease-main' },
						processEpoch: acceptedSession.bootId,
					}),
				);
			} else {
				expect(leaseRpc[operationMethod]).toHaveBeenCalledWith(
					{
						callerContext: expect.objectContaining({
							agentId: 'main',
							callerContextId: '44444444-4444-4444-8444-444444444444',
							purpose: 'tool_vm_lease',
							zoneId: acceptedSession.zoneId,
						}),
						gateway,
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
					correlation: {
						causationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
						correlationId: 'correlation-main',
						requestId: 'request-main',
						runId: 'run-main',
						sessionKeyDigest: 'a'.repeat(64),
						toolCallId: 'tool-call-main',
						traceId: '0123456789abcdef0123456789abcdef',
					},
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
			causationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			correlationId: 'correlation-main',
			elapsedMs: 25,
			leaseId: 'lease-main',
			observedAtMs: 1_000,
			operation: 'probe',
			requestId: 'request-main',
			result: 'ok',
			runId: 'run-main',
			sessionKeyDigest: 'a'.repeat(64),
			toolCallId: 'tool-call-main',
			traceId: '0123456789abcdef0123456789abcdef',
			zoneId: acceptedSession.zoneId,
		});
	});

	it('records Tool VM lifecycle health fields from the accepted control session', async () => {
		const recordHealthEvent = vi.fn<(event: AgentVmHealthEvent) => void>();
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
					activeUseId: '66666666-6666-4666-8666-666666666666',
					agentId: 'main',
					callerContextState: 'stale',
					elapsedMs: 25,
					errorCode: 'ssh-command-failed',
					eventKind: 'tool-vm-ssh',
					leaseId: '01890f00-0000-7000-8000-000000000001',
					leaseRejectionReason: 'caller_context_stale',
					lifecycleEventRole: 'plugin_observation',
					lifecycleTransition: 'current_to_stale',
					observedAtMs: 1_000,
					oldLeaseId: '01890f00-0000-7000-8000-000000000001',
					operation: 'file-bridge',
					result: 'failed',
					transitionId: '77777777-7777-4777-8777-777777777777',
				},
			},
		});

		expect(response).toBeUndefined();
		expect(recordHealthEvent).toHaveBeenCalledWith({
			activeUseId: '66666666-6666-4666-8666-666666666666',
			agentId: 'main',
			callerContextState: 'stale',
			elapsedMs: 25,
			errorCode: 'ssh-command-failed',
			kind: 'tool-vm-ssh',
			leaseId: '01890f00-0000-7000-8000-000000000001',
			leaseRejectionReason: 'caller_context_stale',
			lifecycleEventRole: 'plugin_observation',
			lifecycleTransition: 'current_to_stale',
			observedAtMs: 1_000,
			oldLeaseId: '01890f00-0000-7000-8000-000000000001',
			operation: 'file-bridge',
			result: 'failed',
			transitionId: '77777777-7777-4777-8777-777777777777',
			zoneId: acceptedSession.zoneId,
		});
	});

	it('rejects inbound controller-final Tool VM lifecycle health events', async () => {
		const recordHealthEvent = vi.fn<(event: AgentVmHealthEvent) => void>();
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
						callerContextState: 'ok',
						elapsedMs: 25,
						eventKind: 'tool-vm-ssh',
						leaseId: '01890f00-0000-7000-8000-000000000002',
						lifecycleEventRole: 'controller_final',
						lifecycleTransition: 'stale_to_reacquired',
						observedAtMs: 1_000,
						oldLeaseId: '01890f00-0000-7000-8000-000000000001',
						operation: 'file-bridge',
						replacementLeaseId: '01890f00-0000-7000-8000-000000000002',
						result: 'ok',
						transitionId: '77777777-7777-4777-8777-777777777777',
					},
				},
			}),
		).rejects.toThrow();
		expect(recordHealthEvent).not.toHaveBeenCalled();
	});

	it('rejects malformed gateway health events before recording them', async () => {
		const recordHealthEvent = vi.fn<(event: AgentVmHealthEvent) => void>();
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
			bootId: acceptedSession.bootId,
			connectionId: acceptedSession.connectionId,
			controllerEpoch: acceptedSession.controllerEpoch,
			findings: [{ hint: 'runtime-config', id: 'runtime-config', ok: true }],
			peerId: acceptedSession.peerId,
			pluginId: 'gondolin',
			sessionId: acceptedSession.sessionId,
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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

	it('refuses changed zone_git_push meaning for the same semantic identity without a second push', async () => {
		const pushZoneGit = vi.fn(async () => ({
			branch: 'main',
			localHead: 'abc123',
			pushedCommits: [{ sha: 'abc123', subject: 'docs: update memory' }],
			remoteHead: 'abc123',
		}));
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_host_action',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerHostActions: createAuthorizedControllerHostActions(pushZoneGit),
				session: acceptedSession,
			}),
		);
		const semanticEnvelope = createEnvelope('tool_portal_controller_host_action', {
			commandId: '77777777-7777-4777-8777-777777777777',
			idempotencyKey: 'zone-git-push-semantic-identity',
		});

		await dispatcher.dispatch({
			envelope: semanticEnvelope,
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
		const collisionMessageId = '88888888-8888-4888-8888-888888888888';
		const collisionResponse = await dispatcher.dispatch({
			envelope: {
				...semanticEnvelope,
				messageId: collisionMessageId,
				sequence: semanticEnvelope.sequence + 1,
			},
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
					expectedHead: 'def456',
				},
			},
		});

		expect(collisionResponse).toMatchObject({
			operation: 'tool_portal_controller_host_action',
			payload: {
				error: { errorClass: 'gateway_semantic_idempotency_collision' },
				responseToMessageId: collisionMessageId,
				result: 'failed',
			},
		});
		expect(pushZoneGit).toHaveBeenCalledOnce();
	});

	it('fences a lost zone_git_push result as unknown without replaying its side effect', async () => {
		let remotePushCount = 0;
		const pushZoneGit = vi.fn(async () => {
			remotePushCount += 1;
			throw new Error('simulated result loss after remote push');
		});
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_host_action',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerHostActions: createAuthorizedControllerHostActions(pushZoneGit),
				session: acceptedSession,
			}),
		);
		const semanticEnvelope = createEnvelope('tool_portal_controller_host_action', {
			commandId: '99999999-9999-4999-8999-999999999999',
			idempotencyKey: 'zone-git-push-result-loss',
		});
		const message = {
			kind: 'command' as const,
			operation: 'tool_portal_controller_host_action' as const,
			payload: {
				actionId: 'zone_git_push' as const,
				...callerContextPayload,
				correlation: {
					capability: {
						name: 'zone_git_push',
						namespace: 'controller_host_action',
					},
				},
				expectedHead: 'abc123',
			},
		};

		const firstResponse = await dispatcher.dispatch({
			envelope: semanticEnvelope,
			payload: message,
		});
		const retryMessageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const retryResponse = await dispatcher.dispatch({
			envelope: {
				...semanticEnvelope,
				messageId: retryMessageId,
				sequence: semanticEnvelope.sequence + 1,
			},
			payload: message,
		});

		expect(firstResponse).toMatchObject({
			operation: 'tool_portal_controller_host_action',
			payload: {
				error: { errorClass: 'gateway_semantic_unknown_side_effect' },
				responseToMessageId: semanticEnvelope.messageId,
				result: 'failed',
			},
		});
		expect(retryResponse).toMatchObject({
			operation: 'tool_portal_controller_host_action',
			payload: {
				error: { errorClass: 'gateway_semantic_unknown_side_effect' },
				responseToMessageId: retryMessageId,
				result: 'failed',
			},
		});
		expect(remotePushCount).toBe(1);
		expect(pushZoneGit).toHaveBeenCalledOnce();
	});

	it('routes controller_host_probe through the fixed host probe handler without a shell command', async () => {
		const pushZoneGit = vi.fn(async () => ({
			branch: 'main',
			localHead: 'abc123',
			pushedCommits: [],
			remoteHead: 'abc123',
		}));
		const runControllerHostProbe = vi.fn(async () => ({
			entryNames: ['agent-vm-host-probe.txt'],
			probeKind: 'controller_cache_dir_listing' as const,
		}));
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_host_action',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerHostActions: createAuthorizedControllerHostActions(pushZoneGit, {
					runControllerHostProbe,
				}),
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
					actionId: 'controller_host_probe',
					...callerContextPayload,
					correlation: {
						capability: {
							name: 'controller_host_probe',
							namespace: 'controller_host_action',
						},
					},
				},
			},
		});

		expect(pushZoneGit).not.toHaveBeenCalled();
		expect(runControllerHostProbe).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
			}),
			payload: {
				actionId: 'controller_host_probe',
				...callerContextPayload,
				correlation: {
					capability: {
						name: 'controller_host_probe',
						namespace: 'controller_host_action',
					},
				},
			},
			session: acceptedSession,
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_host_action',
			payload: {
				controllerHostAction: {
					actionId: 'controller_host_probe',
					result: {
						entryNames: ['agent-vm-host-probe.txt'],
						probeKind: 'controller_cache_dir_listing',
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerHostActions: {
					authorizeControllerHostAction,
					pushZoneGit,
					runControllerHostProbe: vi.fn(async () => ({
						entryNames: ['agent-vm-host-probe.txt'],
						probeKind: 'controller_cache_dir_listing' as const,
					})),
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
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
