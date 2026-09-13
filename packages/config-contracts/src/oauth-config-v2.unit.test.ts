import { describe, expect, it } from 'vitest';

import { createOAuthConfigTestInput } from './oauth-config-test-fixture.js';
import { oauthConfigSchema } from './oauth-config.js';

describe('OAuth version-2 ownership and application configuration', () => {
	it('separates owner/editor admission, network admission, and per-agent ceilings without account slots', () => {
		// Arrange / Act
		const config = oauthConfigSchema.parse(createOAuthConfigTestInput());

		// Assert
		expect(config.schemaVersion).toBe(2);
		expect(config.agents.sun).not.toHaveProperty('accountProfiles');
		expect(config.owners.owner?.clerkUserId).toBe('user_test_owner');
		expect(config.browser.network.admittedTailnetLogins).toEqual(['network-person@example.test']);
	});

	it.each(['accountProfiles', 'email', 'providerSubject', 'googlePolicyDefaults'])(
		'rejects authored dynamic accounts or duplicate policy authority: %s',
		(field) => {
			// Arrange
			const input = createOAuthConfigTestInput();
			// Act / Assert
			expect(
				oauthConfigSchema.safeParse({
					...input,
					agents: { ...input.agents, sun: { ...input.agents.sun, [field]: {} } },
				}).success,
			).toBe(false);
		},
	);

	it('rejects raw scope mappings, duplicate families and unregistered projects', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		const applications = input.providers.google.applications;
		// Act / Assert
		for (const change of [
			{ services: { gmail: { read: ['gmail.readonly'] } } },
			{ catalogFamilyId: 'documents' },
			{ projectId: 'unknown-project' },
		]) {
			expect(
				oauthConfigSchema.safeParse({
					...input,
					providers: {
						google: {
							...input.providers.google,
							applications: {
								...applications,
								'gmail-app': { ...applications['gmail-app'], ...change },
							},
						},
					},
				}).success,
			).toBe(false);
		}
	});

	it('rejects duplicate human identities and admissions to absent agents', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({
				...input,
				owners: { ...input.owners, duplicate: input.owners.owner },
			}).success,
		).toBe(false);
		expect(
			oauthConfigSchema.safeParse({
				...input,
				owners: { owner: { ...input.owners.owner, allowedAgentIds: ['unknown-agent'] } },
			}).success,
		).toBe(false);
		expect(
			oauthConfigSchema.safeParse({
				...input,
				policyEditors: {
					editor: { ...input.policyEditors.editor, editableAgentIds: ['unknown-agent'] },
				},
			}).success,
		).toBe(false);
	});

	it('requires explicit ceilings and the same configured Clerk return origin', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({
				...input,
				agents: { sun: { applications: { 'gmail-app': {} } } },
			}).success,
		).toBe(false);
		expect(
			oauthConfigSchema.safeParse({
				...input,
				browser: {
					...input.browser,
					identity: {
						...input.browser.identity,
						fixedLoginReturnOrigin: 'https://different.example.test',
					},
				},
			}).success,
		).toBe(false);
		expect(oauthConfigSchema.safeParse({ ...input, schemaVersion: 1 }).success).toBe(false);
	});
});
