import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { removalNoticeSchema, removalNoticeAckSchema } from '#tool-access/contracts/removal-notice';
import {
	collaborationTokenClaimsSchema,
	markSchema,
	workspaceTokenClaimsSchema,
} from '#tool-access/contracts/workspace-token-claims';

const fixtures = z
	.object({
		workspaces: z.array(workspaceTokenClaimsSchema),
		collaboration: collaborationTokenClaimsSchema,
		removal: removalNoticeSchema,
	})
	.parse(
		JSON.parse(
			await readFile(
				new URL('../../fixtures/identity/identity-contracts.json', import.meta.url),
				'utf8',
			),
		),
	);
const botClaims = fixtures.workspaces[0];
if (botClaims === undefined) throw new Error('The bot fixture is required.');

describe('identity token contracts (C1, C3, C6)', () => {
	it('retains the complete session reference, environment and every isolation including host instance', () => {
		// Arrange: generated fixtures are reviewed against PD claims, not runtime output.
		const encoded = JSON.stringify(fixtures);
		// Act: round trip through each actual receiving schema.
		const roundTrip = z
			.object({
				workspaces: z.array(workspaceTokenClaimsSchema),
				collaboration: collaborationTokenClaimsSchema,
				removal: removalNoticeSchema,
			})
			.parse(JSON.parse(encoded));
		// Assert: dropping identity or isolation fields cannot silently pass.
		expect(roundTrip).toEqual(JSON.parse(encoded));
		expect(
			roundTrip.workspaces.map((claims) =>
				claims.principal.kind === 'bot' ? 'bot' : claims.principal.isolation.kind,
			),
		).toEqual(['bot', 'host', 'processSandbox', 'container', 'vm']);
	});
	it.each([
		{ label: 'missing principal', changes: { principal: undefined } },
		{
			label: 'unknown principal defaulted to bot',
			changes: { principal: { kind: 'other', bot_id: '22222222-2222-4222-8222-222222222222' } },
		},
		{
			label: 'person admitted to workspace tools',
			changes: { principal: { kind: 'person', person_id: 'person-one' } },
		},
		{ label: 'bot assigned the session default', changes: { persona: { kind: 'sessionDefault' } } },
		{ label: 'unsafe mark rounded by JSON', changes: { grant_revision: 2 ** 53 } },
		{ label: 'fractional mark', changes: { grant_revision: 0.5 } },
		{ label: 'negative mark', changes: { grant_revision: -1 } },
	])('rejects $label', ({ changes }) => {
		expect(workspaceTokenClaimsSchema.safeParse({ ...botClaims, ...changes }).success).toBe(false);
	});
	it('refuses unknown isolation and a host record without its launch instance', () => {
		const sessionClaims = fixtures.workspaces[1];
		if (sessionClaims?.principal.kind !== 'fleetHarnessSession')
			throw new Error('Session fixture required.');
		for (const isolation of [{ kind: 'unknown', instance_id: 'launch' }, { kind: 'host' }]) {
			expect(
				workspaceTokenClaimsSchema.safeParse({
					...sessionClaims,
					principal: { ...sessionClaims.principal, isolation },
				}).success,
			).toBe(false);
		}
	});
	it('accepts the exact JSON-safe mark limits', () => {
		expect(markSchema.parse(0)).toBe(0);
		expect(markSchema.parse(2 ** 53 - 1)).toBe(9_007_199_254_740_991);
	});
	it('refuses a workspace or persona attached to a collaboration token', () => {
		expect(
			collaborationTokenClaimsSchema.safeParse({
				...fixtures.collaboration,
				workspace_id: botClaims.workspace_id,
			}).success,
		).toBe(false);
		expect(
			collaborationTokenClaimsSchema.safeParse({
				...fixtures.collaboration,
				persona: botClaims.persona,
			}).success,
		).toBe(false);
	});
	it('keeps notice HTTP bodies camelCase and acknowledges the exact notice ID', () => {
		expect(
			removalNoticeSchema.safeParse({ ...fixtures.removal, removal_revision: 1 }).success,
		).toBe(false);
		expect(
			removalNoticeAckSchema.parse({ result: 'recorded', noticeId: fixtures.removal.noticeId }),
		).toEqual({ result: 'recorded', noticeId: '019a1335-20c0-7000-8000-000000000001' });
		expect(
			removalNoticeAckSchema.safeParse({ result: 'unknown', noticeId: fixtures.removal.noticeId })
				.success,
		).toBe(false);
	});
});
