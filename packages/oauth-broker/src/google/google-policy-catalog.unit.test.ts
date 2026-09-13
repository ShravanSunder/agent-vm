import { oauthServiceIdSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from '../../../config-contracts/src/oauth-tool-portal-config.js';
import { getGooglePolicyCatalog } from './google-policy-catalog.js';

describe('code-owned Google policy catalog', () => {
	it('uses the pinned generated default API hosts, not OAuth scope hosts or broader guesses', () => {
		// Arrange / Act
		const catalog = getGooglePolicyCatalog();
		// Assert
		expect(catalog.families).toEqual({
			communications: {
				allowedHosts: ['gmail.googleapis.com', 'people.googleapis.com', 'www.googleapis.com'],
			},
			documents: {
				allowedHosts: [
					'docs.googleapis.com',
					'forms.googleapis.com',
					'sheets.googleapis.com',
					'slides.googleapis.com',
					'www.googleapis.com',
				],
			},
			youtube: { allowedHosts: ['youtube.googleapis.com'] },
		});
	});
	it('keeps Forms bodies and responses mapped to distinct consent groups', () => {
		// Arrange
		const catalog = getGooglePolicyCatalog();
		// Act / Assert
		const responses = catalog.groups.find((group) => group.groupId === 'forms.responses.read');
		const bodies = catalog.groups.find((group) => group.groupId === 'forms.body.read');
		expect(responses?.operationIds.length).toBeGreaterThan(0);
		expect(
			responses?.operationIds.every((operationId) => operationId.startsWith('forms.responses.')),
		).toBe(true);
		expect(
			bodies?.operationIds.some((operationId) => operationId.startsWith('forms.responses.')),
		).toBe(false);
	});
	it('feeds the actual configuration compiler without a config-to-broker runtime dependency', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const catalog = getGooglePolicyCatalog();
		input.toolPortalConfig.profiles.shared.namespaces.google.backend.operations.gog.executionTarget.allowedHosts =
			[...catalog.families.communications.allowedHosts];
		// Act
		const compiled = compileOAuthPolicy({ ...input, catalog });
		// Assert
		expect(compiled.operationIdsByAgent.sun).toEqual(['gmail.search']);
		expect(compiled.offeredGroupIdsByAgentApplication.sun?.['gmail-app']).toEqual(['gmail.read']);
		expect(
			compiled.defaultsByAgentApplication.sun?.['gmail-app']?.[oauthServiceIdSchema.parse('gmail')],
		).toEqual({
			read: 'allow',
			write: 'deny',
		});
	});
});
