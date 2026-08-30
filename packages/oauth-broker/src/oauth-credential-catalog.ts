import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthProviderIdSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';
import BetterSqlite3 from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';

import {
	oauthAccountProfilesTable,
	oauthCatalogSchema,
	oauthGrantsTable,
} from './catalog-schema.js';
import {
	encryptedOAuthEnvelopeSchema,
	oauthProviderSubjectSchema,
	type EncryptedOAuthEnvelope,
} from './envelope-codec.js';

const oauthGrantLifecycleKindSchema = z.enum(['active', 'degraded', 'reauthorization-required']);

export const oauthStoredGrantSchema = z
	.object({
		accountLabel: z.string().min(1).max(320),
		accountProfileId: oauthAccountProfileIdSchema,
		accountProfileStatus: z.enum(['partially-enrolled', 'enrolled']),
		agentId: z.string().min(1).max(128),
		applicationId: oauthApplicationIdSchema,
		credentialId: oauthCredentialIdSchema,
		envelope: encryptedOAuthEnvelopeSchema,
		failureClass: z.string().min(1).max(128).nullable(),
		grantedScopes: z.array(oauthScopeSchema).readonly(),
		lastRefreshAttemptAtMs: z.number().int().nonnegative().nullable(),
		lastRefreshSucceededAtMs: z.number().int().nonnegative().nullable(),
		lifecycleKind: oauthGrantLifecycleKindSchema,
		materialRevision: oauthMaterialRevisionSchema,
		nextRefreshEligibleAtMs: z.number().int().nonnegative().nullable(),
		profileRecordId: z.uuid(),
		providerCredentialVersion: z.number().int().positive(),
		providerId: oauthProviderIdSchema,
		providerSubject: oauthProviderSubjectSchema,
		reauthorizationReason: z.string().min(1).max(128).nullable(),
		recordRevision: z.number().int().positive(),
		updatedAtMs: z.number().int().nonnegative(),
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthStoredGrant = z.infer<typeof oauthStoredGrantSchema>;

export const oauthEnrollmentGrantInputSchema = z
	.object({
		accountLabel: z.string().min(1).max(320),
		accountProfileId: oauthAccountProfileIdSchema,
		accountProfileStatus: z.enum(['partially-enrolled', 'enrolled']),
		agentId: z.string().min(1).max(128),
		applicationId: oauthApplicationIdSchema,
		credentialId: oauthCredentialIdSchema,
		envelope: encryptedOAuthEnvelopeSchema,
		grantedScopes: z.array(oauthScopeSchema).min(1).readonly(),
		materialRevision: oauthMaterialRevisionSchema,
		providerCredentialVersion: z.number().int().positive(),
		providerId: oauthProviderIdSchema,
		providerSubject: oauthProviderSubjectSchema,
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthEnrollmentGrantInput = z.infer<typeof oauthEnrollmentGrantInputSchema>;

export const oauthReplaceGrantEnvelopeInputSchema = z
	.object({
		credentialId: oauthCredentialIdSchema,
		envelope: encryptedOAuthEnvelopeSchema,
		expectedRecordRevision: z.number().int().positive(),
		failureClass: z.string().min(1).max(128).nullable(),
		lastRefreshAttemptAtMs: z.number().int().nonnegative(),
		lastRefreshSucceededAtMs: z.number().int().nonnegative().nullable(),
		lifecycleKind: oauthGrantLifecycleKindSchema,
		materialRevision: oauthMaterialRevisionSchema,
		nextRefreshEligibleAtMs: z.number().int().nonnegative().nullable(),
		providerCredentialVersion: z.number().int().positive(),
		reauthorizationReason: z.string().min(1).max(128).nullable(),
	})
	.strict();
export type OAuthReplaceGrantEnvelopeInput = z.infer<typeof oauthReplaceGrantEnvelopeInputSchema>;

export type OAuthCommitEnrollmentResult =
	| { readonly grant: OAuthStoredGrant; readonly kind: 'committed' }
	| {
			readonly actualProviderSubject: string;
			readonly expectedProviderSubject: string;
			readonly kind: 'subject-mismatch';
	  };

export type OAuthReplaceGrantEnvelopeResult =
	| { readonly grant: OAuthStoredGrant; readonly kind: 'updated' }
	| { readonly kind: 'missing' }
	| { readonly currentRecordRevision: number; readonly kind: 'stale' };

export interface OAuthCredentialCatalog {
	close(): void;
	commitEnrollmentGrant(input: OAuthEnrollmentGrantInput): OAuthCommitEnrollmentResult;
	deleteGrantForAccountApplication(props: {
		readonly accountProfileId: z.infer<typeof oauthAccountProfileIdSchema>;
		readonly agentId: string;
		readonly applicationId: z.infer<typeof oauthApplicationIdSchema>;
		readonly zoneId: string;
	}): 'deleted' | 'missing';
	getGrant(credentialId: z.infer<typeof oauthCredentialIdSchema>): OAuthStoredGrant | undefined;
	getGrantForAccountApplication(props: {
		readonly accountProfileId: z.infer<typeof oauthAccountProfileIdSchema>;
		readonly agentId: string;
		readonly applicationId: z.infer<typeof oauthApplicationIdSchema>;
		readonly zoneId: string;
	}): OAuthStoredGrant | undefined;
	getStorageDiagnostics(): {
		readonly busyTimeoutMs: number;
		readonly foreignKeysEnabled: boolean;
		readonly journalMode: string;
		readonly synchronousMode: number;
	};
	listGrantsForAgent(props: {
		readonly agentId: string;
		readonly zoneId: string;
	}): readonly OAuthStoredGrant[];
	replaceGrantEnvelope(props: OAuthReplaceGrantEnvelopeInput): OAuthReplaceGrantEnvelopeResult;
}

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
				const grant = queryGrantsForAgent(database, deleteProps).find(
					(candidate) =>
						candidate.accountProfileId ===
							oauthAccountProfileIdSchema.parse(deleteProps.accountProfileId) &&
						candidate.applicationId === oauthApplicationIdSchema.parse(deleteProps.applicationId),
				);
				if (grant === undefined) return 'missing';
				database
					.delete(oauthGrantsTable)
					.where(eq(oauthGrantsTable.credentialId, grant.credentialId))
					.run();
				return 'deleted';
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
		};
	} catch (error: unknown) {
		sqlite.close();
		throw error;
	}
}
