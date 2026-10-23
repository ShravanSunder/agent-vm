import { expect, it } from 'vitest';

import {
	selectAuthObservations,
	requireMatchingAuthObservations,
} from '#auth/test-fixtures/auth-verification-cli';

const root = '/proof-checkout';
const inventory = [
	{ file: '/proof-checkout/issuer.ts', name: 'issuer > agent: allowed effect' },
	{ file: '/proof-checkout/faults.ts', name: 'agent: rejects outcome failure' },
	{ file: '/proof-checkout/issuer.ts', name: 'issuer > bootstrap: native owner' },
] as const;

it('selects every offered agent case and leaves bootstrap unselected', () => {
	const selected = selectAuthObservations({
		inventory,
		selectedFiles: ['issuer.ts', 'faults.ts'],
		journey: 'agent',
		root,
	});
	expect(selected.map((test) => test.name)).toEqual([
		'issuer > agent: allowed effect',
		'agent: rejects outcome failure',
	]);
});

it('refuses a runner that silently omits an offered fault file', () => {
	expect(() =>
		selectAuthObservations({ inventory, selectedFiles: ['issuer.ts'], journey: 'agent', root }),
	).toThrow('omitted');
});

it('refuses empty journey discovery', () => {
	expect(() =>
		selectAuthObservations({ inventory: [], selectedFiles: ['issuer.ts'], journey: 'agent', root }),
	).toThrow('empty');
});

it('accepts all matching observations in a different execution order', () => {
	expect(() =>
		requireMatchingAuthObservations({
			selected: [inventory[0], inventory[1]],
			actual: [inventory[1], inventory[0]],
			passedCount: 2,
			root,
		}),
	).not.toThrow();
});

it.each([
	{ name: 'one positive while the selected fault is skipped', actual: [inventory[0]], count: 1 },
	{ name: 'an unrelated passing bootstrap', actual: [inventory[0], inventory[2]], count: 2 },
	{
		name: 'a duplicate positive replacing the fault',
		actual: [inventory[0], inventory[0]],
		count: 2,
	},
	{
		name: 'a different file with the same case name',
		actual: [inventory[0], { ...inventory[1], file: '/proof-checkout/other.ts' }],
		count: 2,
	},
	{ name: 'incorrect aggregate count', actual: [inventory[0], inventory[1]], count: 3 },
])('refuses $name', ({ actual, count }) => {
	expect(() =>
		requireMatchingAuthObservations({
			selected: [inventory[0], inventory[1]],
			actual,
			passedCount: count,
			root,
		}),
	).toThrow('differ');
});

it('refuses an empty selection even with zero-count agreement', () => {
	expect(() =>
		requireMatchingAuthObservations({ selected: [], actual: [], passedCount: 0, root }),
	).toThrow('differ');
});
