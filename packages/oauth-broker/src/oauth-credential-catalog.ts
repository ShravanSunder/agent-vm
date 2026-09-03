import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthCredentialIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import BetterSqlite3 from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';

import {
	oauthAccountProfilesTable,
	oauthCatalogSchema,
	oauthGrantsTable,
	oauthSchemaMetadataTable,
} from './catalog-schema.js';
import { encryptedOAuthEnvelopeSchema, type EncryptedOAuthEnvelope } from './envelope-codec.js';
import {
	oauthEnrollmentGrantInputSchema,
	oauthReplaceGrantEnvelopeInputSchema,
	oauthStoredAccountProfileMetadataSchema,
	oauthStoredGrantSchema,
	type OAuthCommitEnrollmentResult,
	type OAuthCredentialCatalog,
	type OAuthDeleteGrantResult,
	type OAuthReplaceGrantEnvelopeResult,
	type OAuthStoredGrant,
} from './oauth-credential-catalog-contracts.js';

type OAuthCatalogDatabase = BetterSQLite3Database<typeof oauthCatalogSchema>;

function storedEnvelopeFromRow(row: typeof oauthGrantsTable.$inferSelect): EncryptedOAuthEnvelope {
	return encryptedOAuthEnvelopeSchema.parse({
		dekCiphertext: row.dekCiphertext,
		dekWrapAlgorithm: row.dekWrapAlgorithm,
		dekWrapNonce: row.dekWrapNonce,
		envelopeVersion: row.envelopeVersion,
		keyEncryptionKeyVersion: row.keyEncryptionKeyVersion,
		payloadAlgorithm: row.payloadAlgorithm,
		payloadCiphertext: row.payloadCiphertext,
		payloadNonce: row.payloadNonce,
	});
}

function grantFromRows(props: {
	readonly grant: typeof oauthGrantsTable.$inferSelect;
	readonly profile: typeof oauthAccountProfilesTable.$inferSelect;
}): OAuthStoredGrant {
	if (props.profile.accountLabel === null || props.profile.providerSubject === null) {
		throw new Error('OAuth grant references an unbound account profile.');
	}
	return oauthStoredGrantSchema.parse({
		accountLabel: props.profile.accountLabel,
		accountProfileId: props.profile.accountProfileId,
		accountProfileStatus: props.profile.status,
		agentId: props.profile.agentId,
		applicationId: props.grant.applicationId,
		credentialId: props.grant.credentialId,
		envelope: storedEnvelopeFromRow(props.grant),
		failureClass: props.grant.failureClass,
		grantedScopes: props.grant.grantedScopes,
		lastRefreshAttemptAtMs: props.grant.lastRefreshAttemptAtMs,
		lastRefreshSucceededAtMs: props.grant.lastRefreshSucceededAtMs,
		lifecycleKind: props.grant.lifecycleKind,
		materialRevision: props.grant.materialRevision,
		nextRefreshEligibleAtMs: props.grant.nextRefreshEligibleAtMs,
		profileRecordId: props.profile.profileRecordId,
		providerCredentialVersion: props.grant.providerCredentialVersion,
		providerId: props.profile.providerId,
		providerSubject: props.profile.providerSubject,
		reauthorizationReason: props.grant.reauthorizationReason,
		recordRevision: props.grant.recordRevision,
		updatedAtMs: props.grant.updatedAtMs,
		zoneId: props.profile.zoneId,
	});
}

function queryGrant(
	database: OAuthCatalogDatabase,
	credentialId: z.infer<typeof oauthCredentialIdSchema>,
): OAuthStoredGrant | undefined {
	const rows = database
		.select({ grant: oauthGrantsTable, profile: oauthAccountProfilesTable })
		.from(oauthGrantsTable)
		.innerJoin(
			oauthAccountProfilesTable,
			eq(oauthGrantsTable.profileRecordId, oauthAccountProfilesTable.profileRecordId),
		)
		.where(eq(oauthGrantsTable.credentialId, credentialId))
		.limit(1)
		.all();
	const row = rows[0];
	return row === undefined ? undefined : grantFromRows(row);
}

function queryGrantsForAgent(
	database: OAuthCatalogDatabase,
	props: { readonly agentId: string; readonly zoneId: string },
): readonly OAuthStoredGrant[] {
	return database
		.select({ grant: oauthGrantsTable, profile: oauthAccountProfilesTable })
		.from(oauthGrantsTable)
		.innerJoin(
			oauthAccountProfilesTable,
			eq(oauthGrantsTable.profileRecordId, oauthAccountProfilesTable.profileRecordId),
		)
		.where(
			and(
				eq(oauthAccountProfilesTable.agentId, z.string().min(1).max(128).parse(props.agentId)),
				eq(oauthAccountProfilesTable.zoneId, z.string().min(1).max(128).parse(props.zoneId)),
			),
		)
		.all()
		.map((row) => grantFromRows(row));
}

async function hardenCatalogPaths(databasePath: string): Promise<void> {
	await chmod(path.dirname(databasePath), 0o700);
	for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
		await chmod(filePath, 0o600).catch((error: unknown) => {
			const errorCode =
				typeof error === 'object' && error !== null && 'code' in error
					? Reflect.get(error, 'code')
					: undefined;
			if (errorCode !== 'ENOENT') throw error;
		});
	}
}

export async function openOAuthCredentialCatalog(props: {
	readonly busyTimeoutMs?: number;
	readonly databasePath: string;
	readonly migrationsFolder?: string;
	readonly now?: () => number;
}): Promise<OAuthCredentialCatalog> {
	const now = props.now ?? Date.now;
	const busyTimeoutMs = props.busyTimeoutMs ?? 5_000;
	if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > 60_000) {
		throw new Error('OAuth SQLite busy timeout must be between 1 and 60000 milliseconds.');
	}
	await mkdir(path.dirname(props.databasePath), { mode: 0o700, recursive: true });
	const sqlite = new BetterSqlite3(props.databasePath, { timeout: busyTimeoutMs });
	try {
		sqlite.pragma('journal_mode = WAL');
		sqlite.pragma('foreign_keys = ON');
		sqlite.pragma('synchronous = FULL');
		sqlite.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
		const database = drizzle(sqlite, { schema: oauthCatalogSchema });
		migrate(database, {
			migrationsFolder:
				props.migrationsFolder ?? fileURLToPath(new URL('../drizzle', import.meta.url)),
		});
		await hardenCatalogPaths(props.databasePath);

		const getGrant = (
			credentialId: z.infer<typeof oauthCredentialIdSchema>,
		): OAuthStoredGrant | undefined => queryGrant(database, credentialId);

		return {
			close: (): void => {
				sqlite.pragma('wal_checkpoint(TRUNCATE)');
				sqlite.close();
			},
			commitEnrollmentGrant: (input): OAuthCommitEnrollmentResult => {
				const parsedInput = oauthEnrollmentGrantInputSchema.parse(input);
				return database.transaction((transaction) => {
					const existingProfile = transaction
						.select()
						.from(oauthAccountProfilesTable)
						.where(
							and(
								eq(oauthAccountProfilesTable.zoneId, parsedInput.zoneId),
								eq(oauthAccountProfilesTable.agentId, parsedInput.agentId),
								eq(oauthAccountProfilesTable.accountProfileId, parsedInput.accountProfileId),
							),
						)
						.limit(1)
						.get();
					if (
						existingProfile?.providerSubject !== null &&
						existingProfile?.providerSubject !== undefined &&
						existingProfile.providerSubject !== parsedInput.providerSubject
					) {
						return {
							actualProviderSubject: parsedInput.providerSubject,
							expectedProviderSubject: existingProfile.providerSubject,
							kind: 'subject-mismatch' as const,
						};
					}
					const timestampMs = now();
					const profileRecordId = existingProfile?.profileRecordId ?? randomUUID();
					const existingGrant = transaction
						.select({ recordRevision: oauthGrantsTable.recordRevision })
						.from(oauthGrantsTable)
						.where(
							and(
								eq(oauthGrantsTable.profileRecordId, profileRecordId),
								eq(oauthGrantsTable.applicationId, parsedInput.applicationId),
							),
						)
						.limit(1)
						.get();
					const nextGrantRecordRevision = (existingGrant?.recordRevision ?? 0) + 1;
					transaction
						.insert(oauthAccountProfilesTable)
						.values({
							accountLabel: parsedInput.accountLabel,
							accountProfileId: parsedInput.accountProfileId,
							agentId: parsedInput.agentId,
							createdAtMs: existingProfile?.createdAtMs ?? timestampMs,
							profileRecordId,
							providerId: parsedInput.providerId,
							providerSubject: parsedInput.providerSubject,
							recordRevision: (existingProfile?.recordRevision ?? 0) + 1,
							status: parsedInput.accountProfileStatus,
							updatedAtMs: timestampMs,
							zoneId: parsedInput.zoneId,
						})
						.onConflictDoUpdate({
							set: {
								accountLabel: parsedInput.accountLabel,
								providerSubject: parsedInput.providerSubject,
								recordRevision: (existingProfile?.recordRevision ?? 0) + 1,
								status: parsedInput.accountProfileStatus,
								updatedAtMs: timestampMs,
							},
							target: oauthAccountProfilesTable.profileRecordId,
						})
						.run();
					const envelope = parsedInput.envelope;
					transaction
						.insert(oauthGrantsTable)
						.values({
							applicationId: parsedInput.applicationId,
							credentialId: parsedInput.credentialId,
							dekCiphertext: envelope.dekCiphertext,
							dekWrapAlgorithm: envelope.dekWrapAlgorithm,
							dekWrapNonce: envelope.dekWrapNonce,
							envelopeVersion: envelope.envelopeVersion,
							failureClass: null,
							grantedScopes: parsedInput.grantedScopes,
							keyEncryptionKeyVersion: envelope.keyEncryptionKeyVersion,
							lastRefreshAttemptAtMs: null,
							lastRefreshSucceededAtMs: null,
							lifecycleKind: 'active',
							materialRevision: parsedInput.materialRevision,
							nextRefreshEligibleAtMs: null,
							payloadAlgorithm: envelope.payloadAlgorithm,
							payloadCiphertext: envelope.payloadCiphertext,
							payloadNonce: envelope.payloadNonce,
							profileRecordId,
							providerCredentialVersion: parsedInput.providerCredentialVersion,
							reauthorizationReason: null,
							recordRevision: nextGrantRecordRevision,
							updatedAtMs: timestampMs,
						})
						.onConflictDoUpdate({
							set: {
								dekCiphertext: envelope.dekCiphertext,
								dekWrapAlgorithm: envelope.dekWrapAlgorithm,
								dekWrapNonce: envelope.dekWrapNonce,
								envelopeVersion: envelope.envelopeVersion,
								failureClass: null,
								grantedScopes: parsedInput.grantedScopes,
								keyEncryptionKeyVersion: envelope.keyEncryptionKeyVersion,
								lifecycleKind: 'active',
								materialRevision: parsedInput.materialRevision,
								payloadAlgorithm: envelope.payloadAlgorithm,
								payloadCiphertext: envelope.payloadCiphertext,
								payloadNonce: envelope.payloadNonce,
								providerCredentialVersion: parsedInput.providerCredentialVersion,
								reauthorizationReason: null,
								recordRevision: nextGrantRecordRevision,
								updatedAtMs: timestampMs,
							},
							target: [oauthGrantsTable.profileRecordId, oauthGrantsTable.applicationId],
						})
						.run();
					const grant = queryGrant(transaction, parsedInput.credentialId);
					if (grant === undefined) throw new Error('Committed OAuth grant could not be reloaded.');
					return { grant, kind: 'committed' as const };
				});
			},
			deleteGrantForAccountApplication: (deleteProps) => {
				const expectedCredentialId = oauthCredentialIdSchema.parse(
					deleteProps.expectedCredentialId,
				);
				const expectedRecordRevision = z
					.number()
					.int()
					.positive()
					.parse(deleteProps.expectedRecordRevision);
				return database.transaction((transaction): OAuthDeleteGrantResult => {
					const grant = queryGrantsForAgent(transaction, deleteProps).find(
						(candidate) =>
							candidate.accountProfileId ===
								oauthAccountProfileIdSchema.parse(deleteProps.accountProfileId) &&
							candidate.applicationId === oauthApplicationIdSchema.parse(deleteProps.applicationId),
					);
					if (grant === undefined) return { kind: 'missing' };
					if (
						grant.credentialId !== expectedCredentialId ||
						grant.recordRevision !== expectedRecordRevision
					) {
						return {
							currentCredentialId: grant.credentialId,
							currentRecordRevision: grant.recordRevision,
							kind: 'stale',
						};
					}
					transaction
						.delete(oauthGrantsTable)
						.where(
							and(
								eq(oauthGrantsTable.credentialId, expectedCredentialId),
								eq(oauthGrantsTable.recordRevision, expectedRecordRevision),
							),
						)
						.run();
					transaction
						.update(oauthAccountProfilesTable)
						.set({
							recordRevision: sql`${oauthAccountProfilesTable.recordRevision} + 1`,
							status: 'partially-enrolled',
							updatedAtMs: now(),
						})
						.where(eq(oauthAccountProfilesTable.profileRecordId, grant.profileRecordId))
						.run();
					return { kind: 'deleted' };
				});
			},
			getAccountProfileMetadata: (queryProps) => {
				const profile = database
					.select()
					.from(oauthAccountProfilesTable)
					.where(
						and(
							eq(
								oauthAccountProfilesTable.zoneId,
								z.string().min(1).max(128).parse(queryProps.zoneId),
							),
							eq(
								oauthAccountProfilesTable.agentId,
								z.string().min(1).max(128).parse(queryProps.agentId),
							),
							eq(
								oauthAccountProfilesTable.accountProfileId,
								oauthAccountProfileIdSchema.parse(queryProps.accountProfileId),
							),
						),
					)
					.limit(1)
					.get();
				if (
					profile === undefined ||
					profile.accountLabel === null ||
					profile.providerSubject === null
				)
					return undefined;
				return oauthStoredAccountProfileMetadataSchema.parse({
					accountLabel: profile.accountLabel,
					accountProfileId: profile.accountProfileId,
					agentId: profile.agentId,
					providerSubject: profile.providerSubject,
					status: profile.status,
					zoneId: profile.zoneId,
				});
			},
			getGrant,
			getGrantForAccountApplication: (queryProps) =>
				queryGrantsForAgent(database, queryProps).find(
					(grant) =>
						grant.accountProfileId ===
							oauthAccountProfileIdSchema.parse(queryProps.accountProfileId) &&
						grant.applicationId === oauthApplicationIdSchema.parse(queryProps.applicationId),
				),
			getStorageDiagnostics: () => ({
				busyTimeoutMs: z
					.number()
					.int()
					.positive()
					.parse(sqlite.pragma('busy_timeout', { simple: true })),
				foreignKeysEnabled: sqlite.pragma('foreign_keys', { simple: true }) === 1,
				journalMode: z.string().parse(sqlite.pragma('journal_mode', { simple: true })),
				synchronousMode: z
					.number()
					.int()
					.parse(sqlite.pragma('synchronous', { simple: true })),
			}),
			listGrantsForAgent: (queryProps) => queryGrantsForAgent(database, queryProps),
			replaceGrantEnvelope: (unparsedReplacement): OAuthReplaceGrantEnvelopeResult => {
				const replacement = oauthReplaceGrantEnvelopeInputSchema.parse(unparsedReplacement);
				const current = getGrant(replacement.credentialId);
				if (current === undefined) return { kind: 'missing' };
				if (current.recordRevision !== replacement.expectedRecordRevision) {
					return { currentRecordRevision: current.recordRevision, kind: 'stale' };
				}
				const envelope = encryptedOAuthEnvelopeSchema.parse(replacement.envelope);
				const nextRecordRevision = current.recordRevision + 1;
				const updated = database
					.update(oauthGrantsTable)
					.set({
						dekCiphertext: envelope.dekCiphertext,
						dekWrapAlgorithm: envelope.dekWrapAlgorithm,
						dekWrapNonce: envelope.dekWrapNonce,
						envelopeVersion: envelope.envelopeVersion,
						failureClass: replacement.failureClass,
						keyEncryptionKeyVersion: envelope.keyEncryptionKeyVersion,
						lastRefreshAttemptAtMs: replacement.lastRefreshAttemptAtMs,
						lastRefreshSucceededAtMs: replacement.lastRefreshSucceededAtMs,
						lifecycleKind: replacement.lifecycleKind,
						materialRevision: replacement.materialRevision,
						nextRefreshEligibleAtMs: replacement.nextRefreshEligibleAtMs,
						payloadAlgorithm: envelope.payloadAlgorithm,
						payloadCiphertext: envelope.payloadCiphertext,
						payloadNonce: envelope.payloadNonce,
						providerCredentialVersion: replacement.providerCredentialVersion,
						reauthorizationReason: replacement.reauthorizationReason,
						recordRevision: nextRecordRevision,
						updatedAtMs: now(),
					})
					.where(
						and(
							eq(oauthGrantsTable.credentialId, replacement.credentialId),
							eq(oauthGrantsTable.recordRevision, replacement.expectedRecordRevision),
						),
					)
					.run();
				if (updated.changes !== 1) {
					const latest = getGrant(replacement.credentialId);
					return latest === undefined
						? { kind: 'missing' }
						: { currentRecordRevision: latest.recordRevision, kind: 'stale' };
				}
				const grant = getGrant(replacement.credentialId);
				if (grant === undefined) throw new Error('Updated OAuth grant could not be reloaded.');
				return { grant, kind: 'updated' };
			},
			verifyOrInitializeKeyEncryptionKey: (keyEncryptionKey): void => {
				if (keyEncryptionKey.byteLength !== 32) {
					throw new Error('OAuth key-encryption key must contain exactly 32 bytes.');
				}
				const metadataKey = 'kek-verifier-v1';
				const fingerprint = createHash('sha256')
					.update('agent-vm/oauth/kek-verifier/v1\0')
					.update(keyEncryptionKey)
					.digest('base64url');
				const existing = database
					.select()
					.from(oauthSchemaMetadataTable)
					.where(eq(oauthSchemaMetadataTable.key, metadataKey))
					.limit(1)
					.get();
				if (existing === undefined) {
					database
						.insert(oauthSchemaMetadataTable)
						.values({ key: metadataKey, value: fingerprint })
						.run();
					return;
				}
				const existingBytes = Buffer.from(existing.value);
				const fingerprintBytes = Buffer.from(fingerprint);
				if (
					existingBytes.byteLength !== fingerprintBytes.byteLength ||
					!timingSafeEqual(existingBytes, fingerprintBytes)
				) {
					throw new Error('OAuth key-encryption key does not match the catalog verifier.');
				}
			},
		};
	} catch (error: unknown) {
		sqlite.close();
		throw error;
	}
}
