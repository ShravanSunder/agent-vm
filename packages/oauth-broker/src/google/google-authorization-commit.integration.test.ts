import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	oauthAccountIdSchema,
	oauthCompletionSessionIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
	clientCredentials,
	enrollmentInput,
	owner,
	wrappingKey,
} from '../oauth-catalog-test-fixture.js';
import { type OAuthCompletionSession } from '../oauth-ceremony-contracts.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import { openOAuthCredentialCatalog } from '../oauth-credential-catalog.js';
import { createGoogleAuthorizationCommitter } from './google-authorization-commit.js';
import { callbackIdentity, createCallbackTestFixture } from './google-callback-test-fixture.js';
import { decryptGoogleCredentialPayload } from './google-credential-payload.js';
import { type GoogleProviderAuthorization } from './google-oauth-adapter.js';
import { createGoogleOAuthPermissionPolicy } from './google-oauth-permission-policy.js';

const existingAccountId = oauthAccountIdSchema.parse('11111111-1111-4111-8111-111111111111');
type ContainmentCallback = Parameters<
	typeof createGoogleAuthorizationCommitter
>[0]['containAuthorizationMaterial'];

describe('confirmed Google authorization commit', () => {
	let catalog: OAuthCredentialCatalog;
	beforeEach(async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-confirmed-grant-'));
		catalog = await openOAuthCredentialCatalog({
			databasePath: path.join(directory, 'credentials.sqlite'),
		});
	});
	afterEach(() => {
		catalog.close();
	});

	async function arrange(
		props: {
			readonly existing?: ReturnType<typeof enrollmentInput>;
			readonly containment?: 'contained' | 'pending' | 'failed';
			readonly agentId?: string;
		} = {},
	): Promise<{
		readonly committer: ReturnType<typeof createGoogleAuthorizationCommitter>;
		readonly containAuthorizationMaterial: Mock<ContainmentCallback>;
		readonly fixture: ReturnType<typeof createCallbackTestFixture>;
		readonly session: Extract<
			OAuthCompletionSession<GoogleProviderAuthorization>,
			{ kind: 'committing' }
		>;
	}> {
		const fixture = createCallbackTestFixture(catalog);
		const existing = props.existing;
		const agentId = props.agentId ?? 'sun';
		fixture.exchangeAuthorizationCode.mockResolvedValueOnce({
			kind: 'authorized',
			authorization: {
				...fixture.authorization,
				accessToken: `synthetic-access-${agentId}`,
				refreshToken: `synthetic-refresh-${agentId}`,
			},
		});
		if (existing !== undefined)
			expect(catalog.commitEnrollmentGrant(existing).kind).toBe('committed');
		const callbackInput = fixture.begin(
			existing === undefined
				? { agentId }
				: {
						target: {
							kind: 'reauthorize',
							accountId: existing.accountId,
							applicationId: existing.applicationId,
							authorizationId: existing.authorizationId,
							authorizationMetadataRevision: existing.authorizationMetadataRevision,
							generation: existing.generation,
							providerSubject: existing.providerSubject,
						},
					},
		);
		const result = await fixture.callback.handleGoogleCallback(callbackInput);
		if (result.kind !== 'confirmation') throw new Error('Expected actual callback confirmation.');
		const claim = fixture.store.beginCompletionCommit({
			identity: callbackIdentity,
			browserBindingSecret: result.confirmation.browserBindingSecret,
			completionSessionId: oauthCompletionSessionIdSchema.parse(
				result.confirmation.completionSessionId,
			),
			csrfToken: result.confirmation.csrfToken,
		});
		if (claim.kind !== 'accepted') throw new Error('Expected one-use confirmation claim.');
		const containAuthorizationMaterial = vi.fn<ContainmentCallback>(
			async () => props.containment ?? 'contained',
		);
		const committer = createGoogleAuthorizationCommitter({
			catalog,
			config: fixture.config,
			configRevision: 'test-config',
			clientCredentialsByApplication: {
				'gmail-app': clientCredentials,
				'workspace-app': clientCredentials,
				'youtube-app': clientCredentials,
			},
			clientBindingRevisionsByApplication: {
				'gmail-app': 'test-client-binding',
				'workspace-app': 'test-client-binding',
				'youtube-app': 'test-client-binding',
			},
			permissionPolicy: createGoogleOAuthPermissionPolicy({
				config: fixture.config,
				offeredGroupIdsByAgentApplication: {
					sun: { 'gmail-app': ['gmail.read', 'gmail.write'] },
					ember: { 'gmail-app': ['gmail.read'] },
				},
			}),
			keyEncryptionKey: wrappingKey,
			keyEncryptionKeyVersion: 1,
			now: () => 1_000,
			isAdmissionOpen: () => true,
			containAuthorizationMaterial,
		});
		return { committer, containAuthorizationMaterial, fixture, session: claim.session };
	}

	it('joins real callback confirmation to an independently encrypted grant, inherit policy and history', async () => {
		// Arrange
		const { committer, session, containAuthorizationMaterial } = await arrange();
		// Act
		const result = await committer.commitConfirmedGrant({ session, accountAlias: 'My mailbox' });
		// Assert
		expect(result.kind).toBe('committed');
		if (result.kind !== 'committed') throw new Error('Expected committed authorization.');
		const authorization = result.authorization;
		expect(authorization.accessState).toBe('connected');
		expect(authorization.generation).toBe(1);
		expect(authorization.owner).toEqual(owner);
		if (authorization.credentialId === null) throw new Error('Expected credential.');
		const grant = catalog.getGrant(authorization.credentialId);
		if (grant === undefined) throw new Error('Expected readable grant.');
		expect(
			decryptGoogleCredentialPayload({ grant, keyEncryptionKey: wrappingKey }).authority
				.accountAlias,
		).toBe('My mailbox');
		expect(catalog.getPolicy(authorization.authorizationId)?.state).toBe('active');
		expect(catalog.listAuthorizationHistory(authorization.authorizationId)).toHaveLength(2);
		expect(containAuthorizationMaterial).not.toHaveBeenCalled();
		expect((await committer.commitConfirmedGrant({ session, accountAlias: 'changed' })).kind).toBe(
			'duplicate-authorization',
		);
	});

	it('commits two agents for one account with distinct credentials and provider payloads', async () => {
		// Arrange
		const first = await arrange({ agentId: 'sun' });
		const second = await arrange({ agentId: 'ember' });
		// Act
		const sun = await first.committer.commitConfirmedGrant({
			session: first.session,
			accountAlias: 'Sun mailbox',
		});
		const ember = await second.committer.commitConfirmedGrant({
			session: second.session,
			accountAlias: 'Ember mailbox',
		});
		// Assert
		if (sun.kind !== 'committed' || ember.kind !== 'committed')
			throw new Error('Expected two independent grants.');
		expect(sun.authorization.accountId).toBe(ember.authorization.accountId);
		expect(sun.authorization.authorizationId).not.toBe(ember.authorization.authorizationId);
		expect(sun.authorization.credentialId).not.toBe(ember.authorization.credentialId);
		for (const authorization of [sun.authorization, ember.authorization]) {
			if (authorization.credentialId === null) throw new Error('Expected credential.');
			const grant = catalog.getGrant(authorization.credentialId);
			if (grant === undefined) throw new Error('Expected stored grant.');
			expect(
				decryptGoogleCredentialPayload({ grant, keyEncryptionKey: wrappingKey }).refreshToken,
			).toBe(`synthetic-refresh-${authorization.agentId}`);
		}
	});

	it.each(['contained', 'pending', 'failed'] as const)(
		'keeps replacement unavailable until old material is %s',
		async (containment) => {
			// Arrange
			const existing = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
			const { committer, session, containAuthorizationMaterial } = await arrange({
				existing,
				containment,
			});
			const beforePolicy = catalog.getPolicy(existing.authorizationId);
			// Act
			const result = await committer.commitConfirmedGrant({
				session,
				accountAlias: 'Updated alias',
			});
			// Assert
			expect(result.kind).toBe(
				containment === 'contained'
					? 'committed'
					: containment === 'pending'
						? 'replacement-pending'
						: 'containment-failed',
			);
			const after = catalog.getAuthorization(existing.authorizationId);
			expect(after?.generation).toBe(2);
			expect(after?.credentialId).not.toBe(existing.credentialId);
			expect(after?.accessState).toBe(containment === 'contained' ? 'connected' : 'replacing');
			expect(catalog.getGrant(existing.credentialId)).toBeUndefined();
			expect(catalog.getPolicy(existing.authorizationId)).toEqual(beforePolicy);
			expect(containAuthorizationMaterial).toHaveBeenCalledWith({
				accountId: existing.accountId,
				agentId: 'sun',
				applicationId: existing.applicationId,
				authorizationId: existing.authorizationId,
				throughGeneration: 1,
				zoneId: 'test-zone',
			});
		},
	);

	it('lets a newer disconnect win while replacement containment is pending', async () => {
		// Arrange
		const existing = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		const { committer, session, containAuthorizationMaterial } = await arrange({ existing });
		containAuthorizationMaterial.mockImplementationOnce(async () => {
			const replacing = catalog.getAuthorization(existing.authorizationId);
			if (replacing === undefined) throw new Error('Expected replacement fence.');
			expect(
				catalog.disconnectAuthorization({
					authorizationId: replacing.authorizationId,
					expectedRecordRevision: replacing.recordRevision,
					owner,
				}).kind,
			).toBe('updated');
			return 'contained';
		});
		// Act
		const result = await committer.commitConfirmedGrant({ session, accountAlias: 'My mailbox' });
		// Assert
		expect(result.kind).toBe('stale-authorization');
		expect(catalog.getAuthorization(existing.authorizationId)?.accessState).toBe('disconnecting');
		expect(catalog.getAuthorization(existing.authorizationId)?.credentialId).toBeNull();
	});

	it.each(['owner', 'config', 'subject', 'expiry'] as const)(
		'rejects changed %s at final commit',
		async (changed) => {
			// Arrange
			const { committer, session, fixture } = await arrange();
			let candidate: Extract<
				OAuthCompletionSession<GoogleProviderAuthorization>,
				{ kind: 'committing' }
			> = session;
			if (changed === 'owner') delete fixture.config.owners.owner;
			if (changed === 'config') candidate = { ...session, configRevision: 'old-config' };
			if (changed === 'expiry') candidate = { ...session, expiresAtMs: 500 };
			if (changed === 'subject')
				candidate = {
					...session,
					target: {
						kind: 'enroll',
						applicationId: session.applicationId,
						accountBinding: { accountId: existingAccountId, providerSubject: 'another-subject' },
					},
				};
			// Act
			const result = await committer.commitConfirmedGrant({
				session: candidate,
				accountAlias: 'My mailbox',
			});
			// Assert
			expect(result.kind).not.toBe('committed');
			expect(catalog.listAuthorizationsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual(
				[],
			);
		},
	);
});
