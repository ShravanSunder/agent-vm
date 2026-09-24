import { describe, expect, it } from 'vitest';

import { createOAuthConfigTestInput } from './oauth-config-test-fixture.js';
import { googleOAuthCallbackUrl, oauthConfigSchema } from './oauth-config.js';
import { createOAuthPolicyCompilerTestInput } from './oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from './oauth-tool-portal-config.js';

describe('OAuth version-3 ownership and application configuration', () => {
	it('separates Access identity, owner/editor admission, and application registrations', () => {
		// Arrange / Act
		const config = oauthConfigSchema.parse(createOAuthConfigTestInput());

		// Assert
		expect(config.schemaVersion).toBe(3);
		expect(config).not.toHaveProperty('agents');
		expect(config.owners.owner?.subject).toBe('user_test_owner');
		expect(config.browser.identity.kind).toBe('cloudflare-access');
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

	it('accepts arbitrary canonical HTTPS origins and rejects legacy or malformed browser config', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		const configured = oauthConfigSchema.parse({
			...input,
			browser: { ...input.browser, publicBaseUrl: 'https://unrelated.example.net:443/' },
		});
		expect(configured.browser.publicBaseUrl).toBe('https://unrelated.example.net');
		for (const publicBaseUrl of [
			'http://unrelated.example.net',
			'https://unrelated.example.net:18900',
			'https://user@unrelated.example.net',
			'https://unrelated.example.net/path',
			'https://unrelated.example.net/?query=yes',
		]) {
			expect(
				oauthConfigSchema.safeParse({
					...input,
					browser: { ...input.browser, publicBaseUrl },
				}).success,
			).toBe(false);
		}
		expect(oauthConfigSchema.safeParse({ ...input, schemaVersion: 2 }).success).toBe(false);
		expect(
			oauthConfigSchema.safeParse({
				...input,
				browser: { ...input.browser, network: { admittedTailnetLogins: ['legacy'] } },
			}).success,
		).toBe(false);
	});

	it('keeps two valid deployment origins independent in one binary', () => {
		const firstInput = createOAuthConfigTestInput();
		const secondInput = createOAuthConfigTestInput();
		firstInput.browser.publicBaseUrl = 'https://permissions-alpha.example.test';
		secondInput.browser.publicBaseUrl = 'https://permissions-beta.example.test';

		const first = oauthConfigSchema.parse(firstInput);
		const second = oauthConfigSchema.parse(secondInput);

		expect(first.browser.publicBaseUrl).toBe('https://permissions-alpha.example.test');
		expect(second.browser.publicBaseUrl).toBe('https://permissions-beta.example.test');
		expect(googleOAuthCallbackUrl(first)).toBe(
			'https://permissions-alpha.example.test/oauth/google/callback',
		);
		expect(googleOAuthCallbackUrl(second)).toBe(
			'https://permissions-beta.example.test/oauth/google/callback',
		);
	});
});
