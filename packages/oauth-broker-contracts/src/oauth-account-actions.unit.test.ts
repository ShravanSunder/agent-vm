import { describe, expect, it } from 'vitest';

import {
	oauthApplicationGrantStatusSchema,
	oauthAuthorizationActionRequestSchema,
	oauthAuthorizationActionResultSchema,
} from './oauth-authorization-action-contracts.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const transactionId = 'A'.repeat(43);

describe('account-based OAuth lifecycle actions', () => {
	it.each(['unverified', 'replacing', 'degraded'] as const)(
		'does not advertise ready activity when %s',
		(condition) => {
			// Arrange
			const status = {
				applicationId: 'gmail-app',
				applicationLabel: 'Gmail',
				accessState: condition === 'replacing' ? 'replacing' : 'connected',
				lifecycle:
					condition === 'degraded'
						? {
								kind: 'degraded',
								failureClass: 'provider-unavailable',
								nextRefreshEligibleAt: '2026-09-06T00:00:00Z',
							}
						: { kind: 'active' },
				metadata:
					condition === 'unverified'
						? { kind: 'unavailable' }
						: {
								kind: 'verified',
								accountAlias: 'My mail',
								confirmedGroupIds: ['gmail.read'],
								grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
								scopeDescriptions: ['Read Gmail'],
							},
				activities: [
					{
						operationId: 'gmail.search',
						availability: {
							kind: 'ready',
							disposition: 'allow',
							overrideRevision: 1,
							defaultsRevision: 'defaults-1',
						},
					},
				],
			};
			// Act / Assert
			expect(oauthApplicationGrantStatusSchema.safeParse(status).success).toBe(false);
			expect(
				oauthApplicationGrantStatusSchema.safeParse({
					...status,
					activities: [{ operationId: 'gmail.search', availability: { kind: 'unavailable' } }],
				}).success,
			).toBe(true);
		},
	);
	it('starts a family enrollment without a preconfigured account slot', () => {
		// Arrange
		const request = {
			actionId: 'oauth_authorization.begin',
			applicationId: 'gmail-app',
			suggestedAlias: 'My mail',
			suggestedSelections: { 'gmail-app': ['gmail.read'] },
		};
		// Act / Assert
		expect(oauthAuthorizationActionRequestSchema.parse(request)).toEqual(request);
	});
	it.each(['reauthorize', 'disconnect'] as const)(
		'requests %s for an opaque account and family',
		(action) => {
			// Arrange
			const request = {
				actionId: `oauth_authorization.${action}`,
				accountId,
				applicationId: 'gmail-app',
			};
			// Act / Assert
			expect(oauthAuthorizationActionRequestSchema.parse(request)).toEqual(request);
		},
	);
	it.each([
		'owner',
		'agentId',
		'credentialId',
		'scopes',
		'clientId',
		'redirectUri',
		'accountProfileId',
	] as const)('rejects caller-supplied %s authority', (field) => {
		// Arrange
		const request = {
			actionId: 'oauth_authorization.begin',
			applicationId: 'gmail-app',
			[field]: 'untrusted',
		};
		// Act / Assert
		expect(oauthAuthorizationActionRequestSchema.safeParse(request).success).toBe(false);
	});
	it('removes provider revoke rather than keeping an alias', () => {
		// Arrange / Act / Assert
		expect(
			oauthAuthorizationActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.revoke',
				accountId,
				applicationId: 'gmail-app',
			}).success,
		).toBe(false);
		expect(
			oauthAuthorizationActionResultSchema.safeParse({ kind: 'authorization-revoked' }).success,
		).toBe(false);
	});
	it.each(['status', 'cancel'] as const)('accepts only an opaque ceremony for %s', (action) => {
		// Arrange
		const request = { actionId: `oauth_authorization.${action}`, transactionId };
		// Act / Assert
		expect(oauthAuthorizationActionRequestSchema.parse(request)).toEqual(request);
		expect(
			oauthAuthorizationActionRequestSchema.safeParse({ ...request, owner: 'untrusted' }).success,
		).toBe(false);
	});
	it('reports local disconnect and pending containment separately', () => {
		// Arrange / Act / Assert
		for (const kind of [
			'authorization-disconnected',
			'authorization-disconnecting',
			'authorization-replacement-pending',
			'authorization-containment-failed',
		]) {
			const result = { kind, accountId, applicationId: 'gmail-app' };
			expect(oauthAuthorizationActionResultSchema.parse(result)).toEqual(result);
		}
	});
	it.each([
		'accessToken',
		'refreshToken',
		'owner',
		'sessionId',
		'providerSubject',
		'envelope',
	] as const)('excludes %s from valid public completions', (field) => {
		// Arrange
		const result = {
			kind: 'authorization-completed',
			accountId,
			accountAlias: 'My mail',
			applicationId: 'gmail-app',
			grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
		};
		// Act / Assert
		expect(oauthAuthorizationActionResultSchema.safeParse(result).success).toBe(true);
		expect(
			oauthAuthorizationActionResultSchema.safeParse({ ...result, [field]: 'private' }).success,
		).toBe(false);
	});
});
