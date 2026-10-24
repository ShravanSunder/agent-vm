import { expect, it } from 'vitest';

import { requireManagementRefusalReadback } from '#auth/test-fixtures/management-refusal-readback';

const existing = {
	id: 'original',
	kind: 'client-changed',
	actor_user_id: 'owner',
	request_id: 'registration',
	phase: 'outcome',
	change_kind: 'registered',
	target_id: 'agent',
	at: 1,
};
const refusal = {
	id: 'refusal',
	kind: 'sign-in',
	actor_user_id: 'agent',
	request_id: 'denied-request',
	phase: 'outcome',
	change_kind: 'failed',
	target_id: 'management',
	at: 2,
};
function compare(
	afterAudit: unknown,
	afterProtected: unknown = [{ clientId: 'agent', clientSecret: 'stored-hash' }],
): void {
	requireManagementRefusalReadback({
		beforeProtected: [{ clientId: 'agent', clientSecret: 'stored-hash' }],
		afterProtected,
		beforeAudit: [existing],
		afterAudit,
		attributableActors: ['agent', 'owner'],
		forbiddenValues: ['private-proof-value'],
	});
}

it('allows only appended attributable refusal events while preserving existing records', () => {
	expect(() => compare([refusal, existing])).not.toThrow();
});
it('allows no audit change', () => {
	expect(() => compare([existing])).not.toThrow();
});
it('rejects a credential-only protected state change', () => {
	expect(() => compare([existing], [{ clientId: 'agent', clientSecret: 'changed-hash' }])).toThrow(
		'Protected',
	);
});
it.each([
	{ name: 'deleting an existing row', rows: [refusal] },
	{ name: 'editing an existing row', rows: [{ ...existing, at: 3 }] },
	{
		name: 'an unrelated successful mutation event',
		rows: [existing, { ...refusal, kind: 'client-changed', change_kind: 'registered' }],
	},
	{
		name: 'an unattributable refusal',
		rows: [existing, { ...refusal, actor_user_id: 'forged-actor' }],
	},
	{
		name: 'a refusal intent instead of an outcome',
		rows: [existing, { ...refusal, phase: 'intent' }],
	},
	{
		name: 'a proof value hidden in audit content',
		rows: [existing, { ...refusal, target_id: 'private-proof-value' }],
	},
	{ name: 'a duplicate audit identity', rows: [existing, refusal, refusal] },
])('rejects $name', ({ rows }) => {
	expect(() => compare(rows)).toThrow();
});
