import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthProviderIdSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createOAuthEnvelopeCodec, oauthEnvelopeBindingSchema } from './envelope-codec.js';
import {
	openOAuthCredentialCatalog,
	type OAuthCredentialCatalog,
	type OAuthEnrollmentGrantInput,
} from './oauth-credential-catalog.js';

const providerPayloadSchema = z
	.object({
		accessToken: z.string().min(1),
		accessTokenExpiresAtMs: z.number().int().positive(),
		refreshToken: z.string().min(1),
	})
	.strict();

const keyEncryptionKey = new Uint8Array(32).fill(73);
const credentialId = oauthCredentialIdSchema.parse('11111111-1111-4111-8111-111111111111');
const accountProfileId = oauthAccountProfileIdSchema.parse('personal-google');
const applicationId = oauthApplicationIdSchema.parse('gmail-app');
const providerId = oauthProviderIdSchema.parse('google');
const grantedScopes = [oauthScopeSchema.parse('gmail.readonly')];
const initialMaterialRevision = oauthMaterialRevisionSchema.parse(
	'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
);
const refreshedMaterialRevision = oauthMaterialRevisionSchema.parse(
	'sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
);

let openCatalog: OAuthCredentialCatalog | undefined;

afterEach(() => {
	openCatalog?.close();
	openCatalog = undefined;
});

function createEnrollmentInput(props: {
	readonly accessToken: string;
	readonly databaseCredentialId?: typeof credentialId;
	readonly providerSubject?: string;
}): OAuthEnrollmentGrantInput {
	const selectedCredentialId = props.databaseCredentialId ?? credentialId;
	const providerSubject = props.providerSubject ?? 'google-subject-1';
	const codec = createOAuthEnvelopeCodec({ payloadSchema: providerPayloadSchema });
	const envelope = codec.encrypt({
		binding: oauthEnvelopeBindingSchema.parse({
			accountProfileId,
			applicationId,
			credentialId: selectedCredentialId,
			providerId,
			providerSubject,
		}),
		keyEncryptionKey,
		keyEncryptionKeyVersion: 1,
		payload: {
			accessToken: props.accessToken,
			accessTokenExpiresAtMs: 2_000_000,
			refreshToken: 'refresh-token-marker',
		},
	});
	return {
		accountLabel: 'Personal Google',
		accountProfileId,
		accountProfileStatus: 'enrolled',
		agentId: 'hermes',
		applicationId,
		credentialId: selectedCredentialId,
		envelope,
		grantedScopes,
		materialRevision: initialMaterialRevision,
		providerCredentialVersion: 1,
		providerId,
		providerSubject,
		zoneId: 'apollofam',
	};
}

async function readCatalogFiles(databasePath: string): Promise<Buffer> {
	const contents = await Promise.all(
		[databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(
			async (filePath) =>
				await readFile(filePath).catch((error: unknown) => {
					const errorCode =
						typeof error === 'object' && error !== null && 'code' in error
							? Reflect.get(error, 'code')
							: undefined;
					if (errorCode === 'ENOENT') return Buffer.alloc(0);
					throw error;
				}),
		),
	);
	return Buffer.concat(contents);
}

describe('OAuth credential catalog', () => {
	it('migrates, commits, encrypts, refreshes atomically, and reopens', async () => {
		const stateDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-oauth-catalog-'));
		const databasePath = path.join(stateDirectory, 'oauth', 'credentials.sqlite');
		let nowMs = 1_000;
		openCatalog = await openOAuthCredentialCatalog({ databasePath, now: () => nowMs });
		const initialInput = createEnrollmentInput({ accessToken: 'access-token-marker-v1' });
		const committed = openCatalog.commitEnrollmentGrant(initialInput);
		expect(committed).toMatchObject({ kind: 'committed' });
		if (committed.kind !== 'committed') throw new Error('Expected committed OAuth grant.');
		expect(committed.grant.accountProfileStatus).toBe('enrolled');
		expect(committed.grant.recordRevision).toBe(1);
		expect(
			openCatalog.getGrantForAccountApplication({
				accountProfileId,
				agentId: 'hermes',
				applicationId,
				zoneId: 'apollofam',
			}),
		).toMatchObject({ credentialId });
		expect(openCatalog.listGrantsForAgent({ agentId: 'hermes', zoneId: 'apollofam' })).toHaveLength(
			1,
		);

		const codec = createOAuthEnvelopeCodec({ payloadSchema: providerPayloadSchema });
		expect(
			codec.decrypt({
				binding: oauthEnvelopeBindingSchema.parse({
					accountProfileId,
					applicationId,
					credentialId,
					providerId,
					providerSubject: 'google-subject-1',
				}),
				envelope: committed.grant.envelope,
				keyEncryptionKey,
			}),
		).toMatchObject({ accessToken: 'access-token-marker-v1' });
		expect((await readCatalogFiles(databasePath)).includes('access-token-marker-v1')).toBe(false);
		expect((await readCatalogFiles(databasePath)).includes('refresh-token-marker')).toBe(false);

		nowMs = 2_000;
		const refreshedEnvelope = codec.encrypt({
			binding: oauthEnvelopeBindingSchema.parse({
				accountProfileId,
				applicationId,
				credentialId,
				providerId,
				providerSubject: 'google-subject-1',
			}),
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload: {
				accessToken: 'access-token-marker-v2',
				accessTokenExpiresAtMs: 3_000_000,
				refreshToken: 'rotated-refresh-token-marker',
			},
		});
		const refreshed = openCatalog.replaceGrantEnvelope({
			credentialId,
			envelope: refreshedEnvelope,
			expectedRecordRevision: committed.grant.recordRevision,
			failureClass: null,
			lastRefreshAttemptAtMs: 1_900,
			lastRefreshSucceededAtMs: 2_000,
			lifecycleKind: 'active',
			materialRevision: refreshedMaterialRevision,
			nextRefreshEligibleAtMs: null,
			providerCredentialVersion: 2,
			reauthorizationReason: null,
		});
		expect(refreshed).toMatchObject({ kind: 'updated', grant: { recordRevision: 2 } });
		const reauthorized = openCatalog.commitEnrollmentGrant(
			createEnrollmentInput({ accessToken: 'reauthorized-access-token-marker' }),
		);
		expect(reauthorized).toMatchObject({ kind: 'committed', grant: { recordRevision: 3 } });
		expect(
			openCatalog.replaceGrantEnvelope({
				credentialId,
				envelope: initialInput.envelope,
				expectedRecordRevision: 1,
				failureClass: null,
				lastRefreshAttemptAtMs: 2_100,
				lastRefreshSucceededAtMs: null,
				lifecycleKind: 'degraded',
				materialRevision: initialMaterialRevision,
				nextRefreshEligibleAtMs: 3_100,
				providerCredentialVersion: 1,
				reauthorizationReason: null,
			}),
		).toEqual({ currentRecordRevision: 3, kind: 'stale' });

		openCatalog.close();
		openCatalog = undefined;
		expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
		expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
		openCatalog = await openOAuthCredentialCatalog({ databasePath, now: () => nowMs });
		const reopened = openCatalog.getGrant(credentialId);
		expect(reopened).toMatchObject({
			materialRevision: initialMaterialRevision,
			recordRevision: 3,
		});
		if (reopened === undefined) throw new Error('Expected reopened OAuth grant.');
		expect(
			codec.decrypt({
				binding: oauthEnvelopeBindingSchema.parse({
					accountProfileId,
					applicationId,
					credentialId,
					providerId,
					providerSubject: 'google-subject-1',
				}),
				envelope: reopened.envelope,
				keyEncryptionKey,
			}),
		).toMatchObject({ accessToken: 'reauthorized-access-token-marker' });
		expect(openCatalog.getStorageDiagnostics()).toEqual({
			busyTimeoutMs: 5_000,
			foreignKeysEnabled: true,
			journalMode: 'wal',
			synchronousMode: 2,
		});
	}, 30_000);

	it('fails a different-subject enrollment without changing the existing grant', async () => {
		const stateDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-oauth-subject-'));
		const databasePath = path.join(stateDirectory, 'oauth', 'credentials.sqlite');
		openCatalog = await openOAuthCredentialCatalog({ databasePath, now: () => 5_000 });
		const initial = openCatalog.commitEnrollmentGrant(
			createEnrollmentInput({ accessToken: 'subject-bound-token' }),
		);
		expect(initial.kind).toBe('committed');

		const otherCredentialId = oauthCredentialIdSchema.parse('22222222-2222-4222-8222-222222222222');
		const mismatch = openCatalog.commitEnrollmentGrant(
			createEnrollmentInput({
				accessToken: 'must-not-commit',
				databaseCredentialId: otherCredentialId,
				providerSubject: 'different-google-subject',
			}),
		);
		expect(mismatch).toEqual({
			actualProviderSubject: 'different-google-subject',
			expectedProviderSubject: 'google-subject-1',
			kind: 'subject-mismatch',
		});
		expect(openCatalog.getGrant(credentialId)).toBeDefined();
		expect(openCatalog.getGrant(otherCredentialId)).toBeUndefined();
	}, 30_000);
});
