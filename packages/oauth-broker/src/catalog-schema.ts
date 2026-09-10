import type { GooglePolicyDefaultsSnapshot } from '@agent-vm/oauth-broker-contracts';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { EncryptedOAuthEnvelope } from './envelope-codec.js';
import type { OAuthPermissionChangeEvent } from './oauth-credential-catalog-contracts.js';

export const oauthAccountsTable = sqliteTable(
	'oauth_accounts',
	{
		accountId: text('account_id').primaryKey(),
		accountLabel: text('display_label').notNull(),
		createdAtMs: integer('created_at_ms').notNull(),
		ownerIssuer: text('owner_issuer').notNull(),
		ownerUserId: text('owner_user_id').notNull(),
		providerId: text('provider_id').notNull(),
		providerSubject: text('provider_subject').notNull(),
		recordRevision: integer('record_revision').notNull(),
		updatedAtMs: integer('updated_at_ms').notNull(),
		zoneId: text('zone_id').notNull(),
	},
	(table) => [
		uniqueIndex('oauth_accounts_subject_unique').on(
			table.zoneId,
			table.providerId,
			table.providerSubject,
		),
	],
);

export const oauthAgentAuthorizationsTable = sqliteTable(
	'oauth_agent_authorizations',
	{
		accountId: text('account_id')
			.notNull()
			.references(() => oauthAccountsTable.accountId),
		accountAlias: text('account_alias').notNull(),
		accessState: text('access_state', {
			enum: ['connected', 'replacing', 'disconnecting', 'disconnected'],
		}).notNull(),
		agentId: text('agent_id').notNull(),
		applicationId: text('application_id').notNull(),
		authorizationId: text('authorization_id').primaryKey(),
		authorizationMetadataRevision: integer('authorization_metadata_revision').notNull(),
		catalogVersion: text('catalog_version').notNull(),
		clientBindingRevision: text('client_binding_revision').notNull(),
		clientId: text('client_id').notNull(),
		credentialId: text('credential_id'),
		envelope: text('encrypted_envelope', { mode: 'json' }).$type<EncryptedOAuthEnvelope>(),
		failureClass: text('failure_class'),
		generation: integer('generation').notNull(),
		grantedScopes: text('actual_scopes_json', { mode: 'json' })
			.$type<readonly string[]>()
			.notNull(),
		lastRefreshAttemptAtMs: integer('last_refresh_attempt_at_ms'),
		lastRefreshSucceededAtMs: integer('last_refresh_succeeded_at_ms'),
		lifecycleKind: text('lifecycle_kind', {
			enum: ['active', 'degraded', 'reauthorization-required'],
		}).notNull(),
		materialRevision: text('material_revision'),
		nextRefreshEligibleAtMs: integer('next_refresh_eligible_at_ms'),
		providerCredentialVersion: integer('provider_credential_version').notNull(),
		reauthorizationReason: text('reauthorization_reason'),
		recordRevision: integer('record_revision').notNull(),
		requestedScopes: text('requested_scopes_json', { mode: 'json' })
			.$type<readonly string[]>()
			.notNull(),
		selectedGroupIds: text('selected_activities_json', { mode: 'json' })
			.$type<readonly string[]>()
			.notNull(),
		transitionId: text('transition_id').notNull(),
		updatedAtMs: integer('updated_at_ms').notNull(),
	},
	(table) => [
		uniqueIndex('oauth_agent_authorizations_tuple_unique').on(
			table.accountId,
			table.agentId,
			table.applicationId,
		),
		uniqueIndex('oauth_agent_authorizations_credential_unique').on(table.credentialId),
	],
);

export const googleAccountPoliciesTable = sqliteTable('google_account_policies', {
	authorizationId: text('authorization_id')
		.primaryKey()
		.references(() => oauthAgentAuthorizationsTable.authorizationId),
	envelope: text('encrypted_override_snapshot', { mode: 'json' })
		.$type<EncryptedOAuthEnvelope>()
		.notNull(),
	overrideRevision: integer('override_revision').notNull(),
	state: text('state', { enum: ['applying', 'active'] }).notNull(),
	transitionId: text('transition_id').notNull(),
	updatedAtMs: integer('updated_at_ms').notNull(),
});

export const permissionChangeEventsTable = sqliteTable('permission_change_events', {
	authorizationId: text('authorization_id').references(
		() => oauthAgentAuthorizationsTable.authorizationId,
	),
	zoneId: text('zone_id').notNull(),
	eventId: text('event_id').primaryKey(),
	event: text('event_json', { mode: 'json' }).$type<OAuthPermissionChangeEvent>().notNull(),
	timestampMs: integer('timestamp_ms').notNull(),
});

export const googlePolicyDefaultsActivationTable = sqliteTable(
	'google_policy_defaults_activation',
	{
		zoneId: text('zone_id').primaryKey(),
		activeDefaultsDigest: text('active_defaults_digest').notNull(),
		snapshot: text('defaults_snapshot', { mode: 'json' })
			.$type<GooglePolicyDefaultsSnapshot>()
			.notNull(),
		updatedAtMs: integer('updated_at_ms').notNull(),
	},
);

export const oauthSchemaMetadataTable = sqliteTable('oauth_schema_metadata', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});

export const oauthCatalogSchema = {
	oauthAccounts: oauthAccountsTable,
	oauthAgentAuthorizations: oauthAgentAuthorizationsTable,
	googleAccountPolicies: googleAccountPoliciesTable,
	permissionChangeEvents: permissionChangeEventsTable,
	googlePolicyDefaultsActivation: googlePolicyDefaultsActivationTable,
	oauthSchemaMetadata: oauthSchemaMetadataTable,
} as const;
