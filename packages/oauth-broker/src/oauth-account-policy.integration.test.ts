import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	googleAccountPolicyBindingSchema,
	googleAccountPolicySnapshotSchema,
	oauthServiceIdSchema,
	type GoogleAccountPolicySnapshot,
} from '@agent-vm/oauth-broker-contracts';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import { compileOAuthPolicy } from '../../config-contracts/src/oauth-tool-portal-config.js';
import {
	createOAuthPolicyEnvelopeCodec,
	oauthPolicyEnvelopeBindingSchema,
} from './envelope-codec.js';
import { readGoogleAccountPolicySnapshot } from './google/google-account-policy-envelope.js';
import { enrollmentInput, wrappingKey } from './oauth-catalog-test-fixture.js';
import { type OAuthCredentialCatalog } from './oauth-credential-catalog-contracts.js';
import { openOAuthCredentialCatalog } from './oauth-credential-catalog.js';

const codec = createOAuthPolicyEnvelopeCodec({ payloadSchema: googleAccountPolicySnapshotSchema });
function envelope(snapshot: GoogleAccountPolicySnapshot): ReturnType<typeof codec.encrypt> {
	return codec.encrypt({
		binding: oauthPolicyEnvelopeBindingSchema.strip().parse(snapshot),
		payload: snapshot,
		keyEncryptionKey: wrappingKey,
		keyEncryptionKeyVersion: 1,
	});
}
describe('atomic account policy storage', () => {
	let catalog: OAuthCredentialCatalog;
	let databasePath: string;
	beforeEach(async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-account-policy-'));
		databasePath = path.join(directory, 'credentials.sqlite');
		catalog = await openOAuthCredentialCatalog({ databasePath, now: () => 1_000 });
	});
	afterEach(() => {
		catalog.close();
	});
	function arrange(): {
		readonly before: GoogleAccountPolicySnapshot;
		readonly after: GoogleAccountPolicySnapshot;
		readonly defaultsRevision: string;
	} {
		const enrollment = enrollmentInput({ accountId: randomUUID(), agentId: 'sun' });
		expect(catalog.commitEnrollmentGrant(enrollment).kind).toBe('committed');
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		});
		const read = readGoogleAccountPolicySnapshot({
			binding: googleAccountPolicyBindingSchema.strip().parse(enrollment),
			policy: catalog.getPolicy(enrollment.authorizationId),
			keyEncryptionKey: wrappingKey,
		});
		if (read.kind !== 'verified') throw new Error('Expected initial policy.');
		const before = read.snapshot;
		const after = googleAccountPolicySnapshotSchema.parse({
			...before,
			overrideRevision: 2,
			state: 'applying',
			lastEditor: before.owner,
			lastEditedAtMs: 1_000,
			services: {
				gmail: { read: { kind: 'explicit', disposition: 'deny' }, write: { kind: 'inherit' } },
			},
		});
		return { before, after, defaultsRevision: compiled.defaultsRevision };
	}
	it('saves and fences one authenticated override revision, then activates it with correlated history', () => {
		// Arrange
		const { before, after, defaultsRevision } = arrange();
		// Act
		const saved = catalog.saveAccountPolicy({
			before,
			after,
			envelope: envelope(after),
			expectedDefaultsRevision: defaultsRevision,
		});
		if (saved.kind !== 'updated') throw new Error('Expected policy save.');
		expect(saved.policy.state).toBe('applying');
		expect(saved.policy.overrideRevision).toBe(2);
		const active = googleAccountPolicySnapshotSchema.parse({ ...after, state: 'active' });
		const activated = catalog.activateAccountPolicy({
			before: after,
			after: active,
			envelope: envelope(active),
			expectedTransitionId: saved.policy.transitionId,
		});
		// Assert
		expect(activated.kind).toBe('updated');
		const read = readGoogleAccountPolicySnapshot({
			binding: googleAccountPolicyBindingSchema.strip().parse(active),
			policy: catalog.getPolicy(active.authorizationId),
			keyEncryptionKey: wrappingKey,
		});
		expect(read).toEqual({ kind: 'verified', snapshot: active });
		expect(catalog.listAccountPolicyHistory(active.authorizationId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'policy-saved',
					oldRevision: 1,
					newRevision: 2,
					transitionId: saved.policy.transitionId,
				}),
				expect.objectContaining({
					kind: 'policy-activated',
					oldRevision: 2,
					newRevision: 2,
					transitionId: saved.policy.transitionId,
				}),
			]),
		);
		expect(catalog.listAuthorizationHistory(active.authorizationId)).toHaveLength(2);
	});
	it('rejects stale saves and a changed defaults generation without changing policy', () => {
		// Arrange
		const { before, after, defaultsRevision } = arrange();
		const initial = catalog.getPolicy(before.authorizationId);
		// Act / Assert
		expect(
			catalog.saveAccountPolicy({
				before,
				after,
				envelope: envelope(after),
				expectedDefaultsRevision: 'a'.repeat(64),
			}).kind,
		).toBe('defaults-changed');
		expect(catalog.getPolicy(before.authorizationId)).toEqual(initial);
		expect(
			catalog.saveAccountPolicy({
				before,
				after,
				envelope: envelope(after),
				expectedDefaultsRevision: defaultsRevision,
			}).kind,
		).toBe('updated');
		expect(
			catalog.saveAccountPolicy({
				before,
				after,
				envelope: envelope(after),
				expectedDefaultsRevision: defaultsRevision,
			}).kind,
		).toBe('stale');
		expect(catalog.listAccountPolicyHistory(before.authorizationId)).toHaveLength(1);
	});
	it('rejects an editor identity that is not the account owner at the storage boundary', () => {
		// Arrange
		const { before, after, defaultsRevision } = arrange();
		const forged = googleAccountPolicySnapshotSchema.parse({
			...after,
			lastEditor: { ...after.owner, userId: 'other-owner' },
		});
		const initial = catalog.getPolicy(before.authorizationId);
		// Act / Assert
		expect(
			catalog.saveAccountPolicy({
				before,
				after: forged,
				envelope: envelope(forged),
				expectedDefaultsRevision: defaultsRevision,
			}).kind,
		).toBe('owner-mismatch');
		expect(catalog.getPolicy(before.authorizationId)).toEqual(initial);
	});
	it('does not allow activation to change saved choices or consume a different transition', () => {
		// Arrange
		const { before, after, defaultsRevision } = arrange();
		const saved = catalog.saveAccountPolicy({
			before,
			after,
			envelope: envelope(after),
			expectedDefaultsRevision: defaultsRevision,
		});
		if (saved.kind !== 'updated') throw new Error('Expected save.');
		const changed = googleAccountPolicySnapshotSchema.parse({
			...after,
			state: 'active',
			services: {
				gmail: { read: { kind: 'explicit', disposition: 'allow' }, write: { kind: 'inherit' } },
			},
		});
		const active = googleAccountPolicySnapshotSchema.parse({ ...after, state: 'active' });
		// Act / Assert
		expect(
			catalog.activateAccountPolicy({
				before: after,
				after: changed,
				envelope: envelope(changed),
				expectedTransitionId: saved.policy.transitionId,
			}).kind,
		).toBe('stale');
		expect(
			catalog.activateAccountPolicy({
				before: after,
				after: active,
				envelope: envelope(active),
				expectedTransitionId: randomUUID(),
			}).kind,
		).toBe('stale');
		expect(catalog.getPolicy(before.authorizationId)).toEqual(saved.policy);
	});
	it('rolls back the policy if its durable history cannot be appended', () => {
		// Arrange
		const { before, after, defaultsRevision } = arrange();
		const initial = catalog.getPolicy(before.authorizationId);
		const database = new BetterSqlite3(databasePath);
		try {
			database.exec(
				"CREATE TRIGGER reject_policy_history BEFORE INSERT ON permission_change_events WHEN json_extract(NEW.event_json, '$.kind') = 'policy-saved' BEGIN SELECT RAISE(ABORT, 'policy history unavailable'); END",
			);
			// Act / Assert
			expect(() =>
				catalog.saveAccountPolicy({
					before,
					after,
					envelope: envelope(after),
					expectedDefaultsRevision: defaultsRevision,
				}),
			).toThrow('policy history unavailable');
			expect(catalog.getPolicy(before.authorizationId)).toEqual(initial);
			expect(catalog.listAccountPolicyHistory(before.authorizationId)).toEqual([]);
		} finally {
			database.close();
		}
	});
	it('retains a pending policy across restart without automatically declaring it active', async () => {
		// Arrange
		const { before, after, defaultsRevision } = arrange();
		catalog.saveAccountPolicy({
			before,
			after,
			envelope: envelope(after),
			expectedDefaultsRevision: defaultsRevision,
		});
		catalog.close();
		// Act
		catalog = await openOAuthCredentialCatalog({ databasePath });
		// Assert
		expect(catalog.getPolicy(before.authorizationId)?.state).toBe('applying');
		expect(after.services[oauthServiceIdSchema.parse('gmail')]?.read).toEqual({
			kind: 'explicit',
			disposition: 'deny',
		});
	});
	it('records a correlated failed containment without changing the saved choices or reopening admission', async () => {
		// Arrange
		const { before, after, defaultsRevision } = arrange();
		const saved = catalog.saveAccountPolicy({
			before,
			after,
			envelope: envelope(after),
			expectedDefaultsRevision: defaultsRevision,
		});
		if (saved.kind !== 'updated') throw new Error('Expected save.');
		// Act
		const recorded = catalog.recordAccountPolicyContainment({
			snapshot: after,
			expectedTransitionId: saved.policy.transitionId,
			result: 'failed',
		});
		catalog.close();
		catalog = await openOAuthCredentialCatalog({ databasePath });
		// Assert
		expect(recorded.kind).toBe('updated');
		expect(catalog.getPolicy(before.authorizationId)).toMatchObject({
			state: 'applying',
			overrideRevision: 2,
			envelope: saved.policy.envelope,
		});
		expect(catalog.listAccountPolicyHistory(before.authorizationId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'policy-containment-failed',
					transitionId: saved.policy.transitionId,
					oldRevision: 2,
					newRevision: 2,
					state: 'applying',
					before: after.services,
					after: after.services,
				}),
			]),
		);
		expect(
			catalog.recordAccountPolicyContainment({
				snapshot: after,
				expectedTransitionId: randomUUID(),
				result: 'pending',
			}),
		).toEqual({ kind: 'stale' });
		expect(catalog.listAccountPolicyHistory(before.authorizationId)).toHaveLength(2);
	});
});
