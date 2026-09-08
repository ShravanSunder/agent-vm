import { describe, expect, it } from 'vitest';

import { clerkBrowserIdentityConfigSchema } from './clerk-browser-config.js';

const configuration = {
	kind: 'clerk',
	issuer: 'https://clerk.example.test',
	publishableKey: `pk_test_${Buffer.from('clerk.example.test$').toString('base64')}`,
	hostedSignInUrl: 'https://accounts.example.test/sign-in',
	fixedLoginReturnOrigin: 'https://auth.example.test:18900',
	secretKey: { source: '1password', ref: 'op://agent-vm-testing/clerk-fixture/key' },
};

describe('Clerk browser identity configuration', () => {
	it('accepts fixed HTTPS origins and a host-only secret reference', () => {
		// Arrange / Act / Assert
		expect(clerkBrowserIdentityConfigSchema.parse(configuration)).toEqual(configuration);
	});
	it.each([
		{ secretKey: 'sk_test_inline_key' },
		{ secretKey: { source: 'environment', name: 'CLERK_SECRET_KEY' } },
		{ issuer: 'http://clerk.example.test' },
		{ issuer: 'https://clerk.example.test/other' },
		{ fixedLoginReturnOrigin: 'https://auth.example.test:18900/oauth/agents' },
		{ fixedLoginReturnOrigin: 'https://user:password@auth.example.test:18900' },
		{ hostedSignInUrl: 'https://accounts.example.test/sign-in?redirect_url=https://evil.example' },
		{ publishableKey: 'not-a-publishable-key' },
		{ resourceScopes: ['gmail.modify'] },
		{ issuer: 'https://other-instance.example.test' },
	])('rejects unsafe, contradictory or resource-auth configuration %j', (change) => {
		// Arrange / Act / Assert
		expect(
			clerkBrowserIdentityConfigSchema.safeParse({ ...configuration, ...change }).success,
		).toBe(false);
	});
});
