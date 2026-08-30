CREATE TABLE `oauth_account_profiles` (
	`profile_record_id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`account_profile_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_subject` text,
	`account_label` text,
	`status` text NOT NULL,
	`record_revision` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_account_profiles_zone_agent_profile_unique`
	ON `oauth_account_profiles` (`zone_id`, `agent_id`, `account_profile_id`);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`profile_record_id` text NOT NULL,
	`application_id` text NOT NULL,
	`granted_scopes` text NOT NULL,
	`lifecycle_kind` text NOT NULL,
	`material_revision` text NOT NULL,
	`provider_credential_version` integer NOT NULL,
	`record_revision` integer NOT NULL,
	`last_refresh_attempt_at_ms` integer,
	`last_refresh_succeeded_at_ms` integer,
	`next_refresh_eligible_at_ms` integer,
	`failure_class` text,
	`reauthorization_reason` text,
	`envelope_version` integer NOT NULL,
	`payload_algorithm` text NOT NULL,
	`payload_nonce` text NOT NULL,
	`payload_ciphertext` text NOT NULL,
	`dek_wrap_algorithm` text NOT NULL,
	`dek_wrap_nonce` text NOT NULL,
	`dek_ciphertext` text NOT NULL,
	`key_encryption_key_version` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`profile_record_id`) REFERENCES `oauth_account_profiles`(`profile_record_id`)
		ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_profile_application_unique`
	ON `oauth_grants` (`profile_record_id`, `application_id`);
--> statement-breakpoint
CREATE TABLE `oauth_schema_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `oauth_schema_metadata` (`key`, `value`) VALUES ('envelope_format_version', '1');
