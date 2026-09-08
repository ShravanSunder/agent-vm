import { describe, expect, it } from 'vitest';

import { decryptGoogleCredentialPayload } from './google-credential-payload.js';
import { createGrant, keyEncryptionKey } from './google-credential-refresh-test-fixture.js';

describe('authenticated Google credential metadata', () => {
	it('verifies display and permission hints without a refresh or storage write', () => {
		// Arrange
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000_000 });
		const original = structuredClone(grant);
		// Act
		const payload = decryptGoogleCredentialPayload({ grant, keyEncryptionKey });
		// Assert
		expect(payload.authority.accountAlias).toBe(grant.accountAlias);
		expect(payload.authority.selectedGroupIds).toEqual(['gmail.read']);
		expect(grant).toEqual(original);
	});

	it.each([
		'accountAlias',
		'selectedGroupIds',
		'requestedScopes',
		'grantedScopes',
		'authorizationMetadataRevision',
	] as const)('rejects altered %s even when ciphertext is untouched', (field) => {
		// Arrange
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000_000 });
		const changes = {
			accountAlias: 'Different target',
			selectedGroupIds: ['gmail.write'],
			requestedScopes: ['gmail.modify'],
			grantedScopes: ['gmail.modify'],
			authorizationMetadataRevision: 2,
		};
		const altered = { ...grant, [field]: changes[field] };
		// Act / Assert
		expect(() => decryptGoogleCredentialPayload({ grant: altered, keyEncryptionKey })).toThrow();
	});

	it.each(['agent', 'owner', 'key'] as const)('rejects a different %s binding', (field) => {
		// Arrange
		const grant = createGrant({ accessTokenExpiresAtMs: 1_000_000 });
		const candidate = {
			...grant,
			agentId: field === 'agent' ? 'ember' : grant.agentId,
			owner: field === 'owner' ? { ...grant.owner, userId: 'another-owner' } : grant.owner,
		};
		// Act / Assert
		expect(() =>
			decryptGoogleCredentialPayload({
				grant: candidate,
				keyEncryptionKey: field === 'key' ? new Uint8Array(32).fill(70) : keyEncryptionKey,
			}),
		).toThrow();
	});
});
