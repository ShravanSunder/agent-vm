import { clerkBrowserIdentityConfigSchema } from '@agent-vm/config-contracts';
import type { SecretResolver } from '@agent-vm/secret-management';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { prepareClerkBrowserIdentity } from './prepare-clerk-browser-identity.js';

function configuration(): ReturnType<typeof clerkBrowserIdentityConfigSchema.parse> {
	return clerkBrowserIdentityConfigSchema.parse({
		kind: 'clerk',
		issuer: 'https://clerk.example.test',
		publishableKey: `pk_test_${Buffer.from('clerk.example.test$').toString('base64')}`,
		hostedSignInUrl: 'https://accounts.example.test/sign-in',
		fixedLoginReturnOrigin: 'https://auth.example.test:18900',
		secretKey: { source: '1password', ref: 'op://agent-vm-testing/clerk-fixture/key' },
	});
}

function resolver(value: string): {
	readonly resolve: Mock<SecretResolver['resolve']>;
	readonly resolveAll: Mock<SecretResolver['resolveAll']>;
} {
	return { resolve: vi.fn(async () => value), resolveAll: vi.fn(async () => ({})) };
}

describe('host Clerk composition', () => {
	it('resolves one backend key through the existing secret resolver, without exporting it', async () => {
		// Arrange
		const secretResolver = resolver('sk_test_fixture_secret');
		const config = configuration();
		// Act
		const verifier = await prepareClerkBrowserIdentity({
			config,
			publicBaseUrl: config.fixedLoginReturnOrigin,
			secretResolver,
		});
		// Assert
		expect(secretResolver.resolve).toHaveBeenCalledExactlyOnceWith(config.secretKey);
		expect(secretResolver.resolveAll).not.toHaveBeenCalled();
		expect(Object.keys(verifier)).toContain('verifyGoogleIdentity');
		expect(JSON.stringify(verifier)).not.toContain('sk_test_fixture_secret');
	});

	it('rejects a different website origin before resolving any secret', async () => {
		// Arrange
		const secretResolver = resolver('sk_test_fixture_secret');
		// Act / Assert
		await expect(
			prepareClerkBrowserIdentity({
				config: configuration(),
				publicBaseUrl: 'https://other.example.test',
				secretResolver,
			}),
		).rejects.toThrow('origin');
		expect(secretResolver.resolve).not.toHaveBeenCalled();
	});

	it.each(['', '   ', 'not-a-clerk-secret', 'pk_test_publishable'])(
		'rejects malformed backend material without reflecting it: %s',
		async (value) => {
			// Arrange
			const config = configuration();
			// Act / Assert
			await expect(
				prepareClerkBrowserIdentity({
					config,
					publicBaseUrl: config.fixedLoginReturnOrigin,
					secretResolver: resolver(value),
				}),
			).rejects.toThrow('Clerk backend key is invalid');
		},
	);

	it('does not expose resolver diagnostics in a startup error', async () => {
		// Arrange
		const config = configuration();
		const secretResolver = resolver('unused');
		vi.mocked(secretResolver.resolve).mockRejectedValue(new Error('private-resolution-detail'));
		// Act / Assert
		await expect(
			prepareClerkBrowserIdentity({
				config,
				publicBaseUrl: config.fixedLoginReturnOrigin,
				secretResolver,
			}),
		).rejects.toThrow('Clerk backend key could not be resolved');
	});
});
