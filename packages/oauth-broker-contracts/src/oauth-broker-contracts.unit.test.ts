import { describe, expect, it } from 'vitest';

import {
	oauthAuthorizationActionRequestSchema,
	oauthAuthorizationActionResultSchema,
	oauthCredentialLifecycleStateSchema,
	oauthPermissionSelectionsSchema,
	oauthToolAvailabilityBatchRequestSchema,
	oauthToolAvailabilityBatchResultSchema,
	oauthToolAvailabilitySchema,
	oauthToolRequirementSchema,
	oauthTokenLifecycleSchema,
} from './index.js';

describe('OAuth broker portable contracts', () => {
	it('parses typed permission suggestions without accepting raw scopes', () => {
		expect(
			oauthAuthorizationActionRequestSchema.parse({
				actionId: 'oauth_authorization.begin',
				accountProfileId: 'personal-google',
				suggestedSelections: {
					'gmail-app': { gmail: 'read' },
					'workspace-app': { calendar: 'write', drive: 'none' },
				},
			}),
		).toMatchObject({ actionId: 'oauth_authorization.begin' });
		expect(
			oauthAuthorizationActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.begin',
				accountProfileId: 'personal-google',
				scopes: ['https://mail.google.com/'],
			}).success,
		).toBe(false);
	});

	it('keeps provider credential fields out of public results', () => {
		expect(
			oauthAuthorizationActionResultSchema.safeParse({
				accountLabel: 'Personal Google',
				accountProfileId: 'personal-google',
				accessToken: 'must-not-type-check',
				applicationId: 'gmail-app',
				grantedScopes: ['gmail.readonly'],
				kind: 'authorization-completed',
				refreshToken: 'must-not-type-check',
			}).success,
		).toBe(false);
	});

	it('parses every provider-neutral lifecycle variant', () => {
		expect(
			oauthTokenLifecycleSchema.parse({
				kind: 'refreshable',
				refreshMode: 'rotating-refresh-token',
			}),
		).toMatchObject({ kind: 'refreshable' });
		expect(
			oauthCredentialLifecycleStateSchema.parse({
				kind: 'reauthorization-required',
				reason: 'invalid-grant',
			}),
		).toMatchObject({ kind: 'reauthorization-required' });
	});

	it('distinguishes static and invocation-dependent tool requirements', () => {
		expect(
			oauthToolRequirementSchema.parse({
				applicationId: 'gmail-app',
				kind: 'oauth-account-profile',
				minimumPermission: 'read',
				serviceId: 'gmail',
			}),
		).toMatchObject({ kind: 'oauth-account-profile' });
		expect(
			oauthToolRequirementSchema.parse({
				accountProfileArgument: 'accountProfile',
				describeBeforeCall: true,
				kind: 'invocation-dependent-oauth-account-profile',
			}),
		).toMatchObject({ kind: 'invocation-dependent-oauth-account-profile' });
	});

	it('requires safe account labels only for ready availability', () => {
		expect(
			oauthToolAvailabilitySchema.parse({
				accountProfiles: [{ accountLabel: 'Personal Google', accountProfileId: 'personal-google' }],
				kind: 'ready',
			}),
		).toMatchObject({ kind: 'ready' });
		expect(
			oauthToolAvailabilitySchema.parse({ kind: 'authorization-status-unavailable' }),
		).toMatchObject({ kind: 'authorization-status-unavailable' });
		expect(
			oauthToolAvailabilitySchema.safeParse({ accountProfiles: [], kind: 'ready' }).success,
		).toBe(false);
	});

	it('bounds and deduplicates provider-neutral availability batches', () => {
		const requirement = {
			applicationId: 'gmail-app',
			kind: 'oauth-account-profile' as const,
			minimumPermission: 'read' as const,
			serviceId: 'gmail',
		};
		expect(
			oauthToolAvailabilityBatchRequestSchema.parse({ requirements: [requirement] }),
		).toMatchObject({ requirements: [requirement] });
		expect(
			oauthToolAvailabilityBatchRequestSchema.safeParse({
				requirements: [requirement, requirement],
			}).success,
		).toBe(false);
		expect(
			oauthToolAvailabilityBatchResultSchema.safeParse({
				items: [
					{ availability: { kind: 'authorization-required' }, requirement },
					{ availability: { kind: 'ready', accountProfiles: [] }, requirement },
				],
			}).success,
		).toBe(false);
	});

	it('rejects malformed nested application and service identifiers', () => {
		expect(
			oauthPermissionSelectionsSchema.safeParse({
				'Gmail App': { gmail: 'read' },
			}).success,
		).toBe(false);
		expect(
			oauthPermissionSelectionsSchema.safeParse({
				'gmail-app': { 'gmail/write': 'write' },
			}).success,
		).toBe(false);
	});
});
