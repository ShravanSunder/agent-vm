import { createHmac } from 'node:crypto';

import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextRegisterPayload,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import {
	createGatewayControlCallerContextRegistry,
	deriveGatewayControlStablePrincipal,
	digestGatewayControlSessionKey,
} from './gateway-control-caller-context.js';

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
				digest: createHmac('sha256', agentAuthorityKeys[payload.agentId] ?? 'missing')
					.update(buildGatewayControlCallerContextAgentAuthorityPayload(payload), 'utf8')
					.digest('base64url'),
				keyId: payload.agentId,
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
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/workspace',
		sessionKey: 'agent:main:test-session',
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
		zoneId: 'zone-a',
		...overrides,
	});
}

const registerPayload = createRegisterPayload();

function createRegistry(
	options: {
		readonly createCallerContextId?: () => string;
		readonly maxContexts?: number;
		readonly now?: () => number;
		readonly ttlMs?: number;
	} = {},
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	return createGatewayControlCallerContextRegistry({
		agentAuthorityKeys,
		callerContextProofKey,
		...options,
	});
}

describe('gateway control caller context registry', () => {
	it('derives a stable principal from controller-validated zone and agent identity', () => {
		const principal = deriveGatewayControlStablePrincipal({ agentId: 'main', zoneId: 'zone-a' });

		expect(principal).toMatch(/^[a-f0-9]{64}$/u);
		expect(deriveGatewayControlStablePrincipal({ agentId: 'main', zoneId: 'zone-a' })).toBe(
			principal,
		);
		expect(deriveGatewayControlStablePrincipal({ agentId: 'other', zoneId: 'zone-a' })).not.toBe(
			principal,
		);
		expect(deriveGatewayControlStablePrincipal({ agentId: 'main', zoneId: 'zone-b' })).not.toBe(
			principal,
		);
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
			agentWorkspaceDir: '/home/openclaw/workspace',
			bootId: 'boot-a',
			connectionId: 'connection-a',
			controllerEpoch: 'epoch-a',
			peerId: 'gateway-zone-a',
			purpose: 'tool_vm_lease',
			sessionId: 'session-a',
			sessionKeyDigest: digestGatewayControlSessionKey('agent:main:test-session'),
			stablePrincipal: deriveGatewayControlStablePrincipal({
				agentId: 'main',
				zoneId: 'zone-a',
			}),
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		});
		expect(JSON.stringify(validation)).not.toContain('agent:main:test-session');
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
		const signedPayload = createRegisterPayload({
			sessionKey: 'agent:main:original-session',
		});
		const wrongAgentAuthorityPayload = {
			adapterEvidence: {
				...registerPayload.adapterEvidence,
				agentAuthority: {
					algorithm: 'hmac-sha256',
					digest: createHmac('sha256', 'test-other-agent-authority-key')
						.update(
							buildGatewayControlCallerContextAgentAuthorityPayload({
								...registerPayload.adapterEvidence,
								agentId: 'other-agent',
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
						sessionKey: 'agent:main:forged-session',
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
	});

	it('issues an opaque context id and stores only a sessionKey digest', () => {
		const registry = createRegistry({
			createCallerContextId: () => '44444444-4444-4444-8444-444444444444',
		});

		const context = registry.register({
			payload: registerPayload,
			session: acceptedSession,
		});

		expect(context).toEqual({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/workspace',
			bootId: 'boot-a',
			callerContextId: '44444444-4444-4444-8444-444444444444',
			connectionId: 'connection-a',
			controllerEpoch: 'epoch-a',
			peerId: 'gateway-zone-a',
			purpose: 'tool_vm_lease',
			sessionId: 'session-a',
			sessionKeyDigest: digestGatewayControlSessionKey('agent:main:test-session'),
			stablePrincipal: deriveGatewayControlStablePrincipal({
				agentId: 'main',
				zoneId: 'zone-a',
			}),
			workMountDir: '/home/openclaw/.openclaw/state/sandboxes/main/work',
			zoneId: 'zone-a',
		});
		expect(JSON.stringify(context)).not.toContain('agent:main:test-session');
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
			payload: {
				...createRegisterPayload({ sessionKey: 'agent:main:second-session' }),
			},
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
				payload: createRegisterPayload({ sessionKey: 'agent:main:second-session' }),
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

	it('rejects registration evidence with a malformed session key', () => {
		const registry = createRegistry();

		expect(() =>
			registry.register({
				payload: {
					adapterEvidence: {
						...registerPayload.adapterEvidence,
						sessionKey: 'not-agent-shaped',
					},
				},
				session: acceptedSession,
			}),
		).toThrow(/sessionKey is not agent-shaped/u);
	});

	it('rejects registration evidence when agentId does not match the session key', () => {
		const registry = createRegistry();

		expect(() =>
			registry.register({
				payload: {
					adapterEvidence: {
						...registerPayload.adapterEvidence,
						agentId: 'other-agent',
					},
				},
				session: acceptedSession,
			}),
		).toThrow(/agentId does not match sessionKey agent/u);
	});

	it('rejects HMAC-signed evidence when the session key suffix is changed after signing', () => {
		const registry = createRegistry();
		const signedPayload = createRegisterPayload({
			sessionKey: 'agent:main:original-session',
		});

		expect(() =>
			registry.register({
				payload: {
					adapterEvidence: {
						...signedPayload.adapterEvidence,
						sessionKey: 'agent:main:forged-session',
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
										agentId: 'other-agent',
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
