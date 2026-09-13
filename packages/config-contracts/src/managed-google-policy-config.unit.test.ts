import { describe, expect, it } from 'vitest';

import {
	controllerConfiguredCliOperationSchema,
	isControllerEphemeralManagedVmConfiguredCliOperation,
	oauthConfiguredCliInputSchema,
} from './controller-configured-cli.js';
import { toolPortalConfigSchema } from './tool-portal-config.js';

const googleOperation = {
	kind: 'configured_cli',
	authorization: { kind: 'oauth_account' },
	executablePath: '/usr/local/bin/gog',
	mandatoryArgvPrefix: [],
	safeHelp: 'Read Gmail with the selected account.',
	commands: [{ path: ['gmail', 'search'] }],
	calls: { source: 'managed_google_policy', deny: [] },
	stdin: { kind: 'none' },
	timeout: { kind: 'quick' },
	output: {
		modelVisibleStderr: 'fixed_safe_summary',
		overflow: 'truncate',
		stdoutMaxBytes: 4096,
		stderrMaxBytes: 1024,
	},
	executionTarget: {
		kind: 'ephemeral_managed_vm',
		imageReference: 'vm-images/google',
		guestCwd: '/work',
		environment: { kind: 'empty' },
		allowedHosts: ['gmail.googleapis.com'],
		credentialProjection: {
			kind: 'http_mediation',
			environment: { GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' } },
		},
	},
};
function config(): unknown {
	return {
		schemaVersion: 1,
		mode: 'managed',
		agents: {
			sun: { profile: 'shared' },
			ember: { profile: 'shared' },
		},
		profiles: {
			shared: {
				oauthApplications: {
					'gmail-app': {
						ceiling: { kind: 'catalog-preset', presetId: 'all-supported' },
						consentRecommendation: {
							kind: 'explicit',
							groupIds: ['gmail.read'],
						},
						policyDefaults: {
							kind: 'explicit',
							services: { gmail: { read: 'ask', write: 'deny' } },
						},
					},
				},
				namespaces: {
					google: {
						tools: { allow: '*' },
						calls: { source: 'managed_google_policy' },
						backend: { kind: 'controller_execution', operations: { gog: googleOperation } },
					},
				},
			},
		},
	};
}

describe('managed Google config policy source', () => {
	it('keeps OAuth policy in the shared profile and agents as profile assignments', () => {
		// Arrange / Act
		const parsed = toolPortalConfigSchema.parse(config());
		// Assert
		expect(parsed.mode).toBe('managed');
		if (parsed.mode !== 'managed') throw new Error('Expected managed config.');
		expect(parsed.agents.sun).toEqual({ profile: 'shared' });
		expect(parsed.profiles.shared?.oauthApplications?.['gmail-app']).toMatchObject({
			ceiling: { kind: 'catalog-preset', presetId: 'all-supported' },
			consentRecommendation: { kind: 'explicit', groupIds: ['gmail.read'] },
			policyDefaults: { kind: 'explicit' },
		});
	});
	it('rejects the old agent-level Google defaults location', () => {
		// Arrange
		const input = toolPortalConfigSchema.parse(config());
		// Act / Assert
		expect(
			toolPortalConfigSchema.safeParse({
				...input,
				agents: {
					sun: {
						profile: 'shared',
						googlePolicyDefaults: {
							kind: 'collection',
							collectionId: 'read-only-assistant',
							version: '1',
						},
					},
				},
			}).success,
		).toBe(false);
	});
	it('requires a ceiling for every profile OAuth application entry', () => {
		// Arrange
		const input = toolPortalConfigSchema.parse(config());
		if (input.mode !== 'managed') throw new Error('Expected managed config.');
		const application = input.profiles.shared?.oauthApplications?.['gmail-app'];
		if (application === undefined) throw new Error('Expected Gmail profile application.');
		const { ceiling: _removedCeiling, ...withoutCeiling } = application;
		// Act / Assert
		expect(
			toolPortalConfigSchema.safeParse({
				...input,
				profiles: {
					...input.profiles,
					shared: {
						...input.profiles.shared,
						oauthApplications: {
							...input.profiles.shared?.oauthApplications,
							'gmail-app': withoutCeiling,
						},
					},
				},
			}).success,
		).toBe(false);
	});
	it('retains hard command constraints without a second Ask or Allow rule list', () => {
		// Arrange / Act
		const parsed = controllerConfiguredCliOperationSchema.parse(googleOperation);
		if (!isControllerEphemeralManagedVmConfiguredCliOperation(parsed))
			throw new Error('Expected credentialed Google operation.');
		// Assert
		expect(parsed.commands[0]?.path).toEqual(['gmail', 'search']);
		expect(parsed.output).toEqual(googleOperation.output);
		expect(parsed.stdin).toEqual({ kind: 'none' });
		expect(parsed.calls).toEqual({ source: 'managed_google_policy', deny: [] });
		expect(
			controllerConfiguredCliOperationSchema.safeParse({
				...googleOperation,
				calls: {
					...googleOperation.calls,
					requiresApproval: [],
					withoutApproval: 'remaining_admitted',
				},
			}).success,
		).toBe(false);
	});
	it('rejects old account-profile rules and accepts only opaque account IDs beside argv', () => {
		// Arrange
		const input = {
			accountId: '11111111-1111-4111-8111-111111111111',
			argv: ['gmail', 'search', 'in:inbox'],
			reason: 'Read requested mail.',
		};
		// Act / Assert
		expect(oauthConfiguredCliInputSchema.parse(input)).toEqual(input);
		expect(
			oauthConfiguredCliInputSchema.safeParse({ ...input, accountProfile: 'personal' }).success,
		).toBe(false);
		expect(
			controllerConfiguredCliOperationSchema.safeParse({
				...googleOperation,
				authorization: { kind: 'oauth_account_profile', rules: [] },
			}).success,
		).toBe(false);
	});
	it('does not allow managed Google disposition on an ordinary non-OAuth command', () => {
		// Arrange / Act / Assert
		expect(
			controllerConfiguredCliOperationSchema.safeParse({
				...googleOperation,
				authorization: { kind: 'none' },
				executionTarget: { kind: 'controller_host', cwd: '/tmp', environment: { kind: 'empty' } },
			}).success,
		).toBe(false);
	});
});
