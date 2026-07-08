import { createHmac } from 'node:crypto';

import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextRegisterPayload,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import {
	createGatewayControlCallerContextRegistry,
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
	} = {},
): ReturnType<typeof createGatewayControlCallerContextRegistry> {
	return createGatewayControlCallerContextRegistry({
		agentAuthorityKeys,
		callerContextProofKey,
		...options,
	});
}

describe('gateway control caller context registry', () => {
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
