import { describe, expect, it } from 'vitest';

import { hasVerifiedGoogleIdentity } from './clerk-google-eligibility.js';

function user(): unknown {
	return {
		id: 'user_owner',
		primaryEmailAddressId: 'email_primary',
		emailAddresses: [
			{
				id: 'email_primary',
				emailAddress: 'member@example.test',
				verification: { status: 'verified' },
			},
		],
		externalAccounts: [
			{
				provider: 'google',
				providerUserId: 'google_owner',
				emailAddress: 'member@example.test',
				verification: { status: 'verified' },
			},
		],
	};
}

describe('same-email Google onboarding eligibility', () => {
	it('accepts the matching verified Google identity', () => {
		expect(hasVerifiedGoogleIdentity(user(), 'user_owner')).toBe(true);
	});
	it('does not accept another Clerk user', () => {
		expect(hasVerifiedGoogleIdentity(user(), 'user_other')).toBe(false);
	});
	it.each([
		{ externalAccounts: [] },
		{ primaryEmailAddressId: null },
		{
			externalAccounts: [
				{
					provider: 'google',
					providerUserId: 'g',
					emailAddress: 'other@example.test',
					verification: { status: 'verified' },
				},
			],
		},
		{
			externalAccounts: [
				{
					provider: 'github',
					providerUserId: 'g',
					emailAddress: 'member@example.test',
					verification: { status: 'verified' },
				},
			],
		},
		{
			externalAccounts: [
				{
					provider: 'google',
					providerUserId: 'g',
					emailAddress: 'member@example.test',
					verification: { status: 'unverified' },
				},
			],
		},
		{
			emailAddresses: [
				{
					id: 'email_primary',
					emailAddress: 'member@example.test',
					verification: { status: 'unverified' },
				},
			],
		},
	])('rejects incomplete or mismatched remote identity: %j', (override) => {
		const original = user();
		if (typeof original !== 'object' || original === null) throw new Error('Invalid fixture');
		expect(hasVerifiedGoogleIdentity({ ...original, ...override }, 'user_owner')).toBe(false);
	});
});
