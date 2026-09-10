import { describe, expect, it } from 'vitest';

import { createOAuthBrowserNavigationStore } from './oauth-browser-navigation-store.js';

const identity = {
	issuer: 'https://identity.example.test',
	userId: 'owner-one',
	sessionId: 'session-one',
};
describe('bounded post-login navigation context', () => {
	it('requires the browser secret and never renews the fixed expiry on reads', () => {
		let now = 1000;
		const store = createOAuthBrowserNavigationStore({ now: () => now });
		const created = store.create({ identity, target: { kind: 'agents' } });
		if (created.kind !== 'created') throw new Error('Expected navigation context.');
		expect(
			store.read({ contextId: created.contextId, browserBindingSecret: 'wrong' }),
		).toBeUndefined();
		expect(store.read(created)).toMatchObject({ identity, target: { kind: 'agents' } });
		now = created.expiresAtMs;
		expect(store.read(created)).toBeUndefined();
	});
	it('cancels only the matching person and browser session', () => {
		const store = createOAuthBrowserNavigationStore();
		const first = store.create({ identity, target: { kind: 'agents' } });
		const second = store.create({
			identity: { ...identity, sessionId: 'session-two' },
			target: { kind: 'agents' },
		});
		if (first.kind !== 'created' || second.kind !== 'created')
			throw new Error('Expected contexts.');
		store.cancelSession(identity);
		expect(store.read(first)).toBeUndefined();
		expect(store.read(second)).toBeDefined();
	});
	it('fails bounded capacity without evicting another active browser', () => {
		const store = createOAuthBrowserNavigationStore({ capacity: 1 });
		const first = store.create({ identity, target: { kind: 'agents' } });
		if (first.kind !== 'created') throw new Error('Expected context.');
		expect(store.create({ identity, target: { kind: 'agents' } })).toEqual({
			kind: 'capacity-exhausted',
		});
		expect(store.read(first)).toBeDefined();
	});
});
