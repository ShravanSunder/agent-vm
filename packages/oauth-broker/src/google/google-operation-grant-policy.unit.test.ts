import { describe, expect, it } from 'vitest';

import { googleIdentityScopes } from './google-oauth-adapter.js';
import { evaluateGoogleOperationGrant } from './google-operation-grant-policy.js';
import { compileGooglePermissionSelection } from './google-permission-catalog.js';

describe('operation-specific consent and scope checks', () => {
	it('admits a consented Gmail read with exact scope evidence', () => {
		// Arrange / Act / Assert
		expect(
			evaluateGoogleOperationGrant({
				operationId: 'gmail.get',
				selectedGroupIds: ['gmail.read'],
				ceiling: ['gmail.read'],
				actualScopes: [...googleIdentityScopes, 'https://www.googleapis.com/auth/gmail.readonly'],
			}),
		).toEqual({ kind: 'admitted' });
	});
	it('does not confuse Forms body-read consent with response-read consent', () => {
		// Arrange
		const groupIds = ['forms.body.read'];
		const selection = compileGooglePermissionSelection({
			familyId: 'documents',
			groupIds,
			ceiling: groupIds,
		});
		// Act / Assert
		expect(
			evaluateGoogleOperationGrant({
				operationId: 'forms.responses.list',
				selectedGroupIds: groupIds,
				ceiling: ['forms.body.read', 'forms.responses.read'],
				actualScopes: [...googleIdentityScopes, ...selection.scopes],
			}),
		).toEqual({ kind: 'consent-required' });
	});
	it('admits Forms responses only with that selection and evidenced scope', () => {
		// Arrange / Act / Assert
		expect(
			evaluateGoogleOperationGrant({
				operationId: 'forms.responses.list',
				selectedGroupIds: ['forms.responses.read'],
				ceiling: ['forms.responses.read'],
				actualScopes: [
					...googleIdentityScopes,
					'https://www.googleapis.com/auth/forms.responses.readonly',
				],
			}),
		).toEqual({ kind: 'admitted' });
	});
	it('requires declared helper reads even when the write token technically permits them', () => {
		// Arrange / Act / Assert
		expect(
			evaluateGoogleOperationGrant({
				operationId: 'gmail.drafts.create',
				selectedGroupIds: ['gmail.write'],
				ceiling: ['gmail.read', 'gmail.write'],
				actualScopes: [...googleIdentityScopes, 'https://www.googleapis.com/auth/gmail.modify'],
			}),
		).toEqual({ kind: 'consent-required' });
	});
	it('rejects surplus and missing scopes without copying a broader authorization', () => {
		// Arrange
		const request = {
			operationId: 'gmail.get',
			selectedGroupIds: ['gmail.read'],
			ceiling: ['gmail.read'],
		};
		// Act / Assert
		expect(
			evaluateGoogleOperationGrant({
				...request,
				actualScopes: [...googleIdentityScopes, 'https://www.googleapis.com/auth/gmail.modify'],
			}),
		).toEqual({ kind: 'scope-mismatch' });
		expect(
			evaluateGoogleOperationGrant({ ...request, actualScopes: [...googleIdentityScopes] }),
		).toEqual({ kind: 'scope-mismatch' });
	});
	it('makes an authorization above a reduced ceiling unavailable, not partially restricted', () => {
		// Arrange / Act / Assert
		expect(
			evaluateGoogleOperationGrant({
				operationId: 'gmail.get',
				selectedGroupIds: ['gmail.read', 'gmail.write'],
				ceiling: ['gmail.read'],
				actualScopes: [
					...googleIdentityScopes,
					'https://www.googleapis.com/auth/gmail.readonly',
					'https://www.googleapis.com/auth/gmail.modify',
				],
			}),
		).toEqual({ kind: 'unavailable' });
	});
	it('refuses unknown operation identity', () => {
		// Arrange / Act / Assert
		expect(
			evaluateGoogleOperationGrant({
				operationId: 'api.arbitrary',
				selectedGroupIds: [],
				ceiling: [],
				actualScopes: [],
			}),
		).toEqual({ kind: 'unavailable' });
	});
});
