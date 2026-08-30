import { describe, expect, it } from 'vitest';

import {
	OAuthAuthorizationControllerActionRequestSchema,
	OAuthAuthorizationControllerActionResultSchema,
} from './index.js';

describe('OAuth authorization controller-execution boundary', () => {
	it('accepts typed begin suggestions and rejects caller-authored scopes', () => {
		expect(
			OAuthAuthorizationControllerActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.begin',
				accountProfileId: 'personal-google',
				suggestedSelections: { 'gmail-app': { gmail: 'read' } },
			}).success,
		).toBe(true);
		expect(
			OAuthAuthorizationControllerActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.begin',
				accountProfileId: 'personal-google',
				scopes: ['gmail.modify'],
			}).success,
		).toBe(false);
	});

	it('cannot serialize sensitive provider fields as a public controller result', () => {
		expect(
			OAuthAuthorizationControllerActionResultSchema.safeParse({
				kind: 'authorization-begun',
				authorizationUrl: 'https://auth.claw.askluna.xyz/oauth/transactions/test',
				expiresAt: '2026-08-30T12:00:00.000Z',
				refreshToken: 'forbidden',
				transactionId: 'a'.repeat(32),
			}).success,
		).toBe(false);
	});
});
