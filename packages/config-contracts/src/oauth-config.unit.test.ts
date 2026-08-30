import { describe, expect, it } from 'vitest';

import { googleOAuthCallbackUrl, oauthConfigSchema } from './oauth-config.js';
import { oauthToolPortalConfigPairSchema } from './oauth-tool-portal-config.js';

function validOAuthConfigInput(): unknown {
	return {
		agents: {
			hermes: {
				accountProfiles: {
					'personal-google': {
						applications: {
							'gmail-app': { maximumPermissions: { gmail: 'write' } },
							'workspace-app': {
								maximumPermissions: { calendar: 'write', drive: 'read' },
							},
							'youtube-app': { maximumPermissions: { youtube: 'read' } },
						},
						authorizedTailnetLogins: ['human@example.test'],
						provider: 'google',
					},
				},
			},
		},
		browser: {
			listener: {
				certificatePath: '/var/lib/agent-vm/oauth/tls.crt',
				kind: 'tailscale_https',
				port: 18_900,
				privateKeyPath: '/var/lib/agent-vm/oauth/tls.key',
			},
			publicBaseUrl: 'https://auth.claw.askluna.xyz',
		},
		providers: {
			google: {
				applications: {
					'gmail-app': {
						clientCredentials: {
							ref: 'op://agent-vm-testing/google-gmail-web/client-json',
							source: '1password',
						},
						clientKind: 'web',
						services: {
							gmail: { read: ['gmail.readonly'], write: ['gmail.modify'] },
						},
					},
					'workspace-app': {
						clientCredentials: {
							ref: 'op://agent-vm-testing/google-workspace-web/client-json',
							source: '1password',
						},
						clientKind: 'web',
						services: {
							calendar: { read: ['calendar.readonly'], write: ['calendar'] },
							drive: { read: ['drive.readonly'], write: ['drive'] },
						},
					},
					'youtube-app': {
						clientCredentials: {
							ref: 'op://agent-vm-testing/google-youtube-web/client-json',
							source: '1password',
						},
						clientKind: 'web',
						services: { youtube: { read: ['youtube.readonly'] } },
					},
				},
				kind: 'google',
			},
		},
		schemaVersion: 1,
		storage: {
			keyEncryptionKey: {
				ref: 'op://agent-vm-testing/oauth-kek/password',
				source: '1password',
			},
		},
	};
}

function validOAuthToolPortalConfigInput(): unknown {
	return {
		agents: { hermes: { profile: 'google-enabled' } },
		mode: 'managed',
		profiles: {
			'google-enabled': {
				namespaces: {
					gog: {
						backend: {
							kind: 'controller_execution',
							operations: {
								gog_cli: {
									authorization: {
										kind: 'oauth_account_profile',
										rules: [
											{
												match: { flags: [], path: ['gmail', 'search'] },
												requirement: {
													applicationId: 'gmail-app',
													kind: 'oauth',
													minimumPermission: 'read',
													serviceId: 'gmail',
												},
											},
											{
												match: { flags: [], path: ['gmail', 'send'] },
												requirement: {
													applicationId: 'gmail-app',
													kind: 'oauth',
													minimumPermission: 'write',
													serviceId: 'gmail',
												},
											},
											{
												match: { flags: [], path: ['help'] },
												requirement: { kind: 'no_oauth' },
											},
										],
									},
									calls: {
										deny: [],
										requiresApproval: [{ flags: [], path: ['gmail', 'send'] }],
										withoutApproval: 'remaining_admitted',
									},
									commands: [
										{ path: ['gmail', 'search'] },
										{ path: ['gmail', 'send'] },
										{ path: ['help'] },
									],
									deniedPatterns: [],
									executablePath: '/usr/bin/gog',
									executionTarget: {
										allowedHosts: ['www.googleapis.com'],
										credentialProjection: {
											environment: {
												GOG_ACCESS_TOKEN: {
													hosts: ['www.googleapis.com'],
													secret: {
														ref: 'op://agent-vm-testing/placeholder/value',
														source: '1password',
													},
												},
											},
											kind: 'http_mediation',
										},
										environment: { kind: 'empty' },
										guestCwd: '/work',
										imageReference: '../../vm-images/controller-runners/gog/build-config.json',
										kind: 'ephemeral_managed_vm',
									},
									kind: 'configured_cli',
									mandatoryArgvPrefix: [],
									output: {
										modelVisibleStderr: 'none',
										overflow: 'truncate',
										stderrMaxBytes: 1_024,
										stdoutMaxBytes: 1_024,
									},
									safeHelp: 'Run one admitted Gog command.',
									stdin: { kind: 'none' },
									timeout: { kind: 'quick' },
								},
							},
						},
						calls: {
							requiresApproval: { allow: [] },
							withoutApproval: { allow: ['gog_cli'] },
						},
						tools: { allow: ['gog_cli'] },
					},
				},
			},
		},
		schemaVersion: 1,
	};
}

describe('OAuth config contract', () => {
	it('parses the strict three-application Google config and derives one callback', () => {
		const config = oauthConfigSchema.parse(validOAuthConfigInput());
		expect(Object.keys(config.providers.google.applications).toSorted()).toEqual([
			'gmail-app',
			'workspace-app',
			'youtube-app',
		]);
		expect(googleOAuthCallbackUrl(config)).toBe(
			'https://auth.claw.askluna.xyz/oauth/google/callback',
		);
	});

	it('rejects authored Google account identity and arbitrary providers or applications', () => {
		const input = validOAuthConfigInput() as Record<string, unknown>;
		const agents = input.agents as Record<string, unknown>;
		const hermes = agents.hermes as Record<string, unknown>;
		expect(
			oauthConfigSchema.safeParse({ ...input, agents: { hermes: { ...hermes, email: 'x@y.z' } } })
				.success,
		).toBe(false);

		const providers = input.providers as Record<string, unknown>;
		expect(
			oauthConfigSchema.safeParse({
				...input,
				providers: { ...providers, notion: { kind: 'notion' } },
			}).success,
		).toBe(false);
	});

	it('rejects account-profile service maxima missing from the selected application', () => {
		const input = validOAuthConfigInput() as Record<string, unknown>;
		const agents = structuredClone(input.agents) as Record<string, Record<string, unknown>>;
		const hermes = agents.hermes;
		if (hermes === undefined) throw new Error('Missing Hermes OAuth test agent.');
		const accountProfiles = hermes.accountProfiles as Record<string, Record<string, unknown>>;
		const profile = accountProfiles['personal-google'];
		if (profile === undefined) throw new Error('Missing personal OAuth profile.');
		const applications = profile.applications as Record<string, Record<string, unknown>>;
		applications['gmail-app'] = { maximumPermissions: { calendar: 'read' } };

		const result = oauthConfigSchema.safeParse({ ...input, agents });
		expect(result.success).toBe(false);
		if (result.success) throw new Error('Expected invalid OAuth service maximum.');
		expect(result.error.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: [
						'agents',
						'hermes',
						'accountProfiles',
						'personal-google',
						'applications',
						'gmail-app',
						'maximumPermissions',
						'calendar',
					],
				}),
			]),
		);
	});

	it('rejects write maxima when the service has no authored write scopes', () => {
		const input = validOAuthConfigInput() as Record<string, unknown>;
		const agents = structuredClone(input.agents) as Record<string, Record<string, unknown>>;
		const hermes = agents.hermes;
		if (hermes === undefined) throw new Error('Missing Hermes OAuth test agent.');
		const accountProfiles = hermes.accountProfiles as Record<string, Record<string, unknown>>;
		const profile = accountProfiles['personal-google'];
		if (profile === undefined) throw new Error('Missing personal OAuth profile.');
		const applications = profile.applications as Record<string, Record<string, unknown>>;
		applications['youtube-app'] = { maximumPermissions: { youtube: 'write' } };
		expect(oauthConfigSchema.safeParse({ ...input, agents }).success).toBe(false);
	});

	it.each([
		'https://auth.claw.askluna.xyz/path',
		'https://auth.claw.askluna.xyz:18900',
		'http://auth.claw.askluna.xyz',
	])('rejects non-origin OAuth public URL %s', (publicBaseUrl) => {
		const input = validOAuthConfigInput() as Record<string, unknown>;
		const browser = input.browser as Record<string, unknown>;
		expect(
			oauthConfigSchema.safeParse({ ...input, browser: { ...browser, publicBaseUrl } }).success,
		).toBe(false);
	});

	it('requires 1Password for the KEK and Web client credentials', () => {
		const input = validOAuthConfigInput() as Record<string, unknown>;
		const storage = input.storage as Record<string, unknown>;
		expect(
			oauthConfigSchema.safeParse({
				...input,
				storage: {
					...storage,
					keyEncryptionKey: { name: 'OAUTH_KEK', source: 'environment' },
				},
			}).success,
		).toBe(false);
	});
});

describe('OAuth and Tool Portal cross-reference contract', () => {
	it('accepts one reachable Gog operation whose rules fit an assigned account profile', () => {
		expect(
			oauthToolPortalConfigPairSchema.safeParse({
				oauthConfig: validOAuthConfigInput(),
				toolPortalConfig: validOAuthToolPortalConfigInput(),
			}).success,
		).toBe(true);
	});

	it('rejects a reachable OAuth operation for an agent with no OAuth account profiles', () => {
		const oauthConfig = validOAuthConfigInput() as Record<string, unknown>;
		expect(
			oauthToolPortalConfigPairSchema.safeParse({
				oauthConfig: {
					...oauthConfig,
					agents: { other: (oauthConfig.agents as Record<string, unknown>).hermes },
				},
				toolPortalConfig: validOAuthToolPortalConfigInput(),
			}).success,
		).toBe(false);
	});

	it('rejects OAuth write classification without invocation approval', () => {
		const toolPortalConfig = structuredClone(validOAuthToolPortalConfigInput()) as Record<
			string,
			unknown
		>;
		const profiles = toolPortalConfig.profiles as Record<string, Record<string, unknown>>;
		const profile = profiles['google-enabled'];
		if (profile === undefined) throw new Error('Missing Tool Portal OAuth test profile.');
		const namespaces = profile.namespaces as Record<string, Record<string, unknown>>;
		const namespace = namespaces.gog;
		if (namespace === undefined) throw new Error('Missing Gog OAuth test namespace.');
		const backend = namespace.backend as Record<string, unknown>;
		const operations = backend.operations as Record<string, Record<string, unknown>>;
		const operation = operations.gog_cli;
		if (operation === undefined) throw new Error('Missing Gog OAuth test operation.');
		operation.calls = { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' };

		expect(
			oauthToolPortalConfigPairSchema.safeParse({
				oauthConfig: validOAuthConfigInput(),
				toolPortalConfig,
			}).success,
		).toBe(false);
	});
});
