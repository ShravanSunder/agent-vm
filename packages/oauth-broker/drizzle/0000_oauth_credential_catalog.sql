-- Fresh version-2 initialization only. Legacy catalogs are refused before migration.
CREATE TABLE oauth_accounts (
 account_id TEXT PRIMARY KEY NOT NULL,
 display_label TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 owner_issuer TEXT NOT NULL,
 owner_user_id TEXT NOT NULL,
 provider_id TEXT NOT NULL,
 provider_subject TEXT NOT NULL,
 record_revision INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 zone_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_accounts_subject_unique ON oauth_accounts(zone_id, provider_id, provider_subject);
--> statement-breakpoint
CREATE TABLE oauth_agent_authorizations (
 account_id TEXT NOT NULL REFERENCES oauth_accounts(account_id),
 account_alias TEXT NOT NULL,
 access_state TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 application_id TEXT NOT NULL,
 authorization_id TEXT PRIMARY KEY NOT NULL,
 authorization_metadata_revision INTEGER NOT NULL,
 catalog_version TEXT NOT NULL,
 client_binding_revision TEXT NOT NULL,
 client_id TEXT NOT NULL,
 credential_id TEXT,
 encrypted_envelope TEXT,
 failure_class TEXT,
 generation INTEGER NOT NULL,
 actual_scopes_json TEXT NOT NULL,
 last_refresh_attempt_at_ms INTEGER,
 last_refresh_succeeded_at_ms INTEGER,
 lifecycle_kind TEXT NOT NULL,
 material_revision TEXT,
 next_refresh_eligible_at_ms INTEGER,
 provider_credential_version INTEGER NOT NULL,
 reauthorization_reason TEXT,
 record_revision INTEGER NOT NULL,
 requested_scopes_json TEXT NOT NULL,
 selected_activities_json TEXT NOT NULL,
 transition_id TEXT NOT NULL,
 updated_at_ms INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_agent_authorizations_tuple_unique ON oauth_agent_authorizations(account_id, agent_id, application_id);
--> statement-breakpoint
CREATE UNIQUE INDEX oauth_agent_authorizations_credential_unique ON oauth_agent_authorizations(credential_id);
--> statement-breakpoint
CREATE TABLE google_account_policies (
 authorization_id TEXT PRIMARY KEY NOT NULL REFERENCES oauth_agent_authorizations(authorization_id),
 encrypted_override_snapshot TEXT NOT NULL,
 override_revision INTEGER NOT NULL,
 state TEXT NOT NULL,
 transition_id TEXT NOT NULL,
 updated_at_ms INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE permission_change_events (
 authorization_id TEXT REFERENCES oauth_agent_authorizations(authorization_id),
 zone_id TEXT NOT NULL,
 event_id TEXT PRIMARY KEY NOT NULL,
 event_json TEXT NOT NULL,
 timestamp_ms INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE google_policy_defaults_activation (
 zone_id TEXT PRIMARY KEY NOT NULL,
 active_defaults_digest TEXT NOT NULL,
 defaults_snapshot TEXT NOT NULL,
 updated_at_ms INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE oauth_schema_metadata (
 key TEXT PRIMARY KEY NOT NULL,
 value TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO oauth_schema_metadata(key, value) VALUES ('schema_version', '2'), ('envelope_format_version', '2');
