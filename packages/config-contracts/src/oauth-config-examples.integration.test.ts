import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getGooglePolicyCatalog } from '../../oauth-broker/src/google/google-policy-catalog.js';
import { loadJsonConfigFile } from './json-config-file.js';
import { compileOAuthPolicy } from './oauth-tool-portal-config.js';

const configurationExamplesDirectory = fileURLToPath(
	new URL('../../../docs/reference/configuration/examples/', import.meta.url),
);

describe('OAuth v2 configuration examples', () => {
	it('parses and compiles the checked-in synthetic OAuth and Tool Portal pair', async () => {
		// Arrange
		const oauthConfig = await loadJsonConfigFile(
			`${configurationExamplesDirectory}/oauth-v2.config.jsonc`,
		);
		const toolPortalConfig = await loadJsonConfigFile(
			`${configurationExamplesDirectory}/tool-portal-google-policy.config.jsonc`,
		);
		const catalog = getGooglePolicyCatalog();

		// Act
		const compiled = compileOAuthPolicy({ oauthConfig, toolPortalConfig, catalog });

		// Assert
		const supportedOperations = catalog.operations
			.filter((operation) => operation.familyId === 'communications')
			.map((operation) => operation.operationId)
			.toSorted();
		const supportedGroups = catalog.groups
			.filter((group) => group.familyId === 'communications')
			.map((group) => group.groupId)
			.toSorted();
		for (const agent of ['sun', 'ember']) {
			expect(compiled.operationIdsByAgent[agent]).toEqual(supportedOperations);
			expect(compiled.offeredGroupIdsByAgentApplication[agent]?.['gmail-app']).toEqual(
				supportedGroups,
			);
		}
		expect(compiled.defaultsByAgentApplication.sun).toEqual({
			'gmail-app': {
				gmail: { read: 'allow', write: 'deny' },
				calendar: { read: 'deny', write: 'deny' },
				contacts: { read: 'deny', write: 'deny' },
			},
		});
		expect(compiled.defaultsByAgentApplication.ember).toEqual({
			'gmail-app': {
				gmail: { read: 'ask', write: 'deny' },
			},
		});
	});
});
