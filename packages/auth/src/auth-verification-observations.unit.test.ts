import { expect, it } from 'vitest';

import {
	selectAuthObservations,
	requireMatchingAuthObservations,
	waitForAuthBuildLoadAdmission,
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

it.each([
	{ name: 'an already quiet host', loads: [11.9], elapsed: [0], admitted: true },
	{
		name: 'a host cooling after a build',
		loads: [15, 12, 11.9],
		elapsed: [0, 30_000, 60_000],
		admitted: true,
	},
	{
		name: 'load exactly at the ceiling for ten minutes',
		loads: [12],
		elapsed: Array.from({ length: 21 }, (_, index) => index * 30_000),
		admitted: false,
	},
	{
		name: 'an unavailable load sample',
		loads: [Infinity],
		elapsed: Array.from({ length: 21 }, (_, index) => index * 30_000),
		admitted: false,
	},
])(
	'post-build admission handles $name without loosening the ceiling',
	async ({ loads, elapsed, admitted }) => {
		let clock = 0;
		let sampleIndex = 0;
		const samples: { readonly elapsedMs: number; readonly load1: number }[] = [];
		const result = waitForAuthBuildLoadAdmission({
			maxLoad1: 12,
			readLoad1: () => loads[Math.min(sampleIndex++, loads.length - 1)] ?? Infinity,
			now: () => clock,
			waitInterval: async (milliseconds) => {
				clock += milliseconds;
			},
			recordSample: async (sample) => {
				samples.push(sample);
			},
		});
		if (admitted) await expect(result).resolves.toBeUndefined();
		else await expect(result).rejects.toThrow('Load admission closed');
		expect(samples.map((sample) => sample.elapsedMs)).toEqual(elapsed);
		expect(samples.map((sample) => sample.load1)).toEqual(
			elapsed.map((_, index) => loads[Math.min(index, loads.length - 1)]),
		);
	},
);

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
