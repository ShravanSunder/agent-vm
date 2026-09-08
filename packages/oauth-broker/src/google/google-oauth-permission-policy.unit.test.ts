import { oauthConfigSchema } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import { createOAuthConfigTestInput } from '../../../config-contracts/src/oauth-config-test-fixture.js';
import { googleIdentityScopes } from './google-oauth-adapter.js';
import { createGoogleOAuthPermissionPolicy } from './google-oauth-permission-policy.js';

describe('Google group selection policy', () => {
	it('compiles catalog scopes under agent ceilings without any account-slot input', () => {
		// Arrange
		const config = oauthConfigSchema.parse(createOAuthConfigTestInput());
		const policy = createGoogleOAuthPermissionPolicy({
			config,
			offeredGroupIdsByAgentApplication: {
				sun: { 'gmail-app': ['gmail.read', 'gmail.write'] },
				ember: { 'gmail-app': ['gmail.read'] },
			},
		});

		// Act
		const selections = policy.completeSelections({
			agentId: 'sun',
			selections: { 'gmail-app': ['gmail.write'] },
		});

		// Assert
		expect(policy.scopesForApplication('gmail-app', selections)).toEqual(
			[...googleIdentityScopes, 'https://www.googleapis.com/auth/gmail.modify'].toSorted(),
		);
		expect(() =>
			policy.validateSelections({ agentId: 'ember', selections: { 'gmail-app': ['gmail.write'] } }),
		).toThrow();
	});

	it('rejects a compiler projection that exceeds the authored maximum', () => {
		// Arrange
		const config = oauthConfigSchema.parse(createOAuthConfigTestInput());
		// Act / Assert
		expect(() =>
			createGoogleOAuthPermissionPolicy({
				config,
				offeredGroupIdsByAgentApplication: {
					sun: { 'gmail-app': ['gmail.read', 'contacts.write'] },
				},
			}),
		).toThrow();
	});

	it('does not authorize Off applications or silently clamp unsupported selections', () => {
		// Arrange
		const config = oauthConfigSchema.parse(createOAuthConfigTestInput());
		const policy = createGoogleOAuthPermissionPolicy({
			config,
			offeredGroupIdsByAgentApplication: { sun: { 'gmail-app': ['gmail.read'] } },
		});

		// Act / Assert
		expect(
			policy.scopesForApplication(
				'gmail-app',
				policy.completeSelections({ agentId: 'sun', selections: {} }),
			),
		).toEqual([]);
		expect(() =>
			policy.validateSelections({
				agentId: 'sun',
				selections: { 'gmail-app': ['invented.scope'] },
			}),
		).toThrow();
		expect(() =>
			policy.validateSelections({
				agentId: 'sun',
				selections: { 'youtube-app': ['youtube.read'] },
			}),
		).toThrow();
	});
});
