import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from '../../config-contracts/src/oauth-tool-portal-config.js';
import { enrollmentInput } from './oauth-catalog-test-fixture.js';
import { type OAuthCredentialCatalog } from './oauth-credential-catalog-contracts.js';
import { openOAuthCredentialCatalog } from './oauth-credential-catalog.js';

describe('durable configured Google defaults activation', () => {
	let catalog: OAuthCredentialCatalog;
	let databasePath: string;
	beforeEach(async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-defaults-'));
		databasePath = path.join(directory, 'credentials.sqlite');
		catalog = await openOAuthCredentialCatalog({ databasePath, now: () => 1_000 });
	});
	afterEach(() => {
		catalog.close();
	});

	it('atomically records compiled defaults once, without changing credentials or account policy', () => {
		// Arrange
		const input = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		expect(catalog.commitEnrollmentGrant(input).kind).toBe('committed');
		const beforeGrant = catalog.getGrant(input.credentialId);
		const beforePolicy = catalog.getPolicy(input.authorizationId);
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const activation = {
			zoneId: compiled.oauthConfig.zoneId,
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		};
		// Act
		expect(catalog.activatePolicyDefaults(activation).kind).toBe('activated');
		expect(catalog.activatePolicyDefaults(activation).kind).toBe('unchanged');
		// Assert
		expect(catalog.getPolicyDefaultsActivation('test-zone')?.activeDefaultsDigest).toBe(
			compiled.defaultsRevision,
		);
		expect(catalog.listPolicyDefaultsHistory('test-zone')).toMatchObject([
			{
				kind: 'defaults-activated',
				actor: { kind: 'operator-config' },
				oldRevision: null,
				newRevision: compiled.defaultsRevision,
			},
		]);
		expect(catalog.listPolicyDefaultsHistory('other-zone')).toEqual([]);
		expect(catalog.getGrant(input.credentialId)).toEqual(beforeGrant);
		expect(catalog.getPolicy(input.authorizationId)).toEqual(beforePolicy);
		expect(catalog.listAuthorizationHistory(input.authorizationId)).toHaveLength(2);
	});

	it('records a changed fallback map with before/after snapshots and no synthetic owner', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const first = compileOAuthPolicy(input);
		catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: first.defaultsRevision,
			snapshot: first.defaultsSnapshot,
		});
		input.toolPortalConfig.agents.ember.googlePolicyDefaults.applications['gmail-app'].gmail.read =
			'allow';
		const second = compileOAuthPolicy(input);
		// Act
		catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: second.defaultsRevision,
			snapshot: second.defaultsSnapshot,
		});
		// Assert
		const events = catalog.listPolicyDefaultsHistory('test-zone');
		expect(events).toHaveLength(2);
		expect(events.find((event) => event.newRevision === second.defaultsRevision)).toMatchObject({
			actor: { kind: 'operator-config' },
			oldRevision: first.defaultsRevision,
			before: first.defaultsSnapshot,
			after: second.defaultsSnapshot,
		});
	});

	it('rolls back a new defaults revision when its history insert fails', () => {
		// Arrange: real SQLite trigger, not a mocked rollback.
		const input = createOAuthPolicyCompilerTestInput();
		const first = compileOAuthPolicy(input);
		catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: first.defaultsRevision,
			snapshot: first.defaultsSnapshot,
		});
		const database = new BetterSqlite3(databasePath);
		try {
			database.exec(
				"CREATE TRIGGER reject_default_history BEFORE INSERT ON permission_change_events WHEN NEW.authorization_id IS NULL BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
			);
			input.toolPortalConfig.agents.ember.googlePolicyDefaults.applications[
				'gmail-app'
			].gmail.read = 'allow';
			const second = compileOAuthPolicy(input);
			// Act / Assert
			expect(() =>
				catalog.activatePolicyDefaults({
					zoneId: 'test-zone',
					defaultsRevision: second.defaultsRevision,
					snapshot: second.defaultsSnapshot,
				}),
			).toThrow('history unavailable');
			expect(catalog.getPolicyDefaultsActivation('test-zone')?.activeDefaultsDigest).toBe(
				first.defaultsRevision,
			);
			expect(catalog.listPolicyDefaultsHistory('test-zone')).toHaveLength(1);
		} finally {
			database.close();
		}
	});

	it('reopens without appending a second activation for the same compiled defaults', async () => {
		// Arrange
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const input = {
			zoneId: 'test-zone',
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		};
		catalog.activatePolicyDefaults(input);
		catalog.close();
		// Act
		catalog = await openOAuthCredentialCatalog({ databasePath, now: () => 2_000 });
		expect(catalog.activatePolicyDefaults(input).kind).toBe('unchanged');
		// Assert
		expect(catalog.getPolicyDefaultsActivation('test-zone')?.updatedAtMs).toBe(1_000);
		expect(catalog.listPolicyDefaultsHistory('test-zone')).toHaveLength(1);
	});

	it('rejects a reused digest with a different defaults snapshot', () => {
		// Arrange
		const input = createOAuthPolicyCompilerTestInput();
		const first = compileOAuthPolicy(input);
		catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: first.defaultsRevision,
			snapshot: first.defaultsSnapshot,
		});
		input.toolPortalConfig.agents.ember.googlePolicyDefaults.applications['gmail-app'].gmail.read =
			'allow';
		const second = compileOAuthPolicy(input);
		// Act / Assert
		expect(() =>
			catalog.activatePolicyDefaults({
				zoneId: 'test-zone',
				defaultsRevision: first.defaultsRevision,
				snapshot: second.defaultsSnapshot,
			}),
		).toThrow('inconsistent snapshot');
		expect(catalog.getPolicyDefaultsActivation('test-zone')?.snapshot).toEqual(
			first.defaultsSnapshot,
		);
		expect(catalog.listPolicyDefaultsHistory('test-zone')).toHaveLength(1);
	});
});
