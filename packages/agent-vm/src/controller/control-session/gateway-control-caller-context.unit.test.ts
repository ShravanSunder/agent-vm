import { createHmac } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	deriveGatewayControlStablePrincipal,
	type GatewayControlCallerContextRegisterPayload,
	GatewayControlRpcMessageSchema,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import { createGatewayControlCallerContextRegistry } from './gateway-control-caller-context.js';
import { resolveGatewayControlInboundStablePrincipal } from './gateway-control-domain-handler.js';

const acceptedSession = {
	bootId: 'boot-a',
	connectionId: 'connection-a',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	sessionId: 'session-a',
	zoneId: 'zone-a',
};

const callerContextProofKey = 'test-caller-context-proof-key-with-enough-length';
const agentAuthorityKeys: Readonly<Record<string, string>> = {
	main: 'test-main-agent-authority-key-with-enough-length',
};
const invocationPrincipal = {
	agentId: 'main',
	frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
	profileAssignmentRevision: 'assignment-a',
	toolPortalProfileId: 'engineering',
} as const;

function signRegisterPayload(
	payload: Omit<
		GatewayControlCallerContextRegisterPayload['adapterEvidence'],
		'agentAuthority' | 'proof'
	>,
): GatewayControlCallerContextRegisterPayload {
	return {
		adapterEvidence: {
			...payload,
			agentAuthority: {
				algorithm: 'hmac-sha256',
				digest: createHmac('sha256', agentAuthorityKeys[payload.principal.agentId] ?? 'missing')
					.update(buildGatewayControlCallerContextAgentAuthorityPayload(payload), 'utf8')
					.digest('base64url'),
				keyId: payload.principal.agentId,
			},
			proof: {
				algorithm: 'hmac-sha256',
				digest: createHmac('sha256', callerContextProofKey)
					.update(buildGatewayControlCallerContextProofPayload(payload), 'utf8')
					.digest('base64url'),
			},
		},
	};
}

function createRegisterPayload(
	overrides: Partial<
		Omit<GatewayControlCallerContextRegisterPayload['adapterEvidence'], 'agentAuthority' | 'proof'>
	> = {},
): GatewayControlCallerContextRegisterPayload {
	return signRegisterPayload({
		principal: invocationPrincipal,
		zoneId: 'zone-a',
		...overrides,
	});
}

const registerPayload = createRegisterPayload();

const approvalIntent = {
	backendKind: 'mcp_provider',
	call: {
		arguments: { issueTitle: 'Require operator approval' },
		id: 'github.create_issue',
		name: 'create_issue',
		namespace: 'github',
	},
	operationId: '11111111-1111-4111-8111-111111111111',
	semanticRevisions: {
		activeRevision: 'active-1',
		bindingRevision: 'binding-1',
		catalogRevision: 'catalog-1',
		profilePolicyRevision: 'policy-1',
		providerRevision: 'provider-1',
		schemaRevision: 'schema-1',
	},
	surfaceClass: 'mcp',
	trustedContext: {
		correlation: {
			runId: 'run-main',
			sessionId: 'session-main',
			toolCallId: 'tool-call-main',
		},
		principal: invocationPrincipal,
		requester: { authenticatedSubjectId: 'subject-main' },
	},
} as const;

const controllerIssuedReservation = {
	approvalId: '22222222-2222-4222-8222-222222222222',
	authorityContext: {
		controllerEpoch: acceptedSession.controllerEpoch,
		frameworkEpoch: acceptedSession.bootId,
		gatewayEpoch: 'gateway-epoch-a',
		runtimeEpoch: 'runtime-epoch-a',
		zoneId: acceptedSession.zoneId,
	},
	backendKind: 'mcp_provider',
	expiresAt: '2026-07-13T16:05:00.000Z',
	fingerprint: `sha256:${'a'.repeat(64)}`,
	operationId: approvalIntent.operationId,
	reservationId: '33333333-3333-4333-8333-333333333333',
	stablePrincipal: deriveGatewayControlStablePrincipal({
		principal: approvalIntent.trustedContext.principal,
	}),
} as const;

function createInboundEnvelope(operation: string, sequence: number): ControlEnvelope {
	return {
		bootId: acceptedSession.bootId,
		commandId: `55555555-5555-4555-8555-${String(sequence).padStart(12, '0')}`,
		connectionId: acceptedSession.connectionId,
		controllerEpoch: acceptedSession.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: 'critical_idempotent',
		domain: 'gateway_control',
		idempotencyKey: `stable-principal-${String(sequence)}`,
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

function createRegistry(
	options: {
		readonly createCallerContextId?: () => string;
		readonly maxContexts?: number;
		readonly now?: () => number;
		readonly ttlMs?: number;
		readonly validateRegistration?: () => void;
	} = {},
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	return createGatewayControlCallerContextRegistry({
		agentAuthorityKeys,
		callerContextProofKey,
		validateRegistration: () => {},
		...options,
	});
}

describe('gateway control caller context registry', () => {
	it('resolves the stable agent principal from a valid signed inbound registration', () => {
		const callerContexts = createRegistry();
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'caller_context_register',
			payload: registerPayload,
		});

		expect(
			resolveGatewayControlInboundStablePrincipal({
				callerContexts,
				envelope: createInboundEnvelope('caller_context_register', 1),
				message,
			}),
		).toEqual({
			stablePrincipal: deriveGatewayControlStablePrincipal({
				principal: invocationPrincipal,
			}),
			status: 'accepted',
		});
		expect(callerContexts.resolve('unregistered')).toBeUndefined();
	});

	it('fails closed when trusted principal validation is not configured', () => {
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys,
			callerContextProofKey,
		});

		expect(() =>
			callerContexts.validateRegistrationForSession({
				payload: registerPayload,
				session: acceptedSession,
			}),
		).toThrow(/principal validator is not configured/u);
	});

	it('represents principal-free control commands with an explicit not-required state', () => {
		const callerContexts = createRegistry();
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'control_ping',
			payload: {},
		});

		expect(
			resolveGatewayControlInboundStablePrincipal({
				callerContexts,
				envelope: createInboundEnvelope('control_ping', 1),
				message,
			}),
		).toEqual({ status: 'not_required' });
	});

	it('derives reserve admission from the trusted intent principal', () => {
		// Arrange
		const callerContexts = createRegistry();
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'tool_portal_admission_reserve',
			payload: { intent: approvalIntent },
		});

		// Act
		const resolution = resolveGatewayControlInboundStablePrincipal({
			callerContexts,
			envelope: createInboundEnvelope('tool_portal_admission_reserve', 2),
			message,
		});

		// Assert
		expect(resolution).toEqual({
			stablePrincipal: deriveGatewayControlStablePrincipal({
				principal: approvalIntent.trustedContext.principal,
			}),
			status: 'accepted',
		});
	});

	it('uses the controller-issued reservation principal for arm and rejects public authority injection', () => {
		// Arrange
		const callerContexts = createRegistry();
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'tool_portal_dispatch_arm',
			payload: { reservation: controllerIssuedReservation },
		});
		const publicAuthorityInjection = 'f'.repeat(64);

		// Act
		const resolution = resolveGatewayControlInboundStablePrincipal({
			callerContexts,
			envelope: createInboundEnvelope('tool_portal_dispatch_arm', 3),
			message,
		});
		const injectedMessage = GatewayControlRpcMessageSchema.safeParse({
			kind: 'command',
			operation: 'tool_portal_dispatch_arm',
			payload: {
				admissionPrincipal: publicAuthorityInjection,
				reservation: controllerIssuedReservation,
			},
		});

		// Assert
		expect(injectedMessage.success).toBe(false);
		expect(resolution).toEqual({
			stablePrincipal: controllerIssuedReservation.stablePrincipal,
			status: 'accepted',
		});
	});

	it('resolves a registered callerContextId to the same principal and grants none to invalid material', () => {
		const callerContexts = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const registered = callerContexts.register({
			payload: registerPayload,
			session: acceptedSession,
		});
		const leaseGetMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_get',
			payload: {
				callerContext: { callerContextId: registered.callerContextId },
				leaseId: 'lease-main',
			},
		});
		const unregisteredLeaseGetMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_get',
			payload: {
				callerContext: { callerContextId: '77777777-7777-4777-8777-777777777777' },
				leaseId: 'lease-main',
			},
		});
		const invalidRegistrationMessage = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'caller_context_register',
			payload: {
				adapterEvidence: {
					...registerPayload.adapterEvidence,
					proof: { ...registerPayload.adapterEvidence.proof, digest: 'x'.repeat(43) },
				},
			},
		});

		expect(
			resolveGatewayControlInboundStablePrincipal({
				callerContexts,
				envelope: createInboundEnvelope('lease_get', 2),
				message: leaseGetMessage,
			}),
		).toEqual({ stablePrincipal: registered.stablePrincipal, status: 'accepted' });
		expect(
			resolveGatewayControlInboundStablePrincipal({
				callerContexts,
				envelope: createInboundEnvelope('lease_get', 3),
				message: unregisteredLeaseGetMessage,
			}),
		).toEqual({
			leaseRejectionReason: 'caller_context_absent',
			operation: 'lease_get',
			status: 'lease_rejected',
		});
		expect(() =>
			resolveGatewayControlInboundStablePrincipal({
				callerContexts,
				envelope: createInboundEnvelope('caller_context_register', 4),
				message: invalidRegistrationMessage,
			}),
		).toThrow(/proof digest is invalid/u);
	});

	it('derives stable authority from every principal field independently of optional correlation', () => {
		const stablePrincipal = deriveGatewayControlStablePrincipal({
			principal: invocationPrincipal,
		});

		expect(stablePrincipal).toMatch(/^[a-f0-9]{64}$/u);
		for (const changedPrincipal of [
			{ ...invocationPrincipal, agentId: 'other' },
			{ ...invocationPrincipal, toolPortalProfileId: 'operations' },
			{ ...invocationPrincipal, profileAssignmentRevision: 'assignment-b' },
			{
				...invocationPrincipal,
				frameworkIdentity: { kind: 'hermes' as const, profileName: 'main' },
			},
		]) {
			expect(deriveGatewayControlStablePrincipal({ principal: changedPrincipal })).not.toBe(
				stablePrincipal,
			);
		}
		const registry = createRegistry();
		const withoutCorrelation = registry.validateRegistrationForSession({
			payload: registerPayload,
			session: acceptedSession,
		});
		const withCorrelation = registry.validateRegistrationForSession({
			payload: {
				...registerPayload,
				correlation: {
					sessionKeyDigest: 'a'.repeat(64),
					toolCallId: 'tool-call-other',
				},
			},
			session: acceptedSession,
		});

		expect(withoutCorrelation.stablePrincipal).toBe(stablePrincipal);
		expect(withCorrelation.stablePrincipal).toBe(stablePrincipal);
		expect(withCorrelation.principal).toEqual(withoutCorrelation.principal);
	});

	it('binds every stable principal field into both caller-context HMAC payloads', () => {
		const {
			agentAuthority: _agentAuthority,
			proof: _proof,
			...baselineEvidence
		} = registerPayload.adapterEvidence;
		const baselineProofPayload = buildGatewayControlCallerContextProofPayload(baselineEvidence);
		const baselineAgentAuthorityPayload =
			buildGatewayControlCallerContextAgentAuthorityPayload(baselineEvidence);

		for (const changedPrincipal of [
			{ ...invocationPrincipal, agentId: 'other' },
			{ ...invocationPrincipal, toolPortalProfileId: 'operations' },
			{ ...invocationPrincipal, profileAssignmentRevision: 'assignment-b' },
			{
				...invocationPrincipal,
				frameworkIdentity: { kind: 'hermes' as const, profileName: 'main' },
			},
		]) {
			const changedEvidence = { ...baselineEvidence, principal: changedPrincipal };

			expect(buildGatewayControlCallerContextProofPayload(changedEvidence)).not.toBe(
				baselineProofPayload,
			);
			expect(buildGatewayControlCallerContextAgentAuthorityPayload(changedEvidence)).not.toBe(
				baselineAgentAuthorityPayload,
			);
		}
	});

	it('does not dedupe distinct stable principals in the same accepted session', () => {
		let nextContextId = 0;
		const registry = createRegistry({
			createCallerContextId: () => {
				nextContextId += 1;
				return `44444444-4444-4444-8444-${String(nextContextId).padStart(12, '0')}`;
			},
		});
		const firstContext = registry.register({ payload: registerPayload, session: acceptedSession });
		const secondContext = registry.register({
			payload: createRegisterPayload({
				principal: { ...invocationPrincipal, toolPortalProfileId: 'operations' },
			}),
			session: acceptedSession,
		});

		expect(secondContext.callerContextId).not.toBe(firstContext.callerContextId);
		expect(secondContext.stablePrincipal).not.toBe(firstContext.stablePrincipal);
	});

	it('validates normalized trusted caller claims without allocating or registering a context', () => {
		let createdCallerContextCount = 0;
		const callerContextId = '44444444-4444-4444-8444-444444444444';
		const registry = createRegistry({
			createCallerContextId: () => {
				createdCallerContextCount += 1;
				return callerContextId;
			},
		});

		const validation = registry.validateRegistrationForSession({
			payload: registerPayload,
			session: acceptedSession,
		});

		expect(validation).toEqual({
			agentId: 'main',
			bootId: 'boot-a',
			connectionId: 'connection-a',
			controllerEpoch: 'epoch-a',
			peerId: 'gateway-zone-a',
			principal: invocationPrincipal,
			purpose: 'tool_vm_lease',
			sessionId: 'session-a',
			stablePrincipal: deriveGatewayControlStablePrincipal({
				principal: invocationPrincipal,
			}),
			zoneId: 'zone-a',
		});
		expect(createdCallerContextCount).toBe(0);
		expect(registry.resolve(callerContextId)).toBeUndefined();
	});

	it('rejects untrusted registration claims before mutating the caller-context registry', () => {
		let createdCallerContextCount = 0;
		const callerContextId = '44444444-4444-4444-8444-444444444444';
		const registry = createRegistry({
			createCallerContextId: () => {
				createdCallerContextCount += 1;
				return callerContextId;
			},
			maxContexts: 1,
		});
		const signedPayload = createRegisterPayload();
		const wrongAgentAuthorityPayload = {
			adapterEvidence: {
				...registerPayload.adapterEvidence,
				agentAuthority: {
					algorithm: 'hmac-sha256',
					digest: createHmac('sha256', 'test-other-agent-authority-key')
						.update(
							buildGatewayControlCallerContextAgentAuthorityPayload({
								...registerPayload.adapterEvidence,
								principal: {
									...registerPayload.adapterEvidence.principal,
									agentId: 'other-agent',
								},
							}),
							'utf8',
						)
						.digest('base64url'),
					keyId: 'other-agent',
				},
			},
		} satisfies GatewayControlCallerContextRegisterPayload;

		expect(() =>
			registry.validateRegistrationForSession({
				payload: createRegisterPayload({ zoneId: 'other-zone' }),
				session: acceptedSession,
			}),
		).toThrow(/zoneId mismatch/u);
		expect(() =>
			registry.validateRegistrationForSession({
				payload: {
					adapterEvidence: {
						...signedPayload.adapterEvidence,
						principal: {
							...signedPayload.adapterEvidence.principal,
							toolPortalProfileId: 'forged-profile',
						},
					},
				},
				session: acceptedSession,
			}),
		).toThrow(/proof digest is invalid/u);
		expect(() =>
			registry.validateRegistrationForSession({
				payload: wrongAgentAuthorityPayload,
				session: acceptedSession,
			}),
		).toThrow(/agent authority proof is invalid/u);
		expect(createdCallerContextCount).toBe(0);
		expect(registry.resolve(callerContextId)).toBeUndefined();

		const context = registry.register({ payload: registerPayload, session: acceptedSession });

		expect(context.callerContextId).toBe(callerContextId);
		expect(createdCallerContextCount).toBe(1);
	});

	it('requires fresh validation and registration after the exact control session changes', () => {
		const registry = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const successorSession = {
			...acceptedSession,
			connectionId: 'connection-b',
			sessionId: 'session-b',
		};
		const firstValidation = registry.validateRegistrationForSession({
			payload: registerPayload,
			session: acceptedSession,
		});
		const firstContext = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});

		expect(firstValidation).toMatchObject({
			bootId: 'boot-a',
			connectionId: 'connection-a',
			sessionId: 'session-a',
		});
		expect(
			registry.resolveForSession({
				callerContextId: firstContext.callerContextId,
				session: successorSession,
			}),
		).toEqual({ status: 'session_mismatch' });

		const successorValidation = registry.validateRegistrationForSession({
			payload: registerPayload,
			session: successorSession,
		});

		expect(successorValidation).toMatchObject({
			bootId: 'boot-a',
			connectionId: 'connection-b',
			sessionId: 'session-b',
			stablePrincipal: firstValidation.stablePrincipal,
		});
		expect(firstValidation).not.toEqual(successorValidation);
	});

	it('expires ephemeral caller contexts without extending their original TTL', () => {
		let nowMs = 1_000;
		const registry = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
			now: () => nowMs,
			ttlMs: 10,
		});
		const context = registry.register({ payload: registerPayload, session: acceptedSession });

		nowMs = 1_009;
		expect(registry.resolve(context.callerContextId)).toEqual(context);
		registry.register({ payload: registerPayload, session: acceptedSession });
		nowMs = 1_010;
		expect(registry.resolve(context.callerContextId)).toBeUndefined();
		expect(
			registry.resolveForSession({
				callerContextId: context.callerContextId,
				session: acceptedSession,
			}).status,
		).toBe('stale');
		const expiredLeaseRenew = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'lease_renew',
			payload: {
				callerContext: { callerContextId: context.callerContextId },
				leaseId: 'lease-main',
			},
		});
		expect(
			resolveGatewayControlInboundStablePrincipal({
				callerContexts: registry,
				envelope: createInboundEnvelope('lease_renew', 2),
				message: expiredLeaseRenew,
			}),
		).toEqual({
			leaseRejectionReason: 'caller_context_stale',
			operation: 'lease_renew',
			status: 'lease_rejected',
		});
	});

	it('issues an opaque context id and stores the complete stable principal', () => {
		const registry = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});

		const context = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});

		expect(context).toEqual({
			agentId: 'main',
			bootId: 'boot-a',
			callerContextId: '44444444-4444-4444-8444-444444444444',
			connectionId: 'connection-a',
			controllerEpoch: 'epoch-a',
			peerId: 'gateway-zone-a',
			principal: invocationPrincipal,
			purpose: 'tool_vm_lease',
			sessionId: 'session-a',
			stablePrincipal: deriveGatewayControlStablePrincipal({
				principal: invocationPrincipal,
			}),
			zoneId: 'zone-a',
		});
		expect(registry.resolve(context.callerContextId)).toEqual(context);
	});

	it('does not reuse the same evidence across a new gateway boot', () => {
		let nextContextId = 0;
		const registry = createRegistry({
			createCallerContextId: () => {
				nextContextId += 1;
				return `44444444-4444-4444-8444-${String(nextContextId).padStart(12, '0')}`;
			},
		});

		const firstContext = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});
		const secondContext = registry.register({
			payload: registerPayload,
			session: {
				...acceptedSession,
				bootId: 'boot-b',
			},
		});

		expect(secondContext.callerContextId).not.toBe(firstContext.callerContextId);
		expect(registry.resolve(firstContext.callerContextId)).toBeUndefined();
		expect(registry.resolve(secondContext.callerContextId)).toEqual(secondContext);
	});

	it('does not reuse the same evidence across a new accepted control session', () => {
		let nextContextId = 0;
		const registry = createRegistry({
			createCallerContextId: () => {
				nextContextId += 1;
				return `44444444-4444-4444-8444-${String(nextContextId).padStart(12, '0')}`;
			},
		});

		const firstContext = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});
		const secondContext = registry.register({
			payload: registerPayload,
			session: {
				...acceptedSession,
				connectionId: 'connection-b',
				sessionId: 'session-b',
			},
		});

		expect(secondContext.callerContextId).not.toBe(firstContext.callerContextId);
		expect(registry.resolve(firstContext.callerContextId)).toBeUndefined();
		expect(registry.resolve(secondContext.callerContextId)).toEqual(secondContext);
	});

	it('resolves caller-context ids with typed current-session status', () => {
		let nextContextId = 0;
		const registry = createRegistry({
			createCallerContextId: () => {
				nextContextId += 1;
				return `44444444-4444-4444-8444-${String(nextContextId).padStart(12, '0')}`;
			},
		});
		const firstContext = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});
		const okResolution = registry.resolveForSession({
			callerContextId: firstContext.callerContextId,
			session: acceptedSession,
		});
		const mismatchResolution = registry.resolveForSession({
			callerContextId: firstContext.callerContextId,
			session: {
				...acceptedSession,
				connectionId: 'connection-b',
				sessionId: 'session-b',
			},
		});

		const secondContext = registry.register({
			payload: registerPayload,
			session: {
				...acceptedSession,
				connectionId: 'connection-b',
				sessionId: 'session-b',
			},
		});
		const staleResolution = registry.resolveForSession({
			callerContextId: firstContext.callerContextId,
			session: {
				...acceptedSession,
				connectionId: 'connection-b',
				sessionId: 'session-b',
			},
		});
		const secondResolution = registry.resolveForSession({
			callerContextId: secondContext.callerContextId,
			session: {
				...acceptedSession,
				connectionId: 'connection-b',
				sessionId: 'session-b',
			},
		});
		const absentResolution = registry.resolveForSession({
			callerContextId: '99999999-9999-4999-8999-999999999999',
			session: acceptedSession,
		});

		expect(okResolution).toEqual({ callerContext: firstContext, status: 'ok' });
		expect(mismatchResolution.status).toBe('session_mismatch');
		expect(staleResolution.status).toBe('stale');
		expect(secondResolution).toEqual({ callerContext: secondContext, status: 'ok' });
		expect(absentResolution.status).toBe('absent');
	});

	it('keeps released caller-context ids as bounded stale evidence for lease cleanup', () => {
		const registry = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});
		const context = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});

		registry.release(context.callerContextId);

		expect(
			registry.resolveForSession({
				callerContextId: context.callerContextId,
				session: acceptedSession,
			}).status,
		).toBe('stale');
	});

	it('evicts completed caller contexts so the hard cap is not a steady-state failure', () => {
		let nextContextId = 0;
		const registry = createRegistry({
			createCallerContextId: () => {
				nextContextId += 1;
				return `44444444-4444-4444-8444-${String(nextContextId).padStart(12, '0')}`;
			},
			maxContexts: 1,
		});

		const firstContext = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});
		registry.release(firstContext.callerContextId);

		const secondContext = registry.register({
			payload: createRegisterPayload({
				principal: { ...invocationPrincipal, toolPortalProfileId: 'operations' },
			}),
			session: acceptedSession,
		});

		expect(secondContext.callerContextId).not.toBe(firstContext.callerContextId);
		expect(registry.resolve(firstContext.callerContextId)).toBeUndefined();
	});

	it('dedupes the same evidence within the accepted session', () => {
		const registry = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});

		const firstContext = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});
		const secondContext = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});

		expect(secondContext.callerContextId).toBe(firstContext.callerContextId);
	});

	it('rejects new caller contexts after the registry cap is reached', () => {
		const registry = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
			maxContexts: 1,
		});

		registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});

		expect(() =>
			registry.register({
				payload: createRegisterPayload({
					principal: { ...invocationPrincipal, toolPortalProfileId: 'operations' },
				}),
				session: acceptedSession,
			}),
		).toThrow(/caller context registry limit exceeded/u);
	});

	it('rejects registration evidence for a different zone', () => {
		const registry = createRegistry();

		expect(() =>
			registry.register({
				payload: createRegisterPayload({ zoneId: 'other-zone' }),
				session: acceptedSession,
			}),
		).toThrow(/zoneId mismatch/u);
	});

	it('rejects HMAC-signed evidence when a principal field is changed after signing', () => {
		const registry = createRegistry();
		const signedPayload = createRegisterPayload();

		expect(() =>
			registry.register({
				payload: {
					adapterEvidence: {
						...signedPayload.adapterEvidence,
						principal: {
							...signedPayload.adapterEvidence.principal,
							toolPortalProfileId: 'profile-forged',
						},
					},
				},
				session: acceptedSession,
			}),
		).toThrow(/proof digest is invalid/u);
	});

	it('rejects caller context registration when the per-agent authority proof is missing', () => {
		const registry = createRegistry();
		const { agentAuthority: _agentAuthority, ...adapterEvidenceWithoutAuthority } =
			registerPayload.adapterEvidence;

		expect(() =>
			registry.register({
				payload: {
					adapterEvidence: adapterEvidenceWithoutAuthority,
				} as unknown as GatewayControlCallerContextRegisterPayload,
				session: acceptedSession,
			}),
		).toThrow();
	});

	it('rejects caller context registration when the per-agent authority proof is for another agent', () => {
		const registry = createRegistry();

		expect(() =>
			registry.register({
				payload: {
					adapterEvidence: {
						...registerPayload.adapterEvidence,
						agentAuthority: {
							algorithm: 'hmac-sha256',
							digest: createHmac('sha256', 'test-other-agent-authority-key')
								.update(
									buildGatewayControlCallerContextAgentAuthorityPayload({
										...registerPayload.adapterEvidence,
										principal: {
											...registerPayload.adapterEvidence.principal,
											agentId: 'other-agent',
										},
									}),
									'utf8',
								)
								.digest('base64url'),
							keyId: 'other-agent',
						},
					},
				},
				session: acceptedSession,
			}),
		).toThrow(/agent authority proof is invalid/u);
	});
});
