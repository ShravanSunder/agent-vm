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
	it('exposes catalog group choices without static account slots or provider secrets', () => {
		expect(
			oauthAuthorizationActionResultSchema.parse({
				kind: 'authorization-list',
				accounts: [],
				authorizationOptions: [
					{
						applicationId: 'gmail-app',
						applicationLabel: 'Gmail',
						services: [
							{
								serviceId: 'gmail',
								serviceLabel: 'Gmail messages',
								groups: [
									{
										groupId: 'gmail.read',
										effect: 'read',
										label: 'Read Gmail',
										scopeDescriptions: ['Read Gmail messages and settings.'],
									},
								],
							},
						],
					},
				],
			}),
		).toMatchObject({ authorizationOptions: [{ applicationId: 'gmail-app' }] });
	});

	it('parses typed permission suggestions without accepting raw scopes', () => {
		expect(
			oauthAuthorizationActionRequestSchema.parse({
				actionId: 'oauth_authorization.begin',
				applicationId: 'gmail-app',
				suggestedSelections: {
					'gmail-app': ['gmail.read', 'calendar.write'],
				},
			}),
		).toMatchObject({ actionId: 'oauth_authorization.begin' });
		expect(
			oauthAuthorizationActionRequestSchema.safeParse({
				actionId: 'oauth_authorization.begin',
				applicationId: 'gmail-app',
				scopes: ['https://mail.google.com/'],
			}).success,
		).toBe(false);
	});

	it('keeps provider credential fields out of public results', () => {
		expect(
			oauthAuthorizationActionResultSchema.safeParse({
				accountAlias: 'Personal Google',
				accountId: '11111111-1111-4111-8111-111111111111',
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

	it('describes exact Google operations with dynamic account selection', () => {
		expect(
			oauthToolRequirementSchema.parse({
				kind: 'google-account',
				accountArgument: 'accountId',
				describeBeforeCall: true,
				operations: [{ applicationId: 'gmail-app', operationId: 'gmail.search' }],
			}),
		).toMatchObject({ kind: 'google-account' });
		expect(
			oauthToolRequirementSchema.safeParse({
				accountProfileArgument: 'accountProfile',
				describeBeforeCall: true,
				kind: 'invocation-dependent-oauth-account-profile',
			}).success,
		).toBe(false);
	});

	it('requires authenticated account labels for usable activity', () => {
		const option = {
			accountId: '11111111-1111-4111-8111-111111111111',
			metadata: { kind: 'verified', accountAlias: 'Personal Google' },
			availability: {
				kind: 'ready',
				disposition: 'ask',
				overrideRevision: 1,
				defaultsRevision: 'defaults-1',
			},
		};
		const availability = (account: unknown): unknown => ({
			kind: 'operation-options',
			items: [
				{
					requirement: { applicationId: 'gmail-app', operationId: 'gmail.search' },
					availability: { kind: 'accounts', accounts: [account] },
				},
			],
		});
		expect(oauthToolAvailabilitySchema.parse(availability(option))).toMatchObject({
			kind: 'operation-options',
		});
		expect(oauthToolAvailabilitySchema.parse({ kind: 'unavailable' })).toEqual({
			kind: 'unavailable',
		});
		expect(
			oauthToolAvailabilitySchema.safeParse(
				availability({ ...option, metadata: { kind: 'unavailable' } }),
			).success,
		).toBe(false);
		expect(
			oauthToolAvailabilitySchema.safeParse(
				availability({
					...option,
					metadata: { kind: 'unavailable' },
					availability: { kind: 'unavailable' },
				}),
			).success,
		).toBe(true);
	});

	it('bounds and deduplicates provider-neutral availability batches', () => {
		const requirement = {
			applicationId: 'gmail-app',
			operationId: 'gmail.search',
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
					{ availability: { kind: 'unavailable' }, requirement },
					{ availability: { kind: 'accounts', accounts: [] }, requirement },
				],
			}).success,
		).toBe(false);
		expect(
			oauthToolAvailabilityBatchRequestSchema.safeParse({
				requirements: Array.from({ length: 257 }, (_, index) => ({
					...requirement,
					operationId: `operation-${String(index)}`,
				})),
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
