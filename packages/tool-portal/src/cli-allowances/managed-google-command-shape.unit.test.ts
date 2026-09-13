import { describe, expect, it } from 'vitest';

import {
	evaluateCliAllowanceInvocation,
	validateCliAllowanceInvocation,
} from './cli-allowance-validator.js';

const allowance = {
	commands: [{ path: ['gmail', 'search'], flagRules: [] }],
	deniedPatterns: [],
	stdin: { kind: 'none' as const },
	timeout: { kind: 'quick' as const },
	calls: { source: 'managed_google_policy' as const, deny: [] },
};
describe('managed Google syntax admission is not call policy', () => {
	it('validates command shape without manufacturing an approval disposition', () => {
		const result = validateCliAllowanceInvocation({
			allowance,
			input: { argv: ['gmail', 'search', 'unread'], reason: 'test' },
		});
		expect(result).toMatchObject({
			ok: true,
			matchedDenyRule: false,
			matchedCommandPath: ['gmail', 'search'],
		});
		expect(result).not.toHaveProperty('disposition');
	});
	it('refuses to use the static evaluator as a managed Google Allow default', () => {
		expect(
			evaluateCliAllowanceInvocation({
				allowance,
				baseline: 'without_approval',
				input: { argv: ['gmail', 'search', 'unread'], reason: 'test' },
			}),
		).toMatchObject({ ok: false, disposition: 'deny' });
	});
	it('retains executable denials and stdin admission independently of account policy', () => {
		expect(
			validateCliAllowanceInvocation({
				allowance: {
					...allowance,
					calls: { ...allowance.calls, deny: [{ path: ['gmail', 'search'], flags: [] }] },
				},
				input: { argv: ['gmail', 'search', 'unread'], reason: 'test' },
			}),
		).toMatchObject({ ok: true, matchedDenyRule: true });
		expect(
			validateCliAllowanceInvocation({
				allowance,
				input: { argv: ['gmail', 'search', 'unread'], reason: 'test', stdin: 'unexpected' },
			}),
		).toMatchObject({ ok: false });
	});
});
