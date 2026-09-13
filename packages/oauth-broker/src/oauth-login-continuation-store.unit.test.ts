import { describe, expect, it } from 'vitest';

import { createOAuthLoginContinuationStore } from './oauth-login-continuation-store.js';

const identity = {
	issuer: 'https://clerk.example.test',
	userId: 'user_owner',
	sessionId: 'sess_owner',
};

describe('bounded OAuth login continuations', () => {
	it('pins the person, not the replaced session, before Google sign-in', () => {
		const store = createOAuthLoginContinuationStore();
		const created = store.create({ kind: 'agents' });
		if (created.kind !== 'created') throw new Error('Expected continuation');
		expect(store.bindExpectedIdentity({ ...created, identity })).toBe(true);
		expect(store.bindExpectedIdentity({ ...created, identity })).toBe(true);
		expect(
			store.bindExpectedIdentity({ ...created, identity: { ...identity, userId: 'other' } }),
		).toBe(false);
		expect(store.consume({ ...created, identity: { ...identity, userId: 'other' } })).toEqual({
			kind: 'identity-mismatch',
		});
		expect(
			store.consume({ ...created, identity: { ...identity, sessionId: 'new-session' } }).kind,
		).toBe('accepted');
	});
	it('cannot bind a missing, expired or wrong-browser continuation', () => {
		let now = 0;
		const store = createOAuthLoginContinuationStore({ now: () => now });
		const created = store.create({ kind: 'agents' });
		if (created.kind !== 'created') throw new Error('Expected continuation');
		expect(
			store.bindExpectedIdentity({ ...created, identity, browserBindingSecret: 'x'.repeat(43) }),
		).toBe(false);
		now = created.expiresAtMs;
		expect(store.bindExpectedIdentity({ ...created, identity })).toBe(false);
	});
	it('keeps a server-owned destination out of external login URLs and consumes once', () => {
		// Arrange
		const store = createOAuthLoginContinuationStore({ now: () => 1000 });
		const created = store.create({ kind: 'agents' });
		if (created.kind !== 'created') throw new Error('Expected continuation');
		// Act
		const result = store.consume({ ...created, identity });
		// Assert
		expect(created.continuationId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(created.browserBindingSecret).not.toBe(created.continuationId);
		expect(result).toEqual({ kind: 'accepted', target: { kind: 'agents' }, identity });
		expect(store.consume({ ...created, identity })).toEqual({ kind: 'missing' });
	});

	it('rejects the wrong browser without consuming the real continuation', () => {
		// Arrange
		const store = createOAuthLoginContinuationStore();
		const created = store.create({ kind: 'agents' });
		if (created.kind !== 'created') throw new Error('Expected continuation');
		// Act / Assert
		expect(store.consume({ ...created, identity, browserBindingSecret: 'x'.repeat(43) })).toEqual({
			kind: 'browser-mismatch',
		});
		expect(store.consume({ ...created, identity }).kind).toBe('accepted');
	});

	it('bounds capacity and expires without a background timer', () => {
		// Arrange
		let now = 1000;
		const store = createOAuthLoginContinuationStore({ now: () => now, capacity: 1 });
		const created = store.create({ kind: 'agents' });
		if (created.kind !== 'created') throw new Error('Expected continuation');
		expect(store.create({ kind: 'agents' })).toEqual({ kind: 'capacity-exhausted' });
		// Act
		now = created.expiresAtMs;
		// Assert
		expect(store.consume({ ...created, identity })).toEqual({ kind: 'expired' });
		expect(store.create({ kind: 'agents' }).kind).toBe('created');
	});

	it('clears all login continuations at restart or admission shutdown', () => {
		// Arrange
		const store = createOAuthLoginContinuationStore();
		const created = store.create({ kind: 'agents' });
		if (created.kind !== 'created') throw new Error('Expected continuation');
		// Act
		store.clear();
		// Assert
		expect(store.consume({ ...created, identity })).toEqual({ kind: 'missing' });
	});

	it('copies the target so a caller cannot change a pending destination', () => {
		// Arrange
		const store = createOAuthLoginContinuationStore();
		const target = {
			kind: 'account' as const,
			agentId: 'ember',
			accountId: '11111111-1111-4111-8111-111111111111',
		};
		const created = store.create(target);
		if (created.kind !== 'created') throw new Error('Expected continuation');
		// Act
		target.agentId = 'sun';
		// Assert
		expect(store.consume({ ...created, identity })).toMatchObject({ target: { agentId: 'ember' } });
	});

	it('refuses arbitrary return URLs rather than making an open redirect', () => {
		// Arrange
		const store = createOAuthLoginContinuationStore();
		// Act / Assert
		expect(() => store.create({ kind: 'agents', returnTo: 'https://evil.example' })).toThrow();
	});
});
