import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const oauthAccountProfilesTable = sqliteTable(
	'oauth_account_profiles',
	{
		accountLabel: text('account_label'),
		accountProfileId: text('account_profile_id').notNull(),
		agentId: text('agent_id').notNull(),
		createdAtMs: integer('created_at_ms').notNull(),
		profileRecordId: text('profile_record_id').primaryKey(),
		providerId: text('provider_id').notNull(),
		providerSubject: text('provider_subject'),
		recordRevision: integer('record_revision').notNull(),
		status: text('status', { enum: ['partially-enrolled', 'enrolled'] }).notNull(),
		updatedAtMs: integer('updated_at_ms').notNull(),
		zoneId: text('zone_id').notNull(),
	},
	(table) => [
		uniqueIndex('oauth_account_profiles_zone_agent_profile_unique').on(
			table.zoneId,
			table.agentId,
			table.accountProfileId,
		),
	],
);

export const oauthGrantsTable = sqliteTable(
	'oauth_grants',
	{
		applicationId: text('application_id').notNull(),
		credentialId: text('credential_id').primaryKey(),
		dekCiphertext: text('dek_ciphertext').notNull(),
		dekWrapAlgorithm: text('dek_wrap_algorithm').notNull(),
		dekWrapNonce: text('dek_wrap_nonce').notNull(),
		envelopeVersion: integer('envelope_version').notNull(),
		failureClass: text('failure_class'),
		grantedScopes: text('granted_scopes', { mode: 'json' }).$type<readonly string[]>().notNull(),
		keyEncryptionKeyVersion: integer('key_encryption_key_version').notNull(),
		lastRefreshAttemptAtMs: integer('last_refresh_attempt_at_ms'),
		lastRefreshSucceededAtMs: integer('last_refresh_succeeded_at_ms'),
		lifecycleKind: text('lifecycle_kind', {
			enum: ['active', 'degraded', 'reauthorization-required'],
		}).notNull(),
		materialRevision: text('material_revision').notNull(),
		nextRefreshEligibleAtMs: integer('next_refresh_eligible_at_ms'),
		payloadAlgorithm: text('payload_algorithm').notNull(),
		payloadCiphertext: text('payload_ciphertext').notNull(),
		payloadNonce: text('payload_nonce').notNull(),
		profileRecordId: text('profile_record_id')
			.notNull()
			.references(() => oauthAccountProfilesTable.profileRecordId, { onDelete: 'cascade' }),
		providerCredentialVersion: integer('provider_credential_version').notNull(),
		reauthorizationReason: text('reauthorization_reason'),
		recordRevision: integer('record_revision').notNull(),
		updatedAtMs: integer('updated_at_ms').notNull(),
	},
	(table) => [
		uniqueIndex('oauth_grants_profile_application_unique').on(
			table.profileRecordId,
			table.applicationId,
		),
	],
);

export const oauthSchemaMetadataTable = sqliteTable('oauth_schema_metadata', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});

export const oauthCatalogSchema = {
	oauthAccountProfiles: oauthAccountProfilesTable,
	oauthGrants: oauthGrantsTable,
	oauthSchemaMetadata: oauthSchemaMetadataTable,
} as const;
