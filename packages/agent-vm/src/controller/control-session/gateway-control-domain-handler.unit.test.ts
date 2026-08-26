import { createHmac } from 'node:crypto';

import { controllerConfiguredCliOperationSchema } from '@agent-vm/config-contracts';
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	deriveGatewayControlStablePrincipal,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlLeaseSnapshot,
	type GatewayControlLeaseUseSnapshot,
	type GatewayControlToolPortalControllerExecutionPayload,
	type GatewayRuntimeReadinessSnapshot,
	GatewayControlRpcMessageSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it, vi } from 'vitest';

import { TEST_SSH_SERVER_HOST_KEY } from '../../testing/managed-vm-test-helpers.js';
import { ConfiguredControllerExecutionError } from '../runner/configured-controller-execution-error.js';
import { WorkspaceGitConflictError } from '../workspace-git/workspace-git-operations.js';
import {
	createControlSessionDispatcher,
	type ControlSessionDispatcher,
} from './control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	type GatewayControlControllerExecutionOperations,
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
const invocationPrincipal = {
	agentId: 'main',
	frameworkIdentity: { kind: 'hermes', profileName: 'main' },
	profileAssignmentRevision: 'assignment-main',
	toolPortalProfileId: 'standard',
} as const;
const stablePrincipal = deriveGatewayControlStablePrincipal({
	principal: invocationPrincipal,
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
		principal: invocationPrincipal,
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
	leafGeneration: 'leaf-generation-main',
	leaseId: 'lease-main',
	ssh: {
		host: 'tool-7.vm.host',
		identityPem: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----',
		knownHostsLine: `tool-7.vm.host ${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}`,
		port: 22,
		user: 'root',
	},
	state: 'idle',
	sshBindingId: 'ssh-binding-main',
	tcpSlot: 7,
	transport: 'ssh-sandbox',
	workdir: '/work',
	zoneId: acceptedSession.zoneId,
} satisfies GatewayControlLeaseSnapshot;

const activeLeaseUseSnapshot = {
	expiresAt: 120_000,
	heartbeatAfterMs: 30_000,
	leaseId: 'lease-main',
	state: 'active',
	useId: '01890f00-0000-4000-8000-000000000000',
} satisfies GatewayControlLeaseUseSnapshot;

const publicLeaseSnapshot = {
	agentId: leaseSnapshot.agentId,
	idleTtlMs: leaseSnapshot.idleTtlMs,
	leaseId: leaseSnapshot.leaseId,
	ssh: {
		host: leaseSnapshot.ssh.host,
		port: leaseSnapshot.ssh.port,
		user: leaseSnapshot.ssh.user,
	},
	state: leaseSnapshot.state,
	tcpSlot: leaseSnapshot.tcpSlot,
	transport: leaseSnapshot.transport,
	workdir: leaseSnapshot.workdir,
	zoneId: leaseSnapshot.zoneId,
} satisfies GatewayControlLeaseSnapshot;

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

function workspaceGitPushControlPayload(
	expectedHead = '0123456789abcdef0123456789abcdef01234567',
): Extract<GatewayControlToolPortalControllerExecutionPayload, { kind: 'registered_action' }> {
	return {
		action: {
			actionId: 'workspace_git_push',
			...callerContextPayload,
			correlation: {
				capability: { name: 'workspace_git_push', namespace: 'controller_execution' },
			},
			expectedHead,
		},
		kind: 'registered_action',
	};
}

function controllerHostProbeControlPayload(): Extract<
	GatewayControlToolPortalControllerExecutionPayload,
	{ kind: 'registered_action' }
> {
	return {
		action: {
			actionId: 'controller_host_probe',
			...callerContextPayload,
			correlation: {
				capability: { name: 'controller_host_probe', namespace: 'controller_execution' },
			},
		},
		kind: 'registered_action',
	};
}

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
		getLease: vi.fn(async (_request, readOptions) =>
			readOptions.includeSsh === 'private' ? leaseSnapshot : publicLeaseSnapshot,
		),
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
	return createGatewayControlDomainHandler({ gateway, now: () => 1, ...options });
}

function createAuthorizedControllerExecutions(
	pushWorkspaceGit: GatewayControlControllerExecutionOperations['pushWorkspaceGit'],
	overrides: Partial<GatewayControlControllerExecutionOperations> = {},
): GatewayControlControllerExecutionOperations {
	const operation = controllerConfiguredCliOperationSchema.parse({
		calls: { withoutApproval: 'remaining_admitted' },
		commands: [{ path: ['inspect'] }],
		deniedPatterns: [],
		executablePath: '/usr/bin/printf',
		executionTarget: {
			cwd: '/tmp',
			environment: { kind: 'empty' },
			kind: 'controller_host',
		},
		kind: 'configured_cli',
		mandatoryArgvPrefix: [],
		output: {
			modelVisibleStderr: 'none',
			overflow: 'fail',
			stderrMaxBytes: 1_024,
			stdoutMaxBytes: 1_024,
		},
		safeHelp: 'Inspect one host resource.',
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
	});
	const configuredCli = {
		evaluation: {
			authorityKind: 'without_approval' as const,
			bindingRevision: 'binding:current',
			disposition: 'without_approval' as const,
			fingerprint: `sha256:${'d'.repeat(64)}`,
			operationId: '88888888-8888-4888-8888-888888888888',
			operationName: 'inspect_host',
			targetKind: 'controller_host' as const,
		},
		operation,
	};
	return {
		authorizeControllerExecution: vi.fn(async ({ payload }) =>
			payload.kind === 'configured_cli'
				? ({ authorized: true, configuredCli } as const)
				: ({ authorized: true } as const),
		),
		executeConfiguredCli: vi.fn(async () => ({
			exitCode: 0,
			stderrTruncated: false,
			stdout: '',
			stdoutTruncated: false,
		})),
		pushWorkspaceGit,
		runControllerHostProbe: vi.fn(async () => ({
			entryNames: ['agent-vm-host-probe.txt'],
			probeKind: 'controller_cache_dir_listing' as const,
		})),
		...overrides,
	};
}

function createRegisteredCallerContexts(
	options: { readonly purpose?: 'tool_portal_controller_execution' | 'tool_vm_lease' } = {},
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	const callerContexts = createCallerContexts({
		createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
	});
	callerContexts.register({
		payload: {
			adapterEvidence: signCallerContextEvidence({
				principal: callerContextRegisterPayload.adapterEvidence.principal,
				...(options.purpose === undefined ? {} : { purpose: options.purpose }),
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
		validateRegistration: () => {},
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
						principal: invocationPrincipal,
					}),
					callerContextId: '44444444-4444-4444-8444-444444444444',
				},
				responseToMessageId: '22222222-2222-4222-8222-222222222222',
				result: 'ok',
			},
		});
		expect(JSON.stringify(response)).not.toContain('agent:main:test-session');
	});

	it('routes authenticated Tool VM binding demand through exact session authority', async () => {
		const callerContexts = createCallerContexts({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const requestBinding = vi.fn(async () => ({
			agentId: invocationPrincipal.agentId,
			stablePrincipal,
			status: 'publication_pending' as const,
		}));
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				bindingPublication: {
					requestBinding,
					retireBinding: vi.fn(async () => 'publication-applied' as const),
				},
				callerContexts,
				session: acceptedSession,
			}),
		);
		await dispatcher.dispatch({
			envelope: callerContextRegisterEnvelope,
			payload: callerContextRegisterMessage,
		});

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_vm_binding_request'),
			payload: {
				kind: 'command',
				operation: 'tool_vm_binding_request',
				payload: callerContextPayload,
			},
		});

		expect(requestBinding).toHaveBeenCalledWith({
			authority: {
				attachmentGeneration: 1,
				connectionId: acceptedSession.connectionId,
				controllerEpoch: acceptedSession.controllerEpoch,
				gatewayEpoch: gateway.generationId,
				processEpoch: acceptedSession.bootId,
				sessionId: acceptedSession.sessionId,
				zoneId: acceptedSession.zoneId,
			},
			callerContext: expect.objectContaining({
				agentId: invocationPrincipal.agentId,
				stablePrincipal,
			}),
			expiresAtMs: 60_000,
			gateway,
			payload: callerContextPayload,
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_vm_binding_request',
			payload: {
				bindingRequest: {
					agentId: invocationPrincipal.agentId,
					stablePrincipal,
					status: 'publication_pending',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'ok',
			},
		});
	});

	it('returns Tool VM binding demand at command expiry while late work continues', async () => {
		// Arrange
		vi.useFakeTimers();
		vi.setSystemTime(1);
		try {
			const callerContexts = createCallerContexts({
				createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
			});
			const lateBinding = Promise.withResolvers<{
				readonly agentId: string;
				readonly stablePrincipal: string;
				readonly status: 'publication_pending';
			}>();
			const requestBinding = vi.fn(async () => await lateBinding.promise);
			const dispatcher = createGatewayControlTestDispatcher();
			dispatcher.register(
				'gateway_control',
				createTestGatewayControlDomainHandler({
					bindingPublication: {
						requestBinding,
						retireBinding: vi.fn(async () => 'publication-applied' as const),
					},
					callerContexts,
					session: acceptedSession,
				}),
			);
			await dispatcher.dispatch({
				envelope: callerContextRegisterEnvelope,
				payload: callerContextRegisterMessage,
			});
			let responseSettled = false;
			const responsePromise = dispatcher
				.dispatch({
					envelope: createEnvelope('tool_vm_binding_request', { expiresAtMs: 100 }),
					payload: {
						kind: 'command',
						operation: 'tool_vm_binding_request',
						payload: callerContextPayload,
					},
				})
				.then((response) => {
					responseSettled = true;
					return response;
				});
			await vi.advanceTimersByTimeAsync(0);
			expect(requestBinding).toHaveBeenCalledOnce();

			// Act
			await vi.advanceTimersByTimeAsync(99);
			const responseSettledAtCommandExpiry = responseSettled;
			lateBinding.resolve({
				agentId: invocationPrincipal.agentId,
				stablePrincipal,
				status: 'publication_pending',
			});
			const response = await responsePromise;

			// Assert
			expect(responseSettledAtCommandExpiry).toBe(true);
			expect(requestBinding).toHaveBeenCalledWith(expect.objectContaining({ expiresAtMs: 100 }));
			expect(response).toMatchObject({
				operation: 'tool_vm_binding_request',
				payload: {
					error: { errorClass: 'tool_vm_binding_request_expired', retryable: true },
					result: 'timeout',
				},
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects unregistered Tool VM binding demand before controller creation', async () => {
		const requestBinding = vi.fn(async () => ({
			agentId: invocationPrincipal.agentId,
			stablePrincipal,
			status: 'publication_pending' as const,
		}));
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				bindingPublication: {
					requestBinding,
					retireBinding: vi.fn(async () => 'publication-applied' as const),
				},
				callerContexts: createCallerContexts(),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_vm_binding_request'),
			payload: {
				kind: 'command',
				operation: 'tool_vm_binding_request',
				payload: callerContextPayload,
			},
		});

		expect(requestBinding).not.toHaveBeenCalled();
		expect(response).toMatchObject({
			operation: 'tool_vm_binding_request',
			payload: {
				error: { errorClass: 'caller_context_absent', retryable: false },
				result: 'rejected',
			},
		});
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

	it('returns lease reacquire as unknown side effect at command expiry without cancelling it', async () => {
		// Arrange
		vi.useFakeTimers();
		vi.setSystemTime(1);
		try {
			const lateReacquire = Promise.withResolvers<GatewayControlLeaseSnapshot>();
			const reacquireLease = vi.fn(async () => await lateReacquire.promise);
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
			let responseSettled = false;
			const responsePromise = dispatcher
				.dispatch({
					envelope: createEnvelope('lease_reacquire', { expiresAtMs: 100 }),
					payload: {
						kind: 'command',
						operation: 'lease_reacquire',
						payload: {
							...callerContextPayload,
							oldLeaseId: 'lease-main',
							staleEvidence: {
								errorCode: 'ssh-command-failed',
								kind: 'tool-vm-ssh',
								observedAtMs: 1,
								operation: 'file-bridge',
							},
						},
					},
				})
				.then((response) => {
					responseSettled = true;
					return response;
				});
			await vi.advanceTimersByTimeAsync(0);
			expect(reacquireLease).toHaveBeenCalledOnce();

			// Act
			await vi.advanceTimersByTimeAsync(99);
			const responseSettledAtCommandExpiry = responseSettled;
			lateReacquire.resolve(leaseSnapshot);
			const response = await responsePromise;

			// Assert
			expect(responseSettledAtCommandExpiry).toBe(true);
			expect(response).toMatchObject({
				operation: 'lease_reacquire',
				payload: {
					error: { errorClass: 'gateway_semantic_unknown_side_effect' },
					result: 'failed',
				},
			});
		} finally {
			vi.useRealTimers();
		}
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
						agentWorkspaceDir: '/untrusted/workspace',
						profileId: 'standard',
						sessionKey: 'agent:main:test-session',
						workMountDir: '/untrusted/work-mount',
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

	it('records schema-validated Gateway runtime readiness from the accepted control session', async () => {
		const readiness = GatewayControlRpcMessageSchema.parse({
			kind: 'event',
			operation: 'gateway_runtime_readiness',
			payload: {
				controlEndpoint: {
					identity: {
						bootId: 'boot-1',
						controllerEpoch: acceptedSession.controllerEpoch,
						generationId: gateway.generationId,
						peerId: acceptedSession.peerId,
						processEpoch: 'process-epoch-1',
						zoneId: acceptedSession.zoneId,
					},
					listener: {
						host: '127.0.0.1',
						port: 18_790,
						readyPath: '/__agent-vm/ready',
						socketPath: '/__agent-vm/gateway-control',
					},
				},
				kind: 'tool-portal-role-readiness',
				providerRevision: 'provider-1',
				requiredBackends: {
					readyBackendKinds: ['mcp_provider'],
					revision: 'bindings-1',
					status: 'ready',
				},
				semanticRevision: 'semantic-1',
				serviceIdentity: {
					processEpoch: 'process-epoch-1',
					role: 'tool-portal',
					serviceId: 'tool-portal-zone-a',
				},
				snapshotVersion: 1,
				uds: {
					attachment: {
						expected: {
							attachmentGeneration: 1,
							clientKind: 'hermes-managed-plugin',
							configuredAgentIds: ['main'],
							frameworkEpoch: 'framework-epoch-1',
							gatewayEpoch: 'gateway-epoch-1',
							protocolVersion: 1,
							projectionCohortDigest:
								'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							runtimeEpoch: 'runtime-epoch-1',
							schemaVersion: 1,
						},
						observationSequence: 0,
						snapshotVersion: 1,
						status: 'awaiting-attachment',
					},
					publication: {
						identity: 'managed-plugin-private-uds',
						protocolVersion: 1,
						schemaVersion: 1,
						socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
						status: 'published',
					},
				},
			},
		}).payload;
		const recordGatewayRuntimeReadiness =
			vi.fn<(snapshot: GatewayRuntimeReadinessSnapshot) => void>();
		const dispatcher = createControlSessionDispatcher({
			sessionFence: {
				...acceptedSession,
				domain: 'gateway_control',
			},
		});
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
				recordGatewayRuntimeReadiness,
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('gateway_runtime_readiness', {
				deliveryPolicy: 'latest_wins',
				kind: 'event',
			}),
			payload: {
				kind: 'event',
				operation: 'gateway_runtime_readiness',
				payload: readiness,
			},
		});

		expect(response).toBeUndefined();
		expect(recordGatewayRuntimeReadiness).toHaveBeenCalledOnce();
		expect(recordGatewayRuntimeReadiness).toHaveBeenCalledWith(readiness);
		await expect(
			dispatcher.dispatch({
				envelope: createEnvelope('gateway_runtime_readiness', {
					connectionId: '99999999-9999-4999-8999-999999999999',
					deliveryPolicy: 'latest_wins',
					kind: 'event',
				}),
				payload: {
					kind: 'event',
					operation: 'gateway_runtime_readiness',
					payload: readiness,
				},
			}),
		).rejects.toThrow('control session envelope connectionId mismatch');
		expect(recordGatewayRuntimeReadiness).toHaveBeenCalledOnce();

		const dispatcherWithoutRecorder = createControlSessionDispatcher({
			sessionFence: {
				...acceptedSession,
				domain: 'gateway_control',
			},
		});
		dispatcherWithoutRecorder.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
				session: acceptedSession,
			}),
		);
		await expect(
			dispatcherWithoutRecorder.dispatch({
				envelope: createEnvelope('gateway_runtime_readiness', {
					deliveryPolicy: 'latest_wins',
					kind: 'event',
				}),
				payload: {
					kind: 'event',
					operation: 'gateway_runtime_readiness',
					payload: readiness,
				},
			}),
		).resolves.toBeUndefined();
	});

	it('routes tool_portal_controller_execution through the narrow workspace Git push handler', async () => {
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'main',
			localHead: '0123456789abcdef0123456789abcdef01234567',
			pushedCommits: [
				{ sha: '0123456789abcdef0123456789abcdef01234567', subject: 'docs: update memory' },
			],
			remoteHead: '0123456789abcdef0123456789abcdef01234567',
		}));
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_execution',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: {
					action: {
						actionId: 'workspace_git_push',
						...callerContextPayload,
						correlation: {
							capability: {
								name: 'workspace_git_push',
								namespace: 'controller_execution',
							},
						},
						expectedHead: '0123456789abcdef0123456789abcdef01234567',
					},
					kind: 'registered_action',
				},
			},
		});

		expect(pushWorkspaceGit).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
			}),
			payload: {
				actionId: 'workspace_git_push',
				...callerContextPayload,
				correlation: {
					capability: {
						name: 'workspace_git_push',
						namespace: 'controller_execution',
					},
				},
				expectedHead: '0123456789abcdef0123456789abcdef01234567',
			},
			session: acceptedSession,
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_execution',
			payload: {
				controllerExecution: {
					action: {
						actionId: 'workspace_git_push',
						result: {
							branch: 'main',
							localHead: '0123456789abcdef0123456789abcdef01234567',
							pushedCommits: [
								{
									sha: '0123456789abcdef0123456789abcdef01234567',
									subject: 'docs: update memory',
								},
							],
							remoteHead: '0123456789abcdef0123456789abcdef01234567',
						},
					},
					kind: 'registered_action',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'ok',
			},
		});
		expect(callerContexts.resolve('44444444-4444-4444-8444-444444444444')).toBeUndefined();
	});

	it('refuses changed workspace_git_push meaning for the same semantic identity without a second push', async () => {
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'main',
			localHead: '0123456789abcdef0123456789abcdef01234567',
			pushedCommits: [
				{ sha: '0123456789abcdef0123456789abcdef01234567', subject: 'docs: update memory' },
			],
			remoteHead: '0123456789abcdef0123456789abcdef01234567',
		}));
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_execution',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit),
				session: acceptedSession,
			}),
		);
		const semanticEnvelope = createEnvelope('tool_portal_controller_execution', {
			commandId: '77777777-7777-4777-8777-777777777777',
			idempotencyKey: 'workspace-git-push-semantic-identity',
		});

		await dispatcher.dispatch({
			envelope: semanticEnvelope,
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: workspaceGitPushControlPayload(),
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
				operation: 'tool_portal_controller_execution',
				payload: workspaceGitPushControlPayload('fedcba9876543210fedcba9876543210fedcba98'),
			},
		});

		expect(collisionResponse).toMatchObject({
			operation: 'tool_portal_controller_execution',
			payload: {
				error: { errorClass: 'gateway_semantic_idempotency_collision' },
				responseToMessageId: collisionMessageId,
				result: 'failed',
			},
		});
		expect(pushWorkspaceGit).toHaveBeenCalledOnce();
	});

	it('fences a lost workspace_git_push result as unknown without replaying its side effect', async () => {
		let remotePushCount = 0;
		const pushWorkspaceGit = vi.fn(async () => {
			remotePushCount += 1;
			throw new Error('simulated result loss after remote push');
		});
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_execution',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit),
				session: acceptedSession,
			}),
		);
		const semanticEnvelope = createEnvelope('tool_portal_controller_execution', {
			commandId: '99999999-9999-4999-8999-999999999999',
			idempotencyKey: 'workspace-git-push-result-loss',
		});
		const message = {
			kind: 'command' as const,
			operation: 'tool_portal_controller_execution' as const,
			payload: workspaceGitPushControlPayload(),
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
			operation: 'tool_portal_controller_execution',
			payload: {
				error: { errorClass: 'gateway_semantic_unknown_side_effect' },
				responseToMessageId: semanticEnvelope.messageId,
				result: 'failed',
			},
		});
		expect(retryResponse).toMatchObject({
			operation: 'tool_portal_controller_execution',
			payload: {
				error: { errorClass: 'gateway_semantic_unknown_side_effect' },
				responseToMessageId: retryMessageId,
				result: 'failed',
			},
		});
		expect(remotePushCount).toBe(1);
		expect(pushWorkspaceGit).toHaveBeenCalledOnce();
	});

	it('returns a proven pre-dispatch workspace_git_push conflict without replaying it', async () => {
		const pushWorkspaceGit = vi.fn(async () => {
			throw new WorkspaceGitConflictError('Workspace Git local head does not match expectedHead.');
		});
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_execution',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit),
				session: acceptedSession,
			}),
		);
		const semanticEnvelope = createEnvelope('tool_portal_controller_execution', {
			commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			idempotencyKey: 'workspace-git-push-pre-dispatch-conflict',
		});
		const message = {
			kind: 'command' as const,
			operation: 'tool_portal_controller_execution' as const,
			payload: workspaceGitPushControlPayload(),
		};

		const firstResponse = await dispatcher.dispatch({
			envelope: semanticEnvelope,
			payload: message,
		});
		const retryMessageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		const retryResponse = await dispatcher.dispatch({
			envelope: {
				...semanticEnvelope,
				messageId: retryMessageId,
				sequence: semanticEnvelope.sequence + 1,
			},
			payload: message,
		});

		expect(firstResponse).toMatchObject({
			operation: 'tool_portal_controller_execution',
			payload: {
				error: {
					errorClass: 'workspace_git_conflict',
					retryable: false,
					safeMessage: 'Workspace Git push was rejected because repository state changed.',
				},
				responseToMessageId: semanticEnvelope.messageId,
				result: 'rejected',
			},
		});
		expect(retryResponse).toMatchObject({
			operation: 'tool_portal_controller_execution',
			payload: {
				error: { errorClass: 'workspace_git_conflict' },
				responseToMessageId: retryMessageId,
				result: 'rejected',
			},
		});
		expect(pushWorkspaceGit).toHaveBeenCalledOnce();
	});

	it('routes controller_host_probe through the fixed host probe handler without a shell command', async () => {
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'main',
			localHead: '0123456789abcdef0123456789abcdef01234567',
			pushedCommits: [],
			remoteHead: '0123456789abcdef0123456789abcdef01234567',
		}));
		const runControllerHostProbe = vi.fn(async () => ({
			entryNames: ['agent-vm-host-probe.txt'],
			probeKind: 'controller_cache_dir_listing' as const,
		}));
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_execution',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit, {
					runControllerHostProbe,
				}),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: controllerHostProbeControlPayload(),
			},
		});

		expect(pushWorkspaceGit).not.toHaveBeenCalled();
		expect(runControllerHostProbe).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
			}),
			payload: controllerHostProbeControlPayload().action,
			session: acceptedSession,
		});
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_execution',
			payload: {
				controllerExecution: {
					action: {
						actionId: 'controller_host_probe',
						result: {
							entryNames: ['agent-vm-host-probe.txt'],
							probeKind: 'controller_cache_dir_listing',
						},
					},
					kind: 'registered_action',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'ok',
			},
		});
		expect(callerContexts.resolve('44444444-4444-4444-8444-444444444444')).toBeUndefined();
	});

	it('routes configured CLI through the generic controller execution operation', async () => {
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'main',
			localHead: '0123456789abcdef0123456789abcdef01234567',
			pushedCommits: [],
			remoteHead: '0123456789abcdef0123456789abcdef01234567',
		}));
		const executeConfiguredCli = vi.fn(async () => ({
			exitCode: 0,
			stderrTruncated: false,
			stdout: 'configured output',
			stdoutTruncated: false,
		}));
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_execution',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit, {
					executeConfiguredCli,
				}),
				session: acceptedSession,
			}),
		);
		const configuredPayload = {
			...callerContextPayload,
			authority: {
				bindingRevision: 'binding:current',
				fingerprint: `sha256:${'d'.repeat(64)}`,
				kind: 'without_approval' as const,
				operationId: '88888888-8888-4888-8888-888888888888',
			},
			capability: { name: 'inspect_host', namespace: 'controller_execution' },
			correlation: {
				capability: { name: 'inspect_host', namespace: 'controller_execution' },
			},
			input: { argv: ['inspect'], reason: 'domain handler proof' },
			invocation: {
				callId: 'configured-call-a',
				surfaceClass: 'protected_uds' as const,
				trustedContext: { principal: invocationPrincipal },
			},
			kind: 'configured_cli' as const,
			operationName: 'inspect_host',
		};

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: configuredPayload,
			},
		});

		expect(executeConfiguredCli).toHaveBeenCalledWith({
			authorization: expect.objectContaining({
				evaluation: expect.objectContaining({ disposition: 'without_approval' }),
			}),
			callerContext: expect.objectContaining({ agentId: 'main' }),
			createdAtMs: 1,
			expiresAtMs: 60_000,
			payload: configuredPayload,
			session: acceptedSession,
			signal: expect.any(AbortSignal),
		});
		expect(pushWorkspaceGit).not.toHaveBeenCalled();
		expect(response).toMatchObject({
			payload: {
				controllerExecution: {
					kind: 'configured_cli',
					operationName: 'inspect_host',
					result: { exitCode: 0, stdout: 'configured output' },
				},
				result: 'ok',
			},
		});
	});

	it.each([
		{ code: 'not_dispatched' as const, retryable: false },
		{ code: 'runtime_busy' as const, retryable: true },
	])('reports configured CLI $code as a bounded rejected result', async ({ code, retryable }) => {
		const executeConfiguredCli = vi.fn(async () => {
			throw new ConfiguredControllerExecutionError(
				code,
				'Configured controller execution operation is no longer authorized.',
			);
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createRegisteredCallerContexts({
					purpose: 'tool_portal_controller_execution',
				}),
				controllerExecutions: createAuthorizedControllerExecutions(vi.fn(), {
					executeConfiguredCli,
				}),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: {
					...callerContextPayload,
					authority: {
						bindingRevision: 'binding:current',
						fingerprint: `sha256:${'d'.repeat(64)}`,
						kind: 'without_approval',
						operationId: '88888888-8888-4888-8888-888888888888',
					},
					capability: { name: 'inspect_host', namespace: 'controller_execution' },
					correlation: {
						capability: { name: 'inspect_host', namespace: 'controller_execution' },
					},
					input: { argv: ['inspect'], reason: 'final reauthorization denial proof' },
					invocation: {
						callId: 'configured-call-final-denial',
						surfaceClass: 'protected_uds',
						trustedContext: { principal: invocationPrincipal },
					},
					kind: 'configured_cli',
					operationName: 'inspect_host',
				},
			},
		});

		expect(executeConfiguredCli).toHaveBeenCalledTimes(1);
		expect(response).toMatchObject({
			payload: {
				error: { errorClass: `controller_execution_${code}`, retryable },
				result: 'rejected',
			},
		});
	});

	it('aborts configured CLI work when the controller execution window expires', async () => {
		vi.useFakeTimers();
		try {
			const executeConfiguredCli = vi.fn(
				async ({ signal }: { readonly signal: AbortSignal }) =>
					await new Promise<never>((_resolve, reject) => {
						const rejectFromAbort = (): void => reject(signal.reason);
						signal.addEventListener('abort', rejectFromAbort, { once: true });
						if (signal.aborted) rejectFromAbort();
					}),
			);
			const callerContexts = createRegisteredCallerContexts({
				purpose: 'tool_portal_controller_execution',
			});
			const dispatcher = createGatewayControlTestDispatcher();
			dispatcher.register(
				'gateway_control',
				createTestGatewayControlDomainHandler({
					callerContexts,
					controllerExecutions: createAuthorizedControllerExecutions(vi.fn(), {
						executeConfiguredCli,
					}),
					now: () => 1,
					session: acceptedSession,
				}),
			);
			const responsePromise = dispatcher.dispatch({
				envelope: createEnvelope('tool_portal_controller_execution', { expiresAtMs: 100 }),
				payload: {
					kind: 'command',
					operation: 'tool_portal_controller_execution',
					payload: {
						...callerContextPayload,
						authority: {
							bindingRevision: 'binding:current',
							fingerprint: `sha256:${'d'.repeat(64)}`,
							kind: 'without_approval',
							operationId: '88888888-8888-4888-8888-888888888888',
						},
						capability: { name: 'inspect_host', namespace: 'controller_execution' },
						correlation: {
							capability: { name: 'inspect_host', namespace: 'controller_execution' },
						},
						input: { argv: ['inspect'], reason: 'expiry proof' },
						invocation: {
							callId: 'configured-call-a',
							surfaceClass: 'protected_uds',
							trustedContext: { principal: invocationPrincipal },
						},
						kind: 'configured_cli',
						operationName: 'inspect_host',
					},
				},
			});

			await vi.advanceTimersByTimeAsync(99);

			await expect(responsePromise).resolves.toMatchObject({
				payload: {
					error: { errorClass: 'controller_execution_timeout' },
					result: 'timeout',
				},
			});
			expect(executeConfiguredCli).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects tool_portal_controller_execution when callerContextId was registered for a lease', async () => {
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'main',
			localHead: '0123456789abcdef0123456789abcdef01234567',
			pushedCommits: [],
			remoteHead: '0123456789abcdef0123456789abcdef01234567',
		}));
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createRegisteredCallerContexts({ purpose: 'tool_vm_lease' }),
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: workspaceGitPushControlPayload(),
			},
		});

		expect(pushWorkspaceGit).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_execution',
			payload: {
				error: {
					errorClass: 'controller_execution_caller_context_stale',
					retryable: false,
					safeMessage: 'controller execution caller context does not match session',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects tool_portal_controller_execution when no controller handler is configured', async () => {
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: workspaceGitPushControlPayload(),
			},
		});

		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_execution',
			payload: {
				error: {
					errorClass: 'controller_execution_unconfigured',
					retryable: false,
					safeMessage: 'controller execution handler is not configured',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects tool_portal_controller_execution when callerContextId is not registered', async () => {
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'main',
			localHead: '0123456789abcdef0123456789abcdef01234567',
			pushedCommits: [],
			remoteHead: '0123456789abcdef0123456789abcdef01234567',
		}));
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts: createCallerContexts(),
				controllerExecutions: createAuthorizedControllerExecutions(pushWorkspaceGit),
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: workspaceGitPushControlPayload(),
			},
		});

		expect(pushWorkspaceGit).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_execution',
			payload: {
				error: {
					errorClass: 'controller_execution_caller_context_absent',
					retryable: false,
					safeMessage: 'controller execution caller context is not registered',
				},
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'rejected',
			},
		});
	});

	it('rejects tool_portal_controller_execution before push when authorization denies it', async () => {
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'main',
			localHead: '0123456789abcdef0123456789abcdef01234567',
			pushedCommits: [],
			remoteHead: '0123456789abcdef0123456789abcdef01234567',
		}));
		const authorizeControllerExecution = vi.fn(
			async () =>
				({
					authorized: false,
					errorClass: 'controller_execution_policy_denied',
					safeMessage: 'controller execution policy denied the requested capability',
				}) as const,
		);
		const callerContexts = createRegisteredCallerContexts({
			purpose: 'tool_portal_controller_execution',
		});
		const dispatcher = createGatewayControlTestDispatcher();
		dispatcher.register(
			'gateway_control',
			createTestGatewayControlDomainHandler({
				callerContexts,
				controllerExecutions: {
					authorizeControllerExecution,
					executeConfiguredCli: vi.fn(async () => ({
						exitCode: 0,
						stderrTruncated: false,
						stdout: '',
						stdoutTruncated: false,
					})),
					pushWorkspaceGit,
					runControllerHostProbe: vi.fn(async () => ({
						entryNames: ['agent-vm-host-probe.txt'],
						probeKind: 'controller_cache_dir_listing' as const,
					})),
				},
				session: acceptedSession,
			}),
		);

		const response = await dispatcher.dispatch({
			envelope: createEnvelope('tool_portal_controller_execution', {
				deliveryPolicy: 'single_use_critical',
			}),
			payload: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: workspaceGitPushControlPayload(),
			},
		});

		expect(authorizeControllerExecution).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: '44444444-4444-4444-8444-444444444444',
			}),
			createdAtMs: 1,
			expiresAtMs: 60_000,
			payload: workspaceGitPushControlPayload(),
			session: acceptedSession,
		});
		expect(pushWorkspaceGit).not.toHaveBeenCalled();
		expect(response).toEqual({
			kind: 'command_result',
			operation: 'tool_portal_controller_execution',
			payload: {
				error: {
					errorClass: 'controller_execution_policy_denied',
					retryable: false,
					safeMessage: 'controller execution policy denied the requested capability',
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
					action: 'restart_control_service',
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
