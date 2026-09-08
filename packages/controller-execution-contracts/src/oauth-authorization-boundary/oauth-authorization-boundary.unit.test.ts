import { describe, expect, it } from 'vitest';

import {
	OAuthAuthorizationControllerActionRequestSchema,
	OAuthAuthorizationControllerActionResultSchema,
	OAuthAuthorizationDisconnectArgumentsSchema,
} from './index.js';

describe('OAuth authorization controller-execution boundary', () => {
	it('accepts typed begin suggestions and rejects caller-authored scopes', () => {
		expect(
			OAuthAuthorizationControllerActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.begin',
				applicationId: 'gmail-app',
				suggestedSelections: { 'gmail-app': ['gmail.read'] },
			}).success,
		).toBe(true);
		expect(
			OAuthAuthorizationControllerActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.begin',
				applicationId: 'gmail-app',
				scopes: ['gmail.modify'],
			}).success,
		).toBe(false);
	});

	it('exports the account-bound disconnect ceremony instead of provider revocation', () => {
		// Arrange
		const disconnectArguments = {
			accountId: '11111111-1111-4111-8111-111111111111',
			applicationId: 'gmail-app',
		};
		// Act / Assert
		expect(OAuthAuthorizationDisconnectArgumentsSchema.parse(disconnectArguments)).toEqual(
			disconnectArguments,
		);
		expect(
			OAuthAuthorizationControllerActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.disconnect',
				...disconnectArguments,
			}).success,
		).toBe(true);
		expect(
			OAuthAuthorizationControllerActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.revoke',
				...disconnectArguments,
			}).success,
		).toBe(false);
	});

	it('cannot serialize sensitive provider fields as a public controller result', () => {
		expect(
			OAuthAuthorizationControllerActionResultSchema.safeParse({
				kind: 'authorization-begun',
				authorizationUrl: 'https://auth.claw.askluna.xyz:18900/oauth/transactions/test',
				expiresAt: '2026-08-30T12:00:00.000Z',
				refreshToken: 'forbidden',
				transactionId: 'a'.repeat(32),
			}).success,
		).toBe(false);
	});
});
