import { toolVmCliAdvisoryHintsSchema } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

import {
	CliAllowanceInputSchema,
	CliAllowanceSchema,
	evaluateCliAllowanceInvocation,
	evaluateToolVmCliAdvisoryHints,
	type CliAllowance,
	type CliAllowanceBaseline,
} from './index.js';

function parseAllowance(overrides: Partial<CliAllowance> = {}): CliAllowance {
	return CliAllowanceSchema.parse({
		calls: {
			deny: [],
			requiresApproval: [],
			withoutApproval: 'remaining_admitted',
		},
		commands: [{ path: ['complete'] }, { path: ['project', 'edit'] }],
		deniedPatterns: [],
		stdin: { kind: 'none' },
		timeout: { kind: 'quick' },
		...overrides,
	});
}

function evaluate(props: {
	readonly allowance: CliAllowance;
	readonly argv: readonly string[];
	readonly baseline?: CliAllowanceBaseline;
}): ReturnType<typeof evaluateCliAllowanceInvocation> {
	return evaluateCliAllowanceInvocation({
		allowance: props.allowance,
		baseline: props.baseline ?? 'without_approval',
		input: CliAllowanceInputSchema.parse({ argv: props.argv, reason: 'policy proof' }),
	});
}

describe('configured CLI invocation policy schema', () => {
	it('requires the strict remaining-admitted calls policy and removes deny flag rules', () => {
		const base = {
			commands: [{ path: ['complete'] }],
			deniedPatterns: [],
			stdin: { kind: 'none' },
			timeout: { kind: 'quick' },
		};

		expect(CliAllowanceSchema.safeParse(base).success).toBe(false);
		expect(
			CliAllowanceSchema.safeParse({
				...base,
				calls: {
					deny: [],
					requiresApproval: [],
					withoutApproval: 'remaining_admitted',
					unknown: true,
				},
			}).success,
		).toBe(false);
		expect(
			CliAllowanceSchema.safeParse({
				...base,
				calls: { withoutApproval: 'all' },
			}).success,
		).toBe(false);
		expect(
			CliAllowanceSchema.safeParse({
				...base,
				calls: { withoutApproval: 'remaining_admitted' },
				commands: [{ flagRules: [{ kind: 'deny', names: ['--project'] }], path: ['complete'] }],
			}).success,
		).toBe(false);
	});

	it('validates exact admitted matcher paths and permits cross-bucket overlap', () => {
		const validPolicy = parseAllowance({
			calls: {
				deny: [{ flags: [{ names: ['--force'] }], path: ['complete'] }],
				requiresApproval: [{ flags: [{ names: ['--force'] }], path: ['complete'] }],
				withoutApproval: 'remaining_admitted',
			},
		});
		expect(validPolicy.calls.deny).toHaveLength(1);

		for (const path of [['missing'], ['project'], ['project', 'edit', 'extra']]) {
			expect(
				CliAllowanceSchema.safeParse({
					...validPolicy,
					calls: {
						...validPolicy.calls,
						deny: [{ path }],
					},
				}).success,
			).toBe(false);
		}
	});

	it('rejects duplicate aliases, values, predicates, and matchers by semantic identity', () => {
		const duplicatePolicies: readonly unknown[] = [
			{
				flags: [{ names: ['--force', '--force'] }],
				path: ['complete'],
			},
			{
				flags: [{ names: ['--format'], values: ['json', 'json'] }],
				path: ['complete'],
			},
			{
				flags: [{ names: ['--force', '-f'] }, { names: ['-f', '--force'] }],
				path: ['complete'],
			},
		];

		for (const matcher of duplicatePolicies) {
			expect(
				CliAllowanceSchema.safeParse({
					...parseAllowance(),
					calls: {
						deny: [matcher],
						requiresApproval: [],
						withoutApproval: 'remaining_admitted',
					},
				}).success,
			).toBe(false);
		}

		const matcher = {
			flags: [{ names: ['--force', '-f'] }, { names: ['--format'], values: ['json', 'text'] }],
			path: ['complete'],
		};
		expect(
			CliAllowanceSchema.safeParse({
				...parseAllowance(),
				calls: {
					deny: [
						matcher,
						{
							flags: [
								{ names: ['--format'], values: ['text', 'json'] },
								{ names: ['-f', '--force'] },
							],
							path: ['complete'],
						},
					],
					requiresApproval: [],
					withoutApproval: 'remaining_admitted',
				},
			}).success,
		).toBe(false);
	});
});

describe('configured CLI invocation disposition', () => {
	const thingsAllowance = parseAllowance({
		calls: {
			deny: [{ flags: [{ names: ['--project'] }], path: ['complete'] }],
			requiresApproval: [
				{
					flags: [{ names: ['--complete', '--cancel'] }],
					path: ['project', 'edit'],
				},
			],
			withoutApproval: 'remaining_admitted',
		},
	});

	it.each([
		{ argv: ['complete', 'item', '--task'], disposition: 'without_approval' },
		{ argv: ['complete', 'item', '--project'], disposition: 'deny' },
		{ argv: ['project', 'edit', 'item', '--complete'], disposition: 'requires_approval' },
		{ argv: ['project', 'edit', 'item', '--cancel'], disposition: 'requires_approval' },
		{ argv: ['complete', 'item', '--task', '--project'], disposition: 'deny' },
	] as const)('classifies the canonical Things invocation $argv', ({ argv, disposition }) => {
		expect(evaluate({ allowance: thingsAllowance, argv })).toMatchObject({
			disposition,
			kind: 'admitted',
		});
	});

	it('uses exact authored gog paths and aliases without CLI-specific inference', () => {
		const gogAllowance = parseAllowance({
			calls: {
				deny: [
					{
						flags: [{ names: ['--permanent'] }, { names: ['--force', '--yes', '-y'] }],
						path: ['drive', 'delete'],
					},
				],
				requiresApproval: [{ flags: [{ names: ['--permanent'] }], path: ['drive', 'delete'] }],
				withoutApproval: 'remaining_admitted',
			},
			commands: [
				{ flagRules: [], path: ['drive', 'ls'] },
				{ flagRules: [], path: ['drv', 'ls'] },
				{ flagRules: [], path: ['calendar', 'events'] },
				{ flagRules: [], path: ['gmail', 'send'] },
				{ flagRules: [], path: ['drive', 'delete'] },
			],
		});

		expect(evaluate({ allowance: gogAllowance, argv: ['drive', 'ls'] })).toMatchObject({
			disposition: 'without_approval',
		});
		expect(evaluate({ allowance: gogAllowance, argv: ['drv', 'ls'] })).toMatchObject({
			disposition: 'without_approval',
		});
		expect(
			evaluate({ allowance: gogAllowance, argv: ['drive', 'delete', 'file-1', '--permanent'] }),
		).toMatchObject({ disposition: 'requires_approval' });
		expect(
			evaluate({
				allowance: gogAllowance,
				argv: ['drive', 'delete', 'file-1', '--permanent', '--force'],
			}),
		).toMatchObject({ disposition: 'deny' });
		expect(evaluate({ allowance: gogAllowance, argv: ['mail', 'send'] })).toMatchObject({
			kind: 'denied',
		});
	});

	it('evaluates the complete precedence cross-product independently of rule order', () => {
		const matcher = { flags: [{ names: ['--matched'] }], path: ['complete'] };
		for (const baseline of [
			'without_approval',
			'requires_approval',
			'deny',
		] as const satisfies readonly CliAllowanceBaseline[]) {
			for (const approvalMatch of [false, true]) {
				for (const denyMatch of [false, true]) {
					const allowance = parseAllowance({
						calls: {
							deny: denyMatch ? [matcher] : [],
							requiresApproval: approvalMatch ? [matcher] : [],
							withoutApproval: 'remaining_admitted',
						},
					});
					const expectedDisposition =
						baseline === 'deny' || denyMatch
							? 'deny'
							: baseline === 'requires_approval' || approvalMatch
								? 'requires_approval'
								: 'without_approval';
					expect(evaluate({ allowance, argv: ['complete', '--matched'], baseline })).toMatchObject({
						disposition: expectedDisposition,
						kind: 'admitted',
					});
				}
			}
		}
	});

	it('treats predicates as AND, aliases and values as OR, and matchers as alternatives', () => {
		const allowance = parseAllowance({
			calls: {
				deny: [],
				requiresApproval: [
					{
						flags: [
							{ names: ['--force', '-f'] },
							{ names: ['--format'], values: ['json', 'text'] },
						],
						path: ['complete'],
					},
					{ flags: [{ names: ['--publish'] }], path: ['complete'] },
				],
				withoutApproval: 'remaining_admitted',
			},
		});

		for (const argv of [
			['complete', '-f', '--format=json'],
			['complete', '--force', '--format', 'text'],
			['complete', '--publish'],
		]) {
			expect(evaluate({ allowance, argv })).toMatchObject({
				disposition: 'requires_approval',
			});
		}
		expect(evaluate({ allowance, argv: ['complete', '--force'] })).toMatchObject({
			disposition: 'without_approval',
		});
	});

	it('matches a whole command path when a matcher has no flag predicates', () => {
		const allowance = parseAllowance({
			calls: {
				deny: [],
				requiresApproval: [{ flags: [], path: ['project', 'edit'] }],
				withoutApproval: 'remaining_admitted',
			},
		});

		expect(
			evaluate({ allowance, argv: ['project', 'edit', 'item', '--title', 'x'] }),
		).toMatchObject({ disposition: 'requires_approval' });
	});
});

describe('Tool VM CLI advisory hints', () => {
	it('uses hint precedence without turning unmatched argv into an allowlist', () => {
		const hints = toolVmCliAdvisoryHintsSchema.parse({
			hintDeny: [{ flags: [{ names: ['--force'] }], path: ['account', 'delete'] }],
			hintRequiresApproval: [
				{ flags: [{ names: ['--force'] }], path: ['account', 'delete'] },
				{ path: ['crawl', 'delete'] },
			],
		});

		expect(evaluateToolVmCliAdvisoryHints({ argv: ['account', 'delete', '--force'], hints })).toBe(
			'hint-deny',
		);
		expect(evaluateToolVmCliAdvisoryHints({ argv: ['crawl', 'delete', 'job-1'], hints })).toBe(
			'hint-requires-approval',
		);
		expect(evaluateToolVmCliAdvisoryHints({ argv: ['unknown', '--anything'], hints })).toBe(
			'without-approval',
		);
	});
});

describe('configured CLI flag occurrences', () => {
	it('splits first equals for long and short flags and keeps compact clusters opaque', () => {
		const allowance = parseAllowance({
			calls: {
				deny: [
					{ flags: [{ names: ['--format'], values: ['json'] }], path: ['complete'] },
					{ flags: [{ names: ['-f'], values: ['json'] }], path: ['complete'] },
				],
				requiresApproval: [{ flags: [{ names: ['-abc'] }], path: ['complete'] }],
				withoutApproval: 'remaining_admitted',
			},
		});

		expect(evaluate({ allowance, argv: ['complete', '--format=json'] })).toMatchObject({
			disposition: 'deny',
		});
		expect(evaluate({ allowance, argv: ['complete', '-f=json'] })).toMatchObject({
			disposition: 'deny',
		});
		expect(evaluate({ allowance, argv: ['complete', '-abc'] })).toMatchObject({
			disposition: 'requires_approval',
		});
		expect(evaluate({ allowance, argv: ['complete', '-a'] })).toMatchObject({
			disposition: 'without_approval',
		});
	});

	it('independently inspects a flag-shaped separated value before and after double dash', () => {
		const allowance = parseAllowance({
			calls: {
				deny: [{ flags: [{ names: ['--force'] }], path: ['complete'] }],
				requiresApproval: [],
				withoutApproval: 'remaining_admitted',
			},
			commands: [
				{
					flagRules: [{ kind: 'allowed_values', names: ['--scope'], values: ['--force'] }],
					path: ['complete'],
				},
			],
		});

		for (const argv of [
			['complete', '--scope', '--force'],
			['complete', '--', '--scope', '--force'],
		]) {
			expect(evaluate({ allowance, argv })).toMatchObject({
				disposition: 'deny',
				kind: 'admitted',
			});
		}
	});

	it('uses any repeated occurrence that satisfies an exact value predicate', () => {
		const allowance = parseAllowance({
			calls: {
				deny: [],
				requiresApproval: [
					{ flags: [{ names: ['--format'], values: ['json'] }], path: ['complete'] },
				],
				withoutApproval: 'remaining_admitted',
			},
		});

		expect(
			evaluate({
				allowance,
				argv: ['complete', 'before', '--format=text', 'between', '--format', 'json', 'after'],
			}),
		).toMatchObject({ disposition: 'requires_approval' });
	});
});
