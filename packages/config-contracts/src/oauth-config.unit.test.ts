import { describe, expect, it } from 'vitest';

import { createOAuthConfigTestInput } from './oauth-config-test-fixture.js';
import { googleOAuthCallbackUrl, oauthConfigSchema } from './oauth-config.js';
import { createOAuthPolicyCompilerTestInput } from './oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from './oauth-tool-portal-config.js';

describe('OAuth config contract', () => {
	it('parses the strict three-application Google config and derives one callback', () => {
		// Arrange / Act
		const config = oauthConfigSchema.parse(createOAuthConfigTestInput());
		// Assert
		expect(Object.keys(config.providers.google.applications).toSorted()).toEqual([
			'gmail-app',
			'workspace-app',
			'youtube-app',
		]);
		expect(googleOAuthCallbackUrl(config)).toBe(
			'https://auth.claw.askluna.xyz:18900/oauth/google/callback',
		);
	});
	it('rejects authored Google account identities and arbitrary providers or applications', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({
				...input,
				agents: { ...input.agents, sun: { ...input.agents.sun, email: 'synthetic@example.test' } },
			}).success,
		).toBe(false);
		expect(
			oauthConfigSchema.safeParse({
				...input,
				providers: { ...input.providers, notion: { kind: 'notion' } },
			}).success,
		).toBe(false);
		expect(
			oauthConfigSchema.safeParse({
				...input,
				providers: {
					google: {
						...input.providers.google,
						applications: {
							...input.providers.google.applications,
							arbitrary: input.providers.google.applications['gmail-app'],
						},
					},
				},
			}).success,
		).toBe(false);
	});
	it('rejects ceiling groups missing from the selected application family', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.oauthConfig.agents.sun.applications['gmail-app'].ceiling.groupIds = ['forms.body.read'];
		// Act / Assert
		expect(() => compileOAuthPolicy(input)).toThrow('ceiling');
	});
	it('rejects write maxima that have no supported catalog group', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.catalog.groups = input.catalog.groups.filter((group) => group.effect !== 'write');
		// Act / Assert
		expect(() => compileOAuthPolicy(input)).toThrow('ceiling');
	});
	it.each([
		'https://auth.claw.askluna.xyz/path',
		'https://auth.claw.askluna.xyz',
		'https://auth.claw.askluna.xyz:18899',
		'https://auth.claw.askluna.xyz:18900/path',
		'https://oauth.example.test:18900',
		'http://auth.claw.askluna.xyz',
	])('rejects non-origin OAuth public URL %s', (publicBaseUrl) => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({ ...input, browser: { ...input.browser, publicBaseUrl } })
				.success,
		).toBe(false);
	});
	it('requires 1Password references for the KEK and Web client credentials', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({
				...input,
				storage: { keyEncryptionKey: { name: 'TEST_ONLY_KEY', source: 'environment' } },
			}).success,
		).toBe(false);
		expect(
			oauthConfigSchema.safeParse({
				...input,
				providers: {
					google: {
						...input.providers.google,
						applications: {
							...input.providers.google.applications,
							'gmail-app': {
								...input.providers.google.applications['gmail-app'],
								clientCredentials: { name: 'TEST_ONLY_CLIENT', source: 'environment' },
							},
						},
					},
				},
			}).success,
		).toBe(false);
	});
	it('requires a distinct client reference for every Google application', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		input.providers.google.applications['workspace-app'].clientCredentials =
			input.providers.google.applications['gmail-app'].clientCredentials;
		// Act / Assert
		expect(oauthConfigSchema.safeParse(input).success).toBe(false);
	});
});

describe('OAuth and Tool Portal cross-reference contract', () => {
	it('accepts reachable Gog operations qualified by the code catalog and explicit agent ceilings', () => {
		// Arrange / Act
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		// Assert
		expect(compiled.operationIdsByAgent.sun).toEqual(['gmail.search']);
	});
	it('rejects a reachable Google operation for an agent with no OAuth admission', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const config = oauthConfigSchema.parse(input.oauthConfig);
		delete config.agents.sun;
		for (const owner of Object.values(config.owners)) owner.allowedAgentIds = ['ember'];
		for (const editor of Object.values(config.policyEditors)) editor.editableAgentIds = ['ember'];
		// Act / Assert
		expect(() => compileOAuthPolicy({ ...input, oauthConfig: config })).toThrow(
			'without OAuth ceilings',
		);
	});
	it('accepts configured Write Allow without adding a second OAuth must-ask policy', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.commands.push({
			path: ['gmail', 'send'],
			flagRules: [],
		});
		input.toolPortalConfig.agents.ember.googlePolicyDefaults.applications['gmail-app'].gmail.write =
			'allow';
		// Act / Assert
		expect(compileOAuthPolicy(input).defaultsByAgentApplication.ember).toEqual({
			'gmail-app': { gmail: { read: 'ask', write: 'allow' } },
		});
	});
});
