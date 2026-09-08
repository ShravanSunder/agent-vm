import { describe, expect, it } from 'vitest';

import { runtimeMaterialMatchesInvalidation } from './credentialed-runtime-material-scope.js';

const authorization = {
	accountId: 'account-a',
	applicationId: 'gmail-app',
	authorizationId: 'grant-a',
	generation: 2,
	overrideRevision: 3,
};
const scope = {
	kind: 'oauth-authorization' as const,
	accountId: 'account-a',
	applicationId: 'gmail-app',
	authorizationId: 'grant-a',
	throughGeneration: 2,
	throughOverrideRevision: 3,
};
describe('targeted credentialed runtime containment', () => {
	it('matches every older material generation for the same authorization', () => {
		expect(runtimeMaterialMatchesInvalidation({ scope, authorization, isOAuthRuntime: true })).toBe(
			true,
		);
		expect(
			runtimeMaterialMatchesInvalidation({
				scope,
				authorization: { ...authorization, generation: 1 },
				isOAuthRuntime: true,
			}),
		).toBe(true);
	});
	it.each([
		{ accountId: 'account-b' },
		{ authorizationId: 'grant-b' },
		{ applicationId: 'workspace-app' },
		{ generation: 3 },
		{ overrideRevision: 4 },
	])('does not retire unrelated or newer authority %j', (change) => {
		expect(
			runtimeMaterialMatchesInvalidation({
				scope,
				authorization: { ...authorization, ...change },
				isOAuthRuntime: true,
			}),
		).toBe(false);
	});
	it('never claims missing OAuth metadata proves the target material absent', () => {
		expect(
			runtimeMaterialMatchesInvalidation({ scope, authorization: undefined, isOAuthRuntime: true }),
		).toBe(true);
		expect(
			runtimeMaterialMatchesInvalidation({
				scope,
				authorization: undefined,
				isOAuthRuntime: false,
			}),
		).toBe(false);
	});
});
