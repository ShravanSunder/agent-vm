import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createOAuthEnvelopeCodec, oauthEnvelopeBindingSchema } from './envelope-codec.js';
import { createGoogleCredentialRefreshCoordinator } from './google/google-credential-refresh-coordinator.js';
import { createAdapter } from './google/google-credential-refresh-test-fixture.js';
import {
	clientCredentials,
	credentialPayloadSchema,
	enrollmentInput,
	owner,
	wrappingKey,
} from './oauth-catalog-test-fixture.js';
import { openOAuthCredentialCatalog } from './oauth-credential-catalog.js';

describe('dynamic OAuth account catalog', () => {
	it('refreshes a real persisted envelope without changing authorization metadata or account policy', async () => {
		// Arrange: only Google transport is substituted; encryption and SQLite are real.
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-refresh-'));
		const catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
		try {
			const input = enrollmentInput({
				accountId: randomUUID(),
				agentId: 'sun',
				accessTokenExpiresAtMs: 1_000,
			});
			expect(catalog.commitEnrollmentGrant(input).kind).toBe('committed');
			const grant = catalog.getGrant(input.credentialId);
			if (grant === undefined) throw new Error('Expected stored credential.');
			const policy = catalog.getPolicy(input.authorizationId);
			const { adapter, refreshAuthorization } = createAdapter({
				kind: 'refreshed',
				accessToken: 'new-access',
				accessTokenExpiresAtMs: 1_000_000,
				grantedScopes: grant.grantedScopes,
				replacementRefreshToken: 'new-refresh',
			});
			const coordinator = createGoogleCredentialRefreshCoordinator({
				catalog,
				googleAdapter: adapter,
				now: () => 10_000,
			});

			// Act
			const resolved = await coordinator.resolveAccessToken({
				clientCredentials,
				grant,
				keyEncryptionKey: wrappingKey,
				keyEncryptionKeyVersion: 1,
				requiredScopes: grant.grantedScopes,
			});

			// Assert
			expect(resolved.kind).toBe('ready');
			const refreshed = catalog.getGrant(input.credentialId);
			if (refreshed === undefined) throw new Error('Expected refreshed credential.');
			expect(refreshed.recordRevision).toBe(2);
			expect(refreshed.authorizationMetadataRevision).toBe(1);
			expect(refreshed.generation).toBe(1);
			expect(refreshed.materialRevision).not.toBe(grant.materialRevision);
			expect(
				createOAuthEnvelopeCodec({ payloadSchema: credentialPayloadSchema }).decrypt({
					binding: oauthEnvelopeBindingSchema.strip().parse(refreshed),
					envelope: refreshed.envelope,
					keyEncryptionKey: wrappingKey,
				}),
			).toMatchObject({
				accessToken: 'new-access',
				refreshToken: 'new-refresh',
				authority: { accountAlias: 'My mailbox', selectedGroupIds: ['gmail.read'] },
			});
			expect(catalog.getPolicy(input.authorizationId)).toEqual(policy);
			expect(catalog.listAuthorizationHistory(input.authorizationId)).toHaveLength(2);
			expect(refreshAuthorization).toHaveBeenCalledOnce();
		} finally {
			catalog.close();
		}
	});

	it('rejects a real database envelope swap between agents without using either token', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-swap-'));
		const databasePath = path.join(directory, 'credentials.sqlite');
		const catalog = await openOAuthCredentialCatalog({ databasePath });
		const rawDatabase = new BetterSqlite3(databasePath);
		try {
			const accountId = randomUUID();
			const sun = enrollmentInput({ accountId, agentId: 'sun' });
			const ember = enrollmentInput({ accountId, agentId: 'ember' });
			expect(catalog.commitEnrollmentGrant(sun).kind).toBe('committed');
			expect(catalog.commitEnrollmentGrant(ember).kind).toBe('committed');
			rawDatabase
				.prepare(
					'UPDATE oauth_agent_authorizations SET encrypted_envelope=? WHERE authorization_id=?',
				)
				.run(JSON.stringify(sun.envelope), ember.authorizationId);
			const corrupted = catalog.getGrant(ember.credentialId);
			if (corrupted === undefined) throw new Error('Expected corrupted row metadata.');
			const { adapter, refreshAuthorization } = createAdapter({
				kind: 'failed',
				failure: { kind: 'provider-unavailable', retryable: true },
			});
			const coordinator = createGoogleCredentialRefreshCoordinator({
				catalog,
				googleAdapter: adapter,
				now: () => 10_000,
			});

			// Act / Assert
			await expect(
				coordinator.resolveAccessToken({
					clientCredentials,
					grant: corrupted,
					keyEncryptionKey: wrappingKey,
					keyEncryptionKeyVersion: 1,
					requiredScopes: corrupted.grantedScopes,
				}),
			).resolves.toEqual({ kind: 'reauthorization-required' });
			expect(refreshAuthorization).not.toHaveBeenCalled();
			expect(catalog.getGrant(sun.credentialId)?.lifecycleKind).toBe('active');
			expect(catalog.getGrant(ember.credentialId)?.failureClass).toBe('credential-corrupt');
		} finally {
			rawDatabase.close();
			catalog.close();
		}
	});

	it('disconnects only one authorization, retains its policy, and reconnects at a new generation', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-disconnect-'));
		const catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
		const accountId = randomUUID();
		try {
			const sun = enrollmentInput({ accountId, agentId: 'sun' });
			const ember = enrollmentInput({ accountId, agentId: 'ember' });
			expect(catalog.commitEnrollmentGrant(sun).kind).toBe('committed');
			expect(catalog.commitEnrollmentGrant(ember).kind).toBe('committed');
			const retainedPolicy = catalog.getPolicy(sun.authorizationId);

			// Act: durable credential removal precedes containment completion.
			const disconnected = catalog.disconnectAuthorization({
				authorizationId: sun.authorizationId,
				expectedRecordRevision: 1,
				owner,
			});
			expect(disconnected.kind).toBe('updated');
			if (disconnected.kind !== 'updated') throw new Error('Expected a disconnect transition.');
			expect(disconnected.authorization).toMatchObject({
				accessState: 'disconnecting',
				credentialId: null,
				envelope: null,
				generation: 2,
			});
			expect(catalog.getGrant(sun.credentialId)).toBeUndefined();
			expect(catalog.getGrant(ember.credentialId)).toBeDefined();
			const settled = catalog.settleAuthorizationTransition({
				authorizationId: sun.authorizationId,
				expectedRecordRevision: disconnected.authorization.recordRevision,
				transitionId: disconnected.authorization.transitionId,
			});
			if (settled.kind !== 'updated') throw new Error('Expected completed containment.');
			const reconnect = enrollmentInput({
				accountId,
				agentId: 'sun',
				retainedAuthorization: settled.authorization,
			});
			expect(catalog.commitEnrollmentGrant(reconnect).kind).toBe('committed');

			// Assert: reconnect preserves the tuple/policy, never the old credential.
			expect(catalog.getGrant(reconnect.credentialId)).toMatchObject({
				authorizationId: sun.authorizationId,
				generation: 3,
			});
			expect(catalog.getGrant(sun.credentialId)).toBeUndefined();
			expect(catalog.getPolicy(sun.authorizationId)).toEqual(retainedPolicy);
			expect(catalog.getGrant(ember.credentialId)).toBeDefined();
			expect(
				catalog.disconnectAuthorization({
					authorizationId: sun.authorizationId,
					expectedRecordRevision: 1,
					owner,
				}).kind,
			).toBe('stale');
		} finally {
			catalog.close();
		}
	});

	it('keeps a replacement unavailable until its exact containment transition settles', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-replace-'));
		const catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
		const accountId = randomUUID();
		try {
			const initial = enrollmentInput({ accountId, agentId: 'sun' });
			const committed = catalog.commitEnrollmentGrant(initial);
			if (committed.kind !== 'committed') throw new Error('Expected initial enrollment.');
			const replacement = enrollmentInput({
				accountId,
				agentId: 'sun',
				retainedAuthorization: committed.authorization,
			});

			// Act
			const replaced = catalog.replaceAuthorization(replacement);
			if (replaced.kind !== 'committed') throw new Error('Expected replacement.');

			// Assert
			expect(replaced.authorization.accessState).toBe('replacing');
			expect(catalog.getGrant(initial.credentialId)).toBeUndefined();
			expect(catalog.getGrant(replacement.credentialId)).toBeUndefined();
			expect(
				catalog.settleAuthorizationTransition({
					authorizationId: replacement.authorizationId,
					expectedRecordRevision: replaced.authorization.recordRevision,
					transitionId: randomUUID(),
				}).kind,
			).toBe('stale');
			expect(
				catalog.settleAuthorizationTransition({
					authorizationId: replacement.authorizationId,
					expectedRecordRevision: replaced.authorization.recordRevision,
					transitionId: replaced.authorization.transitionId,
				}).kind,
			).toBe('updated');
			expect(catalog.getGrant(replacement.credentialId)).toBeDefined();
			expect(catalog.replaceAuthorization(replacement).kind).toBe('stale');
		} finally {
			catalog.close();
		}
	});

	it('rolls back account, authorization and policy when appending history fails', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-history-'));
		const databasePath = path.join(directory, 'credentials.sqlite');
		const catalog = await openOAuthCredentialCatalog({ databasePath });
		const rawDatabase = new BetterSqlite3(databasePath);
		try {
			rawDatabase.exec(
				"CREATE TRIGGER reject_history BEFORE INSERT ON permission_change_events BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END",
			);
			const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });

			// Act / Assert
			expect(() => catalog.commitEnrollmentGrant(input)).toThrow();
			expect(catalog.getAccountMetadata(input.accountId)).toBeUndefined();
			expect(catalog.getAuthorization(input.authorizationId)).toBeUndefined();
			expect(catalog.getPolicy(input.authorizationId)).toBeUndefined();
			expect(catalog.listAuthorizationHistory(input.authorizationId)).toEqual([]);
		} finally {
			rawDatabase.close();
			catalog.close();
		}
	});

	it('does not report a successful refresh when the database rejects its compare-and-swap write', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-refresh-cas-'));
		const databasePath = path.join(directory, 'credentials.sqlite');
		const catalog = await openOAuthCredentialCatalog({ databasePath });
		const rawDatabase = new BetterSqlite3(databasePath);
		try {
			const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
			expect(catalog.commitEnrollmentGrant(input).kind).toBe('committed');
			rawDatabase.exec(
				'CREATE TRIGGER ignore_authorization_update BEFORE UPDATE ON oauth_agent_authorizations BEGIN SELECT RAISE(IGNORE); END',
			);

			// Act
			const result = catalog.replaceGrantEnvelope({
				credentialId: input.credentialId,
				envelope: input.envelope,
				expectedRecordRevision: 1,
				failureClass: null,
				lastRefreshAttemptAtMs: 1000,
				lastRefreshSucceededAtMs: 1000,
				lifecycleKind: 'active',
				materialRevision: input.materialRevision,
				nextRefreshEligibleAtMs: null,
				providerCredentialVersion: 2,
				reauthorizationReason: null,
			});

			// Assert
			expect(result).toEqual({ kind: 'stale', currentRecordRevision: 1 });
			expect(catalog.getGrant(input.credentialId)?.recordRevision).toBe(1);
		} finally {
			rawDatabase.close();
			catalog.close();
		}
	});

	it('stores one human-owned account with independent authorizations and policies for two agents', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-accounts-'));
		const databasePath = path.join(directory, 'credentials.sqlite');
		const catalog = await openOAuthCredentialCatalog({ databasePath });
		const accountId = randomUUID();
		try {
			const sunInput = enrollmentInput({ accountId, agentId: 'sun' });
			const emberInput = enrollmentInput({ accountId, agentId: 'ember' });

			// Act
			expect(catalog.commitEnrollmentGrant(sunInput).kind).toBe('committed');
			expect(catalog.commitEnrollmentGrant(emberInput).kind).toBe('committed');

			// Assert: shared account identity, different credential and policy records.
			const sun = catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' });
			const ember = catalog.listGrantsForAgent({ agentId: 'ember', zoneId: 'test-zone' });
			expect(sun).toHaveLength(1);
			expect(ember).toHaveLength(1);
			expect(sun[0]).toMatchObject({ accountId, owner, agentId: 'sun' });
			expect(ember[0]).toMatchObject({ accountId, owner, agentId: 'ember' });
			expect(sun[0]?.credentialId).not.toBe(ember[0]?.credentialId);
			expect(catalog.getPolicy(sunInput.authorizationId)?.overrideRevision).toBe(1);
			expect(catalog.getPolicy(emberInput.authorizationId)?.overrideRevision).toBe(1);
			expect(catalog.listGrantsForAgent({ agentId: 'mak', zoneId: 'test-zone' })).toEqual([]);
		} finally {
			catalog.close();
		}
		const reopened = await openOAuthCredentialCatalog({ databasePath });
		try {
			expect(reopened.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toHaveLength(1);
		} finally {
			reopened.close();
		}
	});

	it('rejects another owner and duplicate enrollment without replacing the winning credential', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-dynamic-conflicts-'));
		const catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
		const accountId = randomUUID();
		try {
			const original = enrollmentInput({ accountId, agentId: 'sun' });
			expect(catalog.commitEnrollmentGrant(original).kind).toBe('committed');

			// Act / Assert
			expect(
				catalog.commitEnrollmentGrant(
					enrollmentInput({ accountId, agentId: 'ember', ownerUserId: 'different-owner' }),
				).kind,
			).toBe('owner-mismatch');
			expect(
				catalog.commitEnrollmentGrant(enrollmentInput({ accountId, agentId: 'sun' })).kind,
			).toBe('duplicate-authorization');
			expect(
				catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })[0]?.credentialId,
			).toBe(original.credentialId);
			expect(catalog.listGrantsForAgent({ agentId: 'ember', zoneId: 'test-zone' })).toEqual([]);
		} finally {
			catalog.close();
		}
	});
});
