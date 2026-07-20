import { createHmac } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	deriveGatewayControlStablePrincipal,
	type GatewayControlCallerContextProofPayloadInput,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlLeaseSnapshot,
	type GatewayControlLeaseUseSnapshot,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import { TEST_SSH_SERVER_HOST_KEY } from '../../testing/managed-vm-test-helpers.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { createControlSessionDispatcher } from './control-session-dispatcher.js';
import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import {
	createGatewayControlDomainHandler,
	type GatewayControlLeaseRpcOperations,
} from './gateway-control-domain-handler.js';
import {
	createGatewaySemanticResultLedger,
	type GatewaySemanticExecutionProof,
	type GatewaySemanticResultLedger,
} from './gateway-semantic-result-ledger.js';

const gateway = {
	bootId: 'gateway-process-a',
	controllerEpoch: 'controller-a',
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: 'zone-a',
} satisfies GatewayEpochIdentity;

const acceptedSession = {
	bootId: gateway.bootId,
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: gateway.controllerEpoch,
	peerId: 'gateway-zone-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: gateway.zoneId,
};

const callerContextId = '44444444-4444-4444-8444-444444444444';
const callerContextProofKey = 'test-caller-context-proof-key-with-enough-length';
const agentAuthorityKey = 'test-main-agent-authority-key-with-enough-length';
const invocationPrincipal = {
	agentId: 'main',
	frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
	profileAssignmentRevision: 'assignment-main',
	toolPortalProfileId: 'standard',
} as const;
const stablePrincipal = deriveGatewayControlStablePrincipal({
	principal: invocationPrincipal,
});

type ExpectedLeaseRpcSurface = 'getLease' | 'prepareSemanticMutation';

const leaseRpcHasNoDirectMutationMethods: Exclude<
	keyof GatewayControlLeaseRpcOperations,
	ExpectedLeaseRpcSurface
> extends never
	? true
	: false = true;
const leaseRpcHasEveryHardCutMethod: Exclude<
	ExpectedLeaseRpcSurface,
	keyof GatewayControlLeaseRpcOperations
> extends never
	? true
	: false = true;

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
	zoneId: gateway.zoneId,
} satisfies GatewayControlLeaseSnapshot;

const activeUseSnapshot = {
	expiresAt: 120_000,
	heartbeatAfterMs: 30_000,
	leaseId: leaseSnapshot.leaseId,
	state: 'active',
	useId: '01890f00-0000-4000-8000-000000000000',
} satisfies GatewayControlLeaseUseSnapshot;

function signCallerContextEvidence(
	evidence: GatewayControlCallerContextProofPayloadInput,
): GatewayControlCallerContextRegisterPayload['adapterEvidence'] {
	return {
		...evidence,
		agentAuthority: {
			algorithm: 'hmac-sha256',
			digest: createHmac('sha256', agentAuthorityKey)
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

function createRegisteredCallerContexts(
	session: typeof acceptedSession = acceptedSession,
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	const callerContexts = createGatewayControlCallerContextRegistry({
		agentAuthorityKeys: { main: agentAuthorityKey },
		callerContextProofKey,
		createCallerContextId: () => callerContextId,
		validateRegistration: () => {},
	});
	callerContexts.register({
		payload: {
			adapterEvidence: signCallerContextEvidence({
				principal: invocationPrincipal,
				zoneId: gateway.zoneId,
			}),
		},
		session,
	});
	return callerContexts;
}

function commandEnvelope(
	operation: keyof typeof gatewayControlDeliveryPolicyByOperation,
	overrides: Partial<ControlEnvelope> = {},
): ControlEnvelope {
	return {
		bootId: gateway.bootId,
		commandId: '55555555-5555-4555-8555-555555555555',
		connectionId: acceptedSession.connectionId,
		controllerEpoch: gateway.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: gatewayControlDeliveryPolicyByOperation[operation],
		domain: 'gateway_control',
		expiresAtMs: 60_000,
		idempotencyKey: `${operation}-idempotency`,
		kind: 'command',
		messageId: '66666666-6666-4666-8666-666666666666',
		operation,
		peerId: acceptedSession.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: 2,
		sessionId: acceptedSession.sessionId,
		zoneId: gateway.zoneId,
		...overrides,
	};
}

function leaseCreateMessage(idleTtlHintMs?: number): unknown {
	return {
		kind: 'command',
		operation: 'lease_create',
		payload: {
			callerContext: { callerContextId },
			...(idleTtlHintMs === undefined ? {} : { idleTtlHintMs }),
		},
	};
}

function activeUseStartMessage(): unknown {
	return {
		kind: 'command',
		operation: 'lease_use_start',
		payload: {
			callerContext: { callerContextId },
			leaseId: leaseSnapshot.leaseId,
			useId: activeUseSnapshot.useId,
		},
	};
}

function createSemanticDispatcher(
	leaseRpc: GatewayControlLeaseRpcOperations,
	options: {
		readonly semanticLedger?: GatewaySemanticResultLedger;
		readonly session?: typeof acceptedSession;
	} = {},
): ReturnType<typeof createControlSessionDispatcher> {
	const session = options.session ?? acceptedSession;
	const dispatcher = createControlSessionDispatcher({
		semanticLedger:
			options.semanticLedger ?? createGatewaySemanticResultLedger({ gateway, nowMs: () => 1 }),
	});
	dispatcher.register(
		'gateway_control',
		createGatewayControlDomainHandler({
			callerContexts: createRegisteredCallerContexts(session),
			gateway,
			leaseRpc,
			session,
		}),
	);
	return dispatcher;
}

describe('gateway control lease semantic mutations', () => {
	it('hard-cuts the lease RPC surface to semantic preparation plus direct reads', () => {
		expect(leaseRpcHasNoDirectMutationMethods).toBe(true);
		expect(leaseRpcHasEveryHardCutMethod).toBe(true);
	});

	it('reuses the lease_create semantic result across S2 with fresh response correlation', async () => {
		const execute = vi.fn(async (_proof: GatewaySemanticExecutionProof) => leaseSnapshot);
		const prepareSemanticMutation = vi.fn(async () => ({
			execute,
			profile: {
				compatibilityId: 'compatibility-a',
				currentLeafTargetId: null,
				kind: 'lease_authority' as const,
				stablePrincipal,
			},
			target: 'agent:main',
		}));
		const leaseRpc = {
			getLease: vi.fn(),
			prepareSemanticMutation,
		} satisfies GatewayControlLeaseRpcOperations;
		const semanticLedger = createGatewaySemanticResultLedger({ gateway, nowMs: () => 1 });
		const firstDispatcher = createSemanticDispatcher(leaseRpc, { semanticLedger });
		const retrySession = {
			...acceptedSession,
			connectionId: '77777777-7777-4777-8777-777777777777',
			sessionId: '99999999-9999-4999-8999-999999999999',
		};
		const retryDispatcher = createSemanticDispatcher(leaseRpc, {
			semanticLedger,
			session: retrySession,
		});
		const firstEnvelope = commandEnvelope('lease_create');
		const retryEnvelope = commandEnvelope('lease_create', {
			connectionId: '77777777-7777-4777-8777-777777777777',
			messageId: '88888888-8888-4888-8888-888888888888',
			sessionId: '99999999-9999-4999-8999-999999999999',
		});

		const firstResult = await firstDispatcher.dispatch({
			attachmentGeneration: 7,
			envelope: firstEnvelope,
			payload: leaseCreateMessage(),
		});
		const retryResult = await retryDispatcher.dispatch({
			attachmentGeneration: 8,
			envelope: retryEnvelope,
			payload: leaseCreateMessage(),
		});

		expect(firstResult).toMatchObject({
			operation: 'lease_create',
			payload: {
				lease: leaseSnapshot,
				responseToMessageId: firstEnvelope.messageId,
				result: 'ok',
			},
		});
		expect(retryResult).toMatchObject({
			operation: 'lease_create',
			payload: {
				lease: leaseSnapshot,
				responseToMessageId: retryEnvelope.messageId,
				result: 'ok',
			},
		});
		expect(prepareSemanticMutation).toHaveBeenCalledTimes(2);
		expect(prepareSemanticMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				attachmentGeneration: 7,
				callerContext: expect.objectContaining({ stablePrincipal }),
				gateway,
				operation: 'lease_create',
				processEpoch: gateway.bootId,
			}),
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(execute.mock.calls[0]?.[0].identity).toMatchObject({
			commandId: firstEnvelope.commandId,
			gateway,
			idempotencyKey: firstEnvelope.idempotencyKey,
			operation: 'lease_create',
			profile: {
				compatibilityId: 'compatibility-a',
				currentLeafTargetId: null,
				kind: 'lease_authority',
				stablePrincipal,
			},
			target: 'agent:main',
			validUntilMs: firstEnvelope.expiresAtMs,
		});
		expect(execute.mock.calls[0]?.[0].identity.profile).not.toHaveProperty('sessionId');
		expect(execute.mock.calls[0]?.[0].identity.profile).not.toHaveProperty('attachmentGeneration');
	});

	it('uses the active-use generation profile returned by semantic preparation', async () => {
		const execute = vi.fn(async (_proof: GatewaySemanticExecutionProof) => activeUseSnapshot);
		const prepareSemanticMutation = vi.fn(async () => ({
			execute,
			profile: {
				kind: 'active_use' as const,
				leafGeneration: 'tool-generation-a',
				processEpoch: gateway.bootId,
				stablePrincipal,
				useId: activeUseSnapshot.useId,
			},
			target: `${leaseSnapshot.leaseId}/${activeUseSnapshot.useId}`,
		}));
		const dispatcher = createSemanticDispatcher({
			getLease: vi.fn(),
			prepareSemanticMutation,
		});

		await dispatcher.dispatch({
			attachmentGeneration: 11,
			envelope: commandEnvelope('lease_use_start'),
			payload: activeUseStartMessage(),
		});

		expect(prepareSemanticMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				attachmentGeneration: 11,
				gateway,
				operation: 'lease_use_start',
				processEpoch: gateway.bootId,
			}),
		);
		expect(execute.mock.calls[0]?.[0].identity.profile).toEqual({
			kind: 'active_use',
			leafGeneration: 'tool-generation-a',
			processEpoch: gateway.bootId,
			stablePrincipal,
			useId: activeUseSnapshot.useId,
		});
	});

	it('refuses changed payload meaning for the same semantic correlation', async () => {
		const execute = vi.fn(async (_proof: GatewaySemanticExecutionProof) => leaseSnapshot);
		const leaseRpc = {
			getLease: vi.fn(),
			prepareSemanticMutation: vi.fn(async () => ({
				execute,
				profile: {
					compatibilityId: 'compatibility-a',
					currentLeafTargetId: null,
					kind: 'lease_authority' as const,
					stablePrincipal,
				},
				target: 'agent:main',
			})),
		} satisfies GatewayControlLeaseRpcOperations;
		const dispatcher = createSemanticDispatcher(leaseRpc);

		await dispatcher.dispatch({
			attachmentGeneration: 7,
			envelope: commandEnvelope('lease_create'),
			payload: leaseCreateMessage(60_000),
		});
		await expect(
			dispatcher.dispatch({
				attachmentGeneration: 7,
				envelope: commandEnvelope('lease_create', {
					messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				}),
				payload: leaseCreateMessage(120_000),
			}),
		).resolves.toMatchObject({
			operation: 'lease_create',
			payload: {
				error: { errorClass: 'gateway_semantic_idempotency_collision' },
				responseToMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
				result: 'failed',
			},
		});

		expect(execute).toHaveBeenCalledOnce();
	});

	it.each([
		{
			envelopeOverrides: {},
			label: 'attachment generation',
			omitAttachmentGeneration: true,
		},
		{
			envelopeOverrides: { commandId: undefined },
			label: 'command id',
			omitAttachmentGeneration: false,
		},
		{
			envelopeOverrides: { idempotencyKey: undefined },
			label: 'idempotency key',
			omitAttachmentGeneration: false,
		},
		{
			envelopeOverrides: { expiresAtMs: undefined },
			label: 'semantic expiry',
			omitAttachmentGeneration: false,
		},
	] as const)(
		'refuses a mutation missing $label before execution',
		async ({ envelopeOverrides, omitAttachmentGeneration }) => {
			const execute = vi.fn(async (_proof: GatewaySemanticExecutionProof) => leaseSnapshot);
			const prepareSemanticMutation = vi.fn(async () => ({
				execute,
				profile: {
					compatibilityId: 'compatibility-a',
					currentLeafTargetId: null,
					kind: 'lease_authority' as const,
					stablePrincipal,
				},
				target: 'agent:main',
			}));
			const dispatcher = createSemanticDispatcher({
				getLease: vi.fn(),
				prepareSemanticMutation,
			});

			await expect(
				dispatcher.dispatch({
					...(omitAttachmentGeneration ? {} : { attachmentGeneration: 7 }),
					envelope: commandEnvelope('lease_create', envelopeOverrides),
					payload: leaseCreateMessage(),
				}),
			).rejects.toThrow();
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it('refuses a mutation when the handler exact gateway differs from the ledger gateway', async () => {
		const execute = vi.fn(async (_proof: GatewaySemanticExecutionProof) => leaseSnapshot);
		const leaseRpc = {
			getLease: vi.fn(),
			prepareSemanticMutation: vi.fn(async () => ({
				execute,
				profile: {
					compatibilityId: 'compatibility-a',
					currentLeafTargetId: null,
					kind: 'lease_authority' as const,
					stablePrincipal,
				},
				target: 'agent:main',
			})),
		} satisfies GatewayControlLeaseRpcOperations;
		const mismatchedGateway = { ...gateway, gatewayEpochId: 'gateway-epoch-b' };
		const dispatcher = createControlSessionDispatcher({
			semanticLedger: createGatewaySemanticResultLedger({ gateway, nowMs: () => 1 }),
		});
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				callerContexts: createRegisteredCallerContexts(),
				gateway: mismatchedGateway,
				leaseRpc,
				session: acceptedSession,
			}),
		);

		await expect(
			dispatcher.dispatch({
				attachmentGeneration: 7,
				envelope: commandEnvelope('lease_create'),
				payload: leaseCreateMessage(),
			}),
		).resolves.toMatchObject({
			operation: 'lease_create',
			payload: {
				error: { errorClass: 'gateway_semantic_gateway_mismatch' },
				responseToMessageId: '66666666-6666-4666-8666-666666666666',
				result: 'failed',
			},
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it('keeps lease_get on the direct read path without semantic preparation', async () => {
		const getLease = vi.fn(async () => leaseSnapshot);
		const prepareSemanticMutation = vi.fn();
		const dispatcher = createSemanticDispatcher({ getLease, prepareSemanticMutation });

		const response = await dispatcher.dispatch({
			attachmentGeneration: 7,
			envelope: commandEnvelope('lease_get'),
			payload: {
				kind: 'command',
				operation: 'lease_get',
				payload: {
					callerContext: { callerContextId },
					leaseId: leaseSnapshot.leaseId,
				},
			},
		});

		expect(response).toMatchObject({
			operation: 'lease_get',
			payload: { lease: leaseSnapshot, result: 'ok' },
		});
		expect(getLease).toHaveBeenCalledWith(
			expect.objectContaining({
				callerContext: expect.objectContaining({ stablePrincipal }),
				gateway,
				payload: expect.objectContaining({ leaseId: leaseSnapshot.leaseId }),
			}),
			{ includeSsh: 'private' },
		);
		expect(prepareSemanticMutation).not.toHaveBeenCalled();
	});
});
