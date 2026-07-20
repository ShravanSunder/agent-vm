import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	validateManagedVmFilteredWorkspacePolicy,
	type ManagedVmFilteredWorkspacePolicy,
	type ManagedVmMount,
} from './index.js';

function createPositivePolicy(
	overrides: Partial<ManagedVmFilteredWorkspacePolicy> = {},
): ManagedVmFilteredWorkspacePolicy {
	return {
		hiddenPaths: [],
		readonlyInputs: [],
		temporaryPaths: [],
		visibility: {
			kind: 'positive-paths',
			visiblePaths: ['notes', 'skills'],
			writablePaths: ['notes'],
		},
		...overrides,
	};
}

describe('managed filtered workspace policy', () => {
	it('keeps the filtered mount pathless and backend-neutral', () => {
		type FilteredWorkspaceMount = Extract<
			ManagedVmMount,
			{ readonly kind: 'owned-filtered-workspace' }
		>;
		type HasRawHostPath = 'hostPath' extends keyof FilteredWorkspaceMount ? true : false;
		type HasNativeProvider = 'provider' extends keyof FilteredWorkspaceMount ? true : false;

		expectTypeOf<HasRawHostPath>().toEqualTypeOf<false>();
		expectTypeOf<HasNativeProvider>().toEqualTypeOf<false>();
	});
	it('accepts whole-root writable and positive-path policies', () => {
		expect(
			validateManagedVmFilteredWorkspacePolicy({
				hiddenPaths: ['.env', 'reviewed'],
				readonlyInputs: [
					{
						destinationRelativePath: 'managed/skill',
						sourceRelativePath: 'reviewed/skill',
					},
				],
				temporaryPaths: ['node_modules'],
				visibility: { kind: 'whole-root-writable' },
			}),
		).toEqual({
			hiddenPaths: ['.env', 'reviewed'],
			readonlyInputs: [
				{
					destinationRelativePath: 'managed/skill',
					sourceRelativePath: 'reviewed/skill',
				},
			],
			temporaryPaths: ['node_modules'],
			visibility: { kind: 'whole-root-writable' },
		});

		expect(validateManagedVmFilteredWorkspacePolicy(createPositivePolicy())).toEqual(
			createPositivePolicy(),
		);
	});

	it.each([
		'/absolute',
		'../escape',
		'nested/../../escape',
		'./not-normalized',
		'not//normalized',
		'trailing/',
		'nul\0path',
	])('rejects unsafe or non-normalized relative path %j', (invalidPath) => {
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy(
				createPositivePolicy({ hiddenPaths: [invalidPath] }),
			),
		).toThrow(/normalized workspace-relative path/u);
	});

	it('rejects duplicate and ambiguous same-precedence overlaps', () => {
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy(
				createPositivePolicy({ hiddenPaths: ['secret', 'secret'] }),
			),
		).toThrow(/duplicate hidden path/u);
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy(
				createPositivePolicy({ temporaryPaths: ['cache', 'cache/packages'] }),
			),
		).toThrow(/overlapping temporary paths/u);
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy(
				createPositivePolicy({
					readonlyInputs: [
						{ destinationRelativePath: 'managed', sourceRelativePath: 'reviewed/one' },
						{
							destinationRelativePath: 'managed/child',
							sourceRelativePath: 'reviewed/two',
						},
					],
				}),
			),
		).toThrow(/overlapping read-only destinations/u);
	});

	it('rejects paths outside the positive projection and writable descendants of readonly inputs', () => {
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy(
				createPositivePolicy({ temporaryPaths: ['private/cache'] }),
			),
		).toThrow(/outside the positive visibility allowlist/u);
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy({
				...createPositivePolicy(),
				readonlyInputs: [
					{ destinationRelativePath: 'skills', sourceRelativePath: 'reviewed/skills' },
				],
				visibility: {
					kind: 'positive-paths',
					visiblePaths: ['skills'],
					writablePaths: ['skills/local'],
				},
			}),
		).toThrow(/writable path.+read-only ancestor/u);
	});

	it('rejects a readonly mapping whose backing source remains writable', () => {
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy({
				hiddenPaths: [],
				readonlyInputs: [
					{ destinationRelativePath: 'managed/skill', sourceRelativePath: 'reviewed/skill' },
				],
				temporaryPaths: [],
				visibility: { kind: 'whole-root-writable' },
			}),
		).toThrow(/source 'reviewed\/skill' remains writable/u);
	});

	it('accepts cross-precedence overlap because hidden beats readonly and readonly beats writable', () => {
		expect(() =>
			validateManagedVmFilteredWorkspacePolicy({
				hiddenPaths: ['skills/private'],
				readonlyInputs: [
					{ destinationRelativePath: 'skills', sourceRelativePath: 'reviewed/skills' },
				],
				temporaryPaths: ['skills/cache'],
				visibility: {
					kind: 'positive-paths',
					visiblePaths: ['skills'],
					writablePaths: ['skills'],
				},
			}),
		).not.toThrow();
	});
});
