import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { oauthMaterialRevisionSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import { createOAuthEnvelopeCodec, oauthEnvelopeBindingSchema } from './envelope-codec.js';
import {
	credentialPayloadSchema,
	enrollmentInput,
	owner,
	wrappingKey,
} from './oauth-catalog-test-fixture.js';
import type { OAuthCredentialCatalog } from './oauth-credential-catalog-contracts.js';
import { openOAuthCredentialCatalog } from './oauth-credential-catalog.js';

describe('OAuth credential catalog', () => {
	it('retains human-owned account metadata and policy after its last authorization disconnects', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-account-retention-'));
		const catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
		try {
			const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
			expect(catalog.commitEnrollmentGrant(input).kind).toBe('committed');
			const policy = catalog.getPolicy(input.authorizationId);

			// Act
			const removed = catalog.disconnectAuthorization({
				authorizationId: input.authorizationId,
				expectedRecordRevision: 1,
				owner,
			});

			// Assert
			expect(removed.kind).toBe('updated');
			expect(catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);
			expect(catalog.getAccountMetadata(input.accountId)).toMatchObject({
				owner,
				providerSubject: input.providerSubject,
			});
			expect(catalog.getPolicy(input.authorizationId)).toEqual(policy);
			expect(catalog.getAuthorization(input.authorizationId)).toMatchObject({
				accessState: 'disconnecting',
				envelope: null,
			});
		} finally {
			catalog.close();
		}
	});

	it('preserves a replacement when a disconnect targets its previous record revision', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-replacement-retention-'));
		const catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
		try {
			const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
			const initial = catalog.commitEnrollmentGrant(input);
			if (initial.kind !== 'committed') throw new Error('Expected initial enrollment.');
			const replacement = enrollmentInput({
				accountId: input.accountId,
				agentId: 'sun',
				retainedAuthorization: initial.authorization,
			});
			expect(catalog.replaceAuthorization(replacement).kind).toBe('committed');

			// Act / Assert
			expect(
				catalog.disconnectAuthorization({
					authorizationId: input.authorizationId,
					expectedRecordRevision: 1,
					owner,
				}).kind,
			).toBe('stale');
			expect(catalog.getAuthorization(input.authorizationId)).toMatchObject({
				credentialId: replacement.credentialId,
				accessState: 'replacing',
				recordRevision: 2,
			});
			expect(catalog.getGrant(input.credentialId)).toBeUndefined();
		} finally {
			catalog.close();
		}
	});

	it('initializes, hardens, encrypts, refreshes with CAS, verifies its key, and reopens the current catalog', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-current-catalog-'));
		const databasePath = path.join(directory, 'oauth', 'credentials.sqlite');
		let catalog: OAuthCredentialCatalog | undefined = await openOAuthCredentialCatalog({
			databasePath,
			now: () => 1_000,
		});
		const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		const codec = createOAuthEnvelopeCodec({ payloadSchema: credentialPayloadSchema });
		try {
			catalog.verifyOrInitializeKeyEncryptionKey(wrappingKey);
			expect(() => catalog?.verifyOrInitializeKeyEncryptionKey(new Uint8Array(32).fill(7))).toThrow(
				'does not match the catalog verifier',
			);
			expect(catalog.commitEnrollmentGrant(input).kind).toBe('committed');
			const initial = catalog.getGrant(input.credentialId);
			if (initial === undefined) throw new Error('Expected stored credential.');
			const binding = oauthEnvelopeBindingSchema.strip().parse(initial);
			const payload = codec.decrypt({
				binding,
				envelope: initial.envelope,
				keyEncryptionKey: wrappingKey,
			});
			const replacementEnvelope = codec.encrypt({
				binding,
				keyEncryptionKey: wrappingKey,
				keyEncryptionKeyVersion: 1,
				payload: {
					...payload,
					accessToken: 'updated-access-token',
					refreshToken: 'updated-refresh-token',
				},
			});
			const refresh = {
				credentialId: input.credentialId,
				envelope: replacementEnvelope,
				expectedRecordRevision: 1,
				failureClass: null,
				lastRefreshAttemptAtMs: 1_900,
				lastRefreshSucceededAtMs: 2_000,
				lifecycleKind: 'active' as const,
				materialRevision: oauthMaterialRevisionSchema.parse('sha256:' + 'B'.repeat(43)),
				nextRefreshEligibleAtMs: null,
				providerCredentialVersion: 2,
				reauthorizationReason: null,
			};

			// Act
			expect(catalog.replaceGrantEnvelope(refresh).kind).toBe('updated');
			expect(catalog.replaceGrantEnvelope(refresh)).toEqual({
				kind: 'stale',
				currentRecordRevision: 2,
			});

			// Assert: no token plaintext on disk and all catalog paths hardened.
			await Promise.all(
				[databasePath, databasePath + '-wal', databasePath + '-shm'].map(
					async (filePath): Promise<void> => {
						const contents = await readFile(filePath);
						for (const marker of [
							'credential-for-sun',
							'refresh-for-sun',
							'updated-access-token',
							'updated-refresh-token',
						]) {
							expect(contents.includes(marker)).toBe(false);
						}
						expect((await stat(filePath)).mode & 0o777).toBe(0o600);
					},
				),
			);
			expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
			catalog.close();
			catalog = undefined;
			catalog = await openOAuthCredentialCatalog({ databasePath });
			catalog.verifyOrInitializeKeyEncryptionKey(wrappingKey);
			const reopened = catalog.getGrant(input.credentialId);
			if (reopened === undefined) throw new Error('Expected reopened credential.');
			expect(reopened).toMatchObject({
				recordRevision: 2,
				authorizationMetadataRevision: 1,
				generation: 1,
			});
			expect(
				codec.decrypt({ binding, envelope: reopened.envelope, keyEncryptionKey: wrappingKey }),
			).toMatchObject({
				accessToken: 'updated-access-token',
				refreshToken: 'updated-refresh-token',
			});
			expect(catalog.getStorageDiagnostics()).toEqual({
				busyTimeoutMs: 5_000,
				foreignKeysEnabled: true,
				journalMode: 'wal',
				synchronousMode: 2,
			});
		} finally {
			catalog?.close();
		}
	});

	it('refuses to change the verified subject of an existing account during replacement', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-subject-binding-'));
		const catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
		try {
			const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
			const initial = catalog.commitEnrollmentGrant(input);
			if (initial.kind !== 'committed') throw new Error('Expected initial enrollment.');
			const mismatch = enrollmentInput({
				accountId: input.accountId,
				agentId: 'sun',
				retainedAuthorization: initial.authorization,
				providerSubject: 'different-subject',
			});

			// Act / Assert
			expect(catalog.replaceAuthorization(mismatch).kind).toBe('account-conflict');
			expect(catalog.getGrant(input.credentialId)).toBeDefined();
			expect(catalog.getGrant(mismatch.credentialId)).toBeUndefined();
			expect(catalog.getAccountMetadata(input.accountId)?.providerSubject).toBe(
				input.providerSubject,
			);
		} finally {
			catalog.close();
		}
	});
});
