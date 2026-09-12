import { describe, expect, it } from 'vitest';

import { getVerifiedGoogleEmailAddress } from './clerk-google-eligibility.js';

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
				provider: 'oauth_google',
				providerUserId: 'google_owner',
				emailAddress: 'member@example.test',
				verification: { status: 'verified' },
			},
		],
	};
}

describe('same-email Google onboarding eligibility', () => {
	it('accepts the matching verified Google identity', () => {
		expect(getVerifiedGoogleEmailAddress(user(), 'user_owner')).toBe('member@example.test');
	});
	it('does not accept another Clerk user', () => {
		expect(getVerifiedGoogleEmailAddress(user(), 'user_other')).toBeUndefined();
	});
	it.each([
		{ externalAccounts: [] },
		{ primaryEmailAddressId: null },
		{
			externalAccounts: [
				{
					provider: 'oauth_google',
					providerUserId: 'g',
					emailAddress: 'other@example.test',
					verification: { status: 'verified' },
				},
			],
		},
		{
			externalAccounts: [
				{
					provider: 'oauth_github',
					providerUserId: 'g',
					emailAddress: 'member@example.test',
					verification: { status: 'verified' },
				},
			],
		},
		{
			externalAccounts: [
				{
					provider: 'oauth_google',
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
		expect(
			getVerifiedGoogleEmailAddress({ ...original, ...override }, 'user_owner'),
		).toBeUndefined();
	});
});
