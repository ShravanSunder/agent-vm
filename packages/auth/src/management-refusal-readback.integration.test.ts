import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import {
	managementClientReadbackSql,
	managementAuditReadbackSql,
	requireManagementRefusalReadback,
} from '#auth/test-fixtures/management-refusal-readback';

it('detects a real stored-secret-only update through the production proof projection', () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(
			"CREATE TABLE oauthClient (clientId TEXT, clientSecret TEXT, disabled INTEGER, metadata TEXT, grantTypes TEXT); INSERT INTO oauthClient VALUES ('agent', 'original-stored-hash', 0, '{}', '[\"client_credentials\"]')",
		);
		const before = database.prepare(managementClientReadbackSql).all();
		database.exec(
			"UPDATE oauthClient SET clientSecret = 'unauthorized-changed-hash' WHERE clientId = 'agent'",
		);
		const after = database.prepare(managementClientReadbackSql).all();
		expect(() =>
			requireManagementRefusalReadback({
				beforeProtected: before,
				afterProtected: after,
				beforeAudit: [],
				afterAudit: [],
				attributableActors: ['agent'],
				forbiddenValues: [],
			}),
		).toThrow('Protected');
	} finally {
		database.close();
	}
});

it('accepts a real appended attributable refusal while keeping the stored credential intact', () => {
	const database = new DatabaseSync(':memory:');
	try {
		database.exec(
			"CREATE TABLE sign_in_audit (id TEXT, kind TEXT, actor_user_id TEXT, request_id TEXT, phase TEXT, change_kind TEXT, target_id TEXT, at INTEGER); INSERT INTO sign_in_audit VALUES ('existing', 'client-changed', 'owner', 'registered', 'outcome', 'registered', 'agent', 1)",
		);
		const beforeAudit = database.prepare(managementAuditReadbackSql).all();
		database.exec(
			"INSERT INTO sign_in_audit VALUES ('refused', 'sign-in', 'agent', 'attempt', 'outcome', 'failed', 'management', 2)",
		);
		expect(() =>
			requireManagementRefusalReadback({
				beforeProtected: ['unchanged-stored-hash'],
				afterProtected: ['unchanged-stored-hash'],
				beforeAudit,
				afterAudit: database.prepare(managementAuditReadbackSql).all(),
				attributableActors: ['agent'],
				forbiddenValues: [],
			}),
		).not.toThrow();
	} finally {
		database.close();
	}
});
