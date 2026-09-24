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
			'https://permissions.example.test/oauth/google/callback',
		);
	});
	it('rejects authored Google account identities and arbitrary providers or applications', () => {
		// Arrange
		const input = createOAuthConfigTestInput();
		// Act / Assert
		expect(
			oauthConfigSchema.safeParse({
				...input,
				agents: { sun: { email: 'synthetic@example.test' } },
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
		input.toolPortalConfig.profiles.shared.oauthApplications['gmail-app'].ceiling.groupIds = [
			'forms.body.read',
		];
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
		'https://permissions.example.test/path',
		'https://permissions.example.test:18900',
		'https://user@permissions.example.test',
		'https://permissions.example.test/?query=yes',
		'http://permissions.example.test',
	])('rejects nonstandard OAuth public URL %s', (publicBaseUrl) => {
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
		const { oauthApplications: _removedApplications, ...sharedProfile } =
			input.toolPortalConfig.profiles.shared;
		const toolPortalConfig = {
			...input.toolPortalConfig,
			profiles: { ...input.toolPortalConfig.profiles, shared: sharedProfile },
		};
		// Act / Assert
		expect(() => compileOAuthPolicy({ ...input, toolPortalConfig })).toThrow(
			'no application ceiling',
		);
	});
	it('accepts configured Write Allow without adding a second OAuth must-ask policy', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		input.toolPortalConfig.profiles.ask.namespaces.google.backend.operations.gog.commands.push({
			path: ['gmail', 'send'],
			flagRules: [],
		});
		input.toolPortalConfig.profiles.ask.oauthApplications[
			'gmail-app'
		].policyDefaults.services.gmail.write = 'allow';
		// Act / Assert
		expect(compileOAuthPolicy(input).defaultsByAgentApplication.ember).toEqual({
			'gmail-app': { gmail: { read: 'ask', write: 'allow' } },
		});
	});
});
