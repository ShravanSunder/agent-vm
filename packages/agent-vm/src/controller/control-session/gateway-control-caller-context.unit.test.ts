import { createHmac } from 'node:crypto';

import {
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

function signRegisterPayload(
	payload: Omit<GatewayControlCallerContextRegisterPayload['adapterEvidence'], 'proof'>,
): GatewayControlCallerContextRegisterPayload {
	return {
		adapterEvidence: {
			...payload,
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
		Omit<GatewayControlCallerContextRegisterPayload['adapterEvidence'], 'proof'>
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
});
