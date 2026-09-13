import { describe, expect, it } from 'vitest';

import { resolveGoogleAccountInvocationPolicy } from './google-account-policy.js';

const binding = {
	zoneId: 'apollofam',
	agentId: 'ember',
	accountId: '11111111-1111-4111-8111-111111111111',
	applicationId: 'gmail-app',
	authorizationId: '22222222-2222-4222-8222-222222222222',
	owner: { issuer: 'https://clerk.example.test', userId: 'user_owner' },
};
const inherit = { kind: 'inherit' } as const;

function input(): Parameters<typeof resolveGoogleAccountInvocationPolicy>[0] {
	return {
		binding,
		snapshot: {
			...binding,
			format: 1,
			overrideRevision: 1,
			state: 'active',
			lastEditor: null,
			lastEditedAtMs: null,
			services: {
				gmail: { read: inherit, write: inherit },
			},
		},
		defaults: { gmail: { read: 'allow', write: 'ask' } },
		maximums: { gmail: ['read', 'write'] },
		grants: { gmail: ['read', 'write'] },
		requirements: [{ serviceId: 'gmail', effects: ['read'] }],
		commandAllowed: true,
	};
}

function snapshotWithPolicies(
	read: 'deny' | 'ask' | 'allow',
	write: 'deny' | 'ask' | 'allow',
): object {
	return {
		...binding,
		format: 1,
		overrideRevision: 2,
		state: 'active',
		lastEditor: binding.owner,
		lastEditedAtMs: 1_000,
		services: {
			gmail: {
				read: { kind: 'explicit', disposition: read },
				write: { kind: 'explicit', disposition: write },
			},
		},
	};
}

describe('account override and live default resolution', () => {
	it('uses the active config only for inherited fields', () => {
		// Arrange
		const initial = input();
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy(initial)).toMatchObject({
			kind: 'allowed',
			disposition: 'allow',
			overrideRevision: 1,
		});
		expect(
			resolveGoogleAccountInvocationPolicy({ ...initial, defaults: { gmail: { read: 'ask' } } }),
		).toMatchObject({ kind: 'allowed', disposition: 'ask' });
	});

	it.each(['deny', 'ask', 'allow'] as const)(
		'preserves explicit %s across default changes, including same-value pins',
		(disposition) => {
			// Arrange
			const request = { ...input(), snapshot: snapshotWithPolicies(disposition, 'deny') };
			// Act
			const before = resolveGoogleAccountInvocationPolicy({
				...request,
				defaults: { gmail: { read: disposition } },
			});
			const after = resolveGoogleAccountInvocationPolicy({
				...request,
				defaults: { gmail: { read: 'allow' } },
			});
			// Assert
			expect(after).toEqual(before);
			expect(after.kind).toBe(disposition === 'deny' ? 'denied' : 'allowed');
		},
	);

	it('treats Reset as inheritance, not a snapshot of the default', () => {
		// Arrange
		const request = input();
		// Act / Assert
		expect(
			resolveGoogleAccountInvocationPolicy({ ...request, defaults: { gmail: { read: 'deny' } } })
				.kind,
		).toBe('denied');
		expect(
			resolveGoogleAccountInvocationPolicy({ ...request, defaults: { gmail: { read: 'allow' } } })
				.kind,
		).toBe('allowed');
	});

	it('denies absent default cells without changing an authenticated inherit snapshot', () => {
		// Arrange
		const request = { ...input(), defaults: {} };
		const originalSnapshot = structuredClone(request.snapshot);
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy(request)).toEqual({
			kind: 'denied',
			reason: 'policy',
		});
		expect(request.snapshot).toEqual(originalSnapshot);
	});

	it.each([
		undefined,
		null,
		{},
		{
			...binding,
			format: 1,
			overrideRevision: 1,
			state: 'active',
			lastEditor: null,
			lastEditedAtMs: null,
			services: {},
		},
	])('makes a missing/corrupt required snapshot unavailable, never inheritance: %j', (snapshot) => {
		// Arrange / Act / Assert
		expect(resolveGoogleAccountInvocationPolicy({ ...input(), snapshot })).toEqual({
			kind: 'unavailable',
		});
	});

	it('fences an applying revision even if the default would allow', () => {
		// Arrange
		const snapshot = {
			...binding,
			format: 1,
			overrideRevision: 2,
			state: 'applying',
			lastEditor: binding.owner,
			lastEditedAtMs: 1_000,
			services: { gmail: { read: inherit, write: inherit } },
		};
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy({ ...input(), snapshot })).toEqual({
			kind: 'unavailable',
		});
	});

	it.each([
		{ agentId: 'sun' },
		{ accountId: '33333333-3333-4333-8333-333333333333' },
		{ zoneId: 'other-zone' },
		{ applicationId: 'youtube-app' },
		{ authorizationId: '44444444-4444-4444-8444-444444444444' },
		{ owner: { issuer: binding.owner.issuer, userId: 'user_other_owner' } },
	])('rejects a valid snapshot bound to a different target %j', (change) => {
		// Arrange
		const snapshot = {
			...binding,
			...change,
			format: 1,
			overrideRevision: 1,
			state: 'active',
			services: { gmail: { read: inherit, write: inherit } },
			lastEditor: null,
			lastEditedAtMs: null,
		};
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy({ ...input(), snapshot })).toEqual({
			kind: 'unavailable',
		});
	});
});

describe('independent Read and Write gates', () => {
	it('does not interpret inherited JavaScript properties as a configured service', () => {
		// Arrange
		const request = {
			...input(),
			requirements: [{ serviceId: 'constructor', effects: ['read'] as const }],
		};
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy(request)).toEqual({ kind: 'unavailable' });
	});
	for (const read of ['deny', 'ask', 'allow'] as const) {
		for (const write of ['deny', 'ask', 'allow'] as const) {
			it(`resolves Read ${read}, Write ${write} independently`, () => {
				// Arrange
				const request = { ...input(), snapshot: snapshotWithPolicies(read, write) };
				// Act
				const readResult = resolveGoogleAccountInvocationPolicy(request);
				const writeResult = resolveGoogleAccountInvocationPolicy({
					...request,
					requirements: [{ serviceId: 'gmail', effects: ['write'] }],
				});
				const both = resolveGoogleAccountInvocationPolicy({
					...request,
					requirements: [{ serviceId: 'gmail', effects: ['read', 'write'] }],
				});
				// Assert
				expect(readResult).toEqual(
					read === 'deny'
						? { kind: 'denied', reason: 'policy' }
						: { kind: 'allowed', disposition: read, overrideRevision: 2 },
				);
				expect(writeResult).toEqual(
					write === 'deny'
						? { kind: 'denied', reason: 'policy' }
						: { kind: 'allowed', disposition: write, overrideRevision: 2 },
				);
				expect(both).toEqual(
					read === 'deny' || write === 'deny'
						? { kind: 'denied', reason: 'policy' }
						: {
								kind: 'allowed',
								disposition: read === 'ask' || write === 'ask' ? 'ask' : 'allow',
								overrideRevision: 2,
							},
				);
			});
		}
	}

	it('does not turn Allow or Ask into missing owner consent', () => {
		// Arrange
		const request = { ...input(), grants: {} };
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy(request)).toEqual({ kind: 'consent-required' });
	});

	it('a reduced maximum denies a retained override without rewriting it', () => {
		// Arrange
		const request = { ...input(), snapshot: snapshotWithPolicies('allow', 'allow'), maximums: {} };
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy(request)).toEqual({
			kind: 'denied',
			reason: 'hard-limit',
		});
		expect(request.snapshot).toEqual(snapshotWithPolicies('allow', 'allow'));
	});

	it('cannot bypass an executable denial', () => {
		// Arrange / Act / Assert
		expect(resolveGoogleAccountInvocationPolicy({ ...input(), commandAllowed: false })).toEqual({
			kind: 'denied',
			reason: 'command',
		});
	});

	it('does not suggest consent for an operation whose policy is denied', () => {
		// Arrange / Act / Assert
		expect(
			resolveGoogleAccountInvocationPolicy({
				...input(),
				grants: {},
				snapshot: snapshotWithPolicies('deny', 'allow'),
			}),
		).toEqual({ kind: 'denied', reason: 'policy' });
	});

	it('requires every service/effect rather than authorizing on the first matching service', () => {
		// Arrange
		const request = {
			...input(),
			requirements: [
				{ serviceId: 'gmail', effects: ['read'] as const },
				{ serviceId: 'calendar', effects: ['write'] as const },
			],
		};
		// Act / Assert
		expect(resolveGoogleAccountInvocationPolicy(request).kind).not.toBe('allowed');
	});

	it('rejects empty effects rather than granting a vacuous credentialed call', () => {
		// Arrange / Act / Assert
		expect(resolveGoogleAccountInvocationPolicy({ ...input(), requirements: [] }).kind).not.toBe(
			'allowed',
		);
		expect(
			resolveGoogleAccountInvocationPolicy({
				...input(),
				requirements: [{ serviceId: 'gmail', effects: [] }],
			}).kind,
		).not.toBe('allowed');
	});
});
