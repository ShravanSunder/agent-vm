import { describe, expect, it } from 'vitest';

import { createOAuthConfigTestInput } from './oauth-config-test-fixture.js';
import { oauthConfigSchema } from './oauth-config.js';
import { createOAuthPolicyCompilerTestInput } from './oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from './oauth-tool-portal-config.js';

describe('OAuth version-2 ownership and application configuration', () => {
	it('separates owner/editor admission, network admission, and application registrations', () => {
		// Arrange / Act
		const config = oauthConfigSchema.parse(createOAuthConfigTestInput());

		// Assert
		expect(config.schemaVersion).toBe(2);
		expect(config).not.toHaveProperty('agents');
		expect(config.owners.owner?.clerkUserId).toBe('user_test_owner');
		expect(config.browser.network.admittedTailnetLogins).toEqual(['network-person@example.test']);
	});

	it('rejects the old authored OAuth agent policy map', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({
				...input,
				agents: {
					sun: {
						applications: {
							'gmail-app': {
								ceiling: { kind: 'explicit', groupIds: ['gmail.read'] },
							},
						},
					},
				},
			}).success,
		).toBe(false);
	});

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

	it('rejects duplicate human identities and compilation rejects admissions to absent agents', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({
				...input,
				owners: { ...input.owners, duplicate: input.owners.owner },
			}).success,
		).toBe(false);
		const compilerInput = createOAuthPolicyCompilerTestInput();
		compilerInput.oauthConfig.owners.owner.allowedAgentIds = ['unknown-agent'];
		expect(() => compileOAuthPolicy(compilerInput)).toThrow('unconfigured agent');
		const editorInput = createOAuthPolicyCompilerTestInput();
		editorInput.oauthConfig.policyEditors.editor.editableAgentIds = ['unknown-agent'];
		expect(() => compileOAuthPolicy(editorInput)).toThrow('unconfigured agent');
	});

	it('requires the same configured Clerk return origin', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
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
