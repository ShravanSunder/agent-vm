import { describe, expect, it } from 'vitest';

import {
	CliAllowanceInputSchema,
	CliAllowanceSchema,
	OpenCliAllowanceInputSchema,
	QuickCliAllowanceInputSchema,
	resolveCliAllowanceTimeout,
	validateCliAllowanceInvocation,
} from './index.js';

const cliAllowance = CliAllowanceSchema.parse({
	commands: [
		{
			flagRules: [
				{ kind: 'deny', names: ['--token', '-t'] },
				{
					kind: 'allowed_values',
					names: ['--format'],
					values: ['compact', 'full'],
				},
			],
			path: ['calendar', 'events'],
		},
	],
	deniedPatterns: [{ kind: 'literal', value: 'secret' }],
	stdin: { deniedPatterns: [], kind: 'bounded_text', maxBytes: 128 },
	timeout: { kind: 'open' },
});

describe('CLI allowance contracts', () => {
	it('derives strict quick and open public input contracts', () => {
		const quickInput = QuickCliAllowanceInputSchema.parse({
			argv: ['calendar', 'events'],
			reason: 'Need schedule context.',
		});
		const openInput = OpenCliAllowanceInputSchema.parse({
			argv: ['calendar', 'events'],
			reason: 'Need schedule context.',
			timeoutMs: 240_000,
		});

		expect(QuickCliAllowanceInputSchema.safeParse({ ...quickInput, timeoutMs: 1 }).success).toBe(
			false,
		);
		expect(openInput.timeoutMs).toBe(240_000);
		expect(CliAllowanceInputSchema.parse(openInput)).toEqual(openInput);
	});

	it('resolves code-owned quick and open timeout values', () => {
		expect(
			resolveCliAllowanceTimeout({ input: { argv: ['x'], reason: 'quick' }, kind: 'quick' }),
		).toEqual({ kind: 'quick', requestedTimeoutMs: null, resolvedTimeoutMs: 5_000 });
		expect(
			resolveCliAllowanceTimeout({ input: { argv: ['x'], reason: 'open' }, kind: 'open' }),
		).toEqual({ kind: 'open', requestedTimeoutMs: null, resolvedTimeoutMs: 120_000 });
		expect(
			resolveCliAllowanceTimeout({
				input: { argv: ['x'], reason: 'open', timeoutMs: 28_800_000 },
				kind: 'open',
			}),
		).toEqual({
			kind: 'open',
			requestedTimeoutMs: 28_800_000,
			resolvedTimeoutMs: 28_800_000,
		});
	});

	it('admits exact command paths with positional values, ordinary flags, and punctuation data', () => {
		const input = CliAllowanceInputSchema.parse({
			argv: [
				'calendar',
				'events',
				'Buy milk; do not interpolate $HOME',
				'--calendar',
				'primary',
				'--format=compact',
			],
			reason: 'Need schedule context.',
			stdin: 'bounded input',
			timeoutMs: 240_000,
		});

		expect(validateCliAllowanceInvocation({ allowance: cliAllowance, input })).toMatchObject({
			argv: input.argv,
			ok: true,
		});
	});

	it('rejects sibling and partial command paths', () => {
		for (const argv of [['calendar', 'all'], ['calendar'], ['calendar-events']]) {
			expect(
				validateCliAllowanceInvocation({
					allowance: cliAllowance,
					input: CliAllowanceInputSchema.parse({ argv, reason: 'Probe invalid path.' }),
				}),
			).toMatchObject({ ok: false });
		}
	});

	it('applies deny and allowed-value rules without treating double dash as an exemption', () => {
		for (const argv of [
			['calendar', 'events', '--token'],
			['calendar', 'events', '--token=value'],
			['calendar', 'events', '--format'],
			['calendar', 'events', '--format=verbose'],
			['calendar', 'events', '--', '--token'],
			['calendar', 'events', 'secret-value'],
		]) {
			expect(
				validateCliAllowanceInvocation({
					allowance: cliAllowance,
					input: CliAllowanceInputSchema.parse({ argv, reason: 'Probe invalid policy.' }),
				}),
			).toMatchObject({ ok: false });
		}
	});

	it('does not let a separated allowed value consume an explicitly denied flag', () => {
		const allowance = CliAllowanceSchema.parse({
			commands: [
				{
					flagRules: [
						{ kind: 'allowed_values', names: ['--scope'], values: ['--force'] },
						{ kind: 'deny', names: ['--force'] },
					],
					path: ['apply'],
				},
			],
			deniedPatterns: [],
			stdin: { kind: 'none' },
			timeout: { kind: 'quick' },
		});

		for (const argv of [
			['apply', '--scope', '--force'],
			['apply', '--', '--scope', '--force'],
		]) {
			expect(
				validateCliAllowanceInvocation({
					allowance,
					input: CliAllowanceInputSchema.parse({ argv, reason: 'deny inspection proof' }),
				}),
			).toMatchObject({ ok: false });
		}
	});

	it('rejects control characters and invalid stdin before execution', () => {
		expect(
			CliAllowanceInputSchema.safeParse({
				argv: ['calendar', 'events', 'line\nbreak'],
				reason: 'Probe control characters.',
			}).success,
		).toBe(false);
		expect(
			validateCliAllowanceInvocation({
				allowance: cliAllowance,
				input: CliAllowanceInputSchema.parse({
					argv: ['calendar', 'events'],
					reason: 'Probe oversized stdin.',
					stdin: 'x'.repeat(129),
				}),
			}),
		).toMatchObject({ ok: false });
	});

	it('enforces the configured JSON stdin schema', () => {
		const jsonAllowance = CliAllowanceSchema.parse({
			commands: [{ path: ['apply'] }],
			deniedPatterns: [],
			stdin: {
				kind: 'json',
				maxBytes: 128,
				schema: {
					additionalProperties: false,
					properties: { mode: { const: 'safe', type: 'string' } },
					required: ['mode'],
					type: 'object',
				},
			},
			timeout: { kind: 'quick' },
		});

		expect(
			validateCliAllowanceInvocation({
				allowance: jsonAllowance,
				input: { argv: ['apply'], reason: 'valid JSON', stdin: '{"mode":"safe"}' },
			}),
		).toMatchObject({ ok: true });
		for (const stdin of ['{"mode":"unsafe"}', '{"mode":"safe","extra":true}', '[]']) {
			expect(
				validateCliAllowanceInvocation({
					allowance: jsonAllowance,
					input: { argv: ['apply'], reason: 'invalid schema', stdin },
				}),
			).toMatchObject({ ok: false });
		}
	});

	it('rejects duplicate and proper-prefix-overlapping command definitions', () => {
		for (const commands of [
			[{ path: ['remove'] }, { path: ['remove'] }],
			[{ path: ['remove'] }, { path: ['remove', 'one'] }],
		]) {
			expect(
				CliAllowanceSchema.safeParse({
					commands,
					deniedPatterns: [],
					stdin: { kind: 'none' },
					timeout: { kind: 'quick' },
				}).success,
			).toBe(false);
		}
	});
});
