import {
	type AccessAssessment,
	type AccessState,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import { oauthAccountIdSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import {
	account,
	accountId,
	assessor,
	blocked,
	digest,
	driveService,
	googleFixture,
	namespace,
	state,
} from '#tool-access/authorization/access-assessor-test-fixture';

function googleOperation(
	input: AssessAccessInput,
): NonNullable<ReturnType<typeof namespace>['operations'][string]> {
	const operation = namespace(input).operations.run;
	if (operation === undefined || operation.cliPolicy === null || operation.googleCommands === null)
		throw new Error('Missing Google operation');
	return operation;
}

function explanation(
	input: AssessAccessInput,
): Extract<AccessAssessment, { kind: 'call-dependent' }> {
	const value = structuredClone(input);
	value.call = null;
	value.facts.accounts = value.facts.accounts.map((fact) => ({ ...fact, boundToCall: null }));
	const result = assessor(value);
	if (result.kind !== 'assessed' || result.assessment.kind !== 'call-dependent')
		throw new Error('Expected conditional explanation');
	const admission = assessor(input);
	if (admission.kind !== 'assessed') throw new Error('Expected admission');
	expect(result.assessment.revisions).toEqual(admission.assessment.revisions);
	expect(result.assessment.surface).toBe(admission.assessment.surface);
	return result.assessment;
}

// Oracles: Lead's accepted S1-R2 correction and R28. The admission function is not the expected-value oracle.
describe('Google explain folds the same path-wide CLI contribution as admission', () => {
	it.each([
		{ disposition: 'ask', expected: { kind: 'approval-each-call' } },
		{ disposition: 'deny', expected: blocked('cli-allowance') },
	] satisfies readonly { disposition: 'ask' | 'deny'; expected: AccessState }[])(
		'folds a path-wide $disposition into the service/effect/account entry',
		({ disposition, expected }) => {
			const input = googleFixture();
			const operation = googleOperation(input);
			if (operation.cliPolicy === null) throw new Error('Missing CLI policy');

			const matcher = { path: ['drive', 'list'], flags: [] };
			operation.cliPolicy.calls = {
				deny: disposition === 'deny' ? [matcher] : [],
				requiresApproval: disposition === 'ask' ? [matcher] : [],
				withoutApproval: 'remaining_admitted',
			};
			expect(state(input)).toEqual(expected);
			const result = explanation(input);
			expect(result.entries).toEqual([
				{
					operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
					account: { oauthAccountId: accountId },
					state: expected,
				},
			]);
			expect(result.perCallRule).toEqual({ source: 'account-policy', ruleId: 'run' });
		},
	);
	it('collapses agreeing aliases and splits disagreeing paths with exact admission states', () => {
		const input = googleFixture();
		const operation = googleOperation(input);
		if (operation.cliPolicy === null || operation.googleCommands === null)
			throw new Error('Missing Google policy');
		operation.cliPolicy.commands.push({ path: ['drive', 'search'], flagRules: [] });
		operation.googleCommands.descriptors = operation.googleCommands.descriptors.map(
			(descriptor) => ({ ...descriptor, paths: [...descriptor.paths, ['drive', 'search']] }),
		);
		operation.cliPolicy.calls = {
			deny: [],
			requiresApproval: [{ path: ['drive', 'list'], flags: [] }],
			withoutApproval: 'remaining_admitted',
		};
		expect(state(input)).toEqual({ kind: 'approval-each-call' });
		const second = structuredClone(input);
		if (second.call === null) throw new Error('Missing call');
		second.call.arguments = { argv: ['drive', 'search'], reason: 'test', accountId };
		expect(state(second)).toEqual({ kind: 'usable' });
		const result = explanation(input);
		expect(result.entries).toEqual([
			{
				operationClass: { kind: 'cli-command', commandPath: ['drive', 'list'] },
				account: { oauthAccountId: accountId },
				state: { kind: 'approval-each-call' },
			},
			{
				operationClass: { kind: 'cli-command', commandPath: ['drive', 'search'] },
				account: { oauthAccountId: accountId },
				state: { kind: 'usable' },
			},
		]);
		expect(result.perCallRule).toEqual({ source: 'account-policy', ruleId: 'run' });
		operation.cliPolicy.calls = {
			deny: [],
			requiresApproval: [
				{ path: ['drive', 'list'], flags: [] },
				{ path: ['drive', 'search'], flags: [] },
			],
			withoutApproval: 'remaining_admitted',
		};
		expect(explanation(input).entries).toEqual([
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				account: { oauthAccountId: accountId },
				state: { kind: 'approval-each-call' },
			},
		]);
	});
	it.each(['flag', 'stdin'] as const)(
		'names CLI allowance for a %s conditional matcher',
		(conditional) => {
			const input = googleFixture();
			const operation = googleOperation(input);
			if (operation.cliPolicy === null) throw new Error('Missing CLI policy');
			if (operation.googleCommands === null) throw new Error('Missing Google command set');
			operation.googleCommands.descriptors = operation.googleCommands.descriptors.map(
				(descriptor) => ({
					...descriptor,
					flags: [
						...descriptor.flags,
						{ kind: 'switch', name: '--publish', aliases: [], required: false },
					],
				}),
			);
			if (conditional === 'flag')
				operation.cliPolicy.calls = {
					deny: [],
					requiresApproval: [{ path: ['drive', 'list'], flags: [{ names: ['--publish'] }] }],
					withoutApproval: 'remaining_admitted',
				};
			else
				operation.cliPolicy.stdin = {
					kind: 'bounded_text',
					maxBytes: 100,
					deniedPatterns: [{ kind: 'literal', value: 'private' }],
				};
			expect(state(input)).toEqual({ kind: 'usable' });
			const result = explanation(input);
			expect(result.entries).toEqual([
				{
					operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
					account: { oauthAccountId: accountId },
					state: { kind: 'usable' },
				},
			]);
			expect(result.perCallRule).toEqual({ source: 'cli-allowance', ruleId: 'run' });
			const conditionalCall = structuredClone(input);
			conditionalCall.call = {
				arguments:
					conditional === 'flag'
						? { argv: ['drive', 'list', '--publish'], reason: 'test', accountId }
						: { argv: ['drive', 'list'], reason: 'test', accountId, stdin: 'private' },
				account: { oauthAccountId: accountId },
				digest,
			};
			expect(state(conditionalCall)).toEqual(
				conditional === 'flag' ? { kind: 'approval-each-call' } : blocked('cli-allowance'),
			);
		},
	);
});

describe('Google explain and admission separate accounts', () => {
	it('preserves both accounts decisions and revisions instead of reusing the first', () => {
		const input = googleFixture();
		const secondId = oauthAccountIdSchema.parse('10000000-0000-4000-8000-000000000002');
		const first = account(input);
		const second = structuredClone(first);
		second.account = { oauthAccountId: secondId };
		second.grantRevision = { owner: 'grant-2', revision: 'grant-v2' };
		second.policyRevision = { owner: 'policy-2', revision: 'policy-v2' };
		second.consentRevision = { owner: 'consent-2', revision: 'consent-v2' };
		second.decisions = [
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				result: { kind: 'denied', reason: 'policy' },
			},
		];
		input.facts.accounts = [first, second];
		expect(state(input)).toEqual({ kind: 'usable' });
		const selected = structuredClone(input);
		selected.call = {
			arguments: { argv: ['drive', 'list'], reason: 'test', accountId: secondId },
			account: { oauthAccountId: secondId },
			digest,
		};
		expect(state(selected)).toEqual(blocked('account-policy'));
		const result = explanation(input);
		expect(result.entries).toEqual([
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				account: { oauthAccountId: accountId },
				state: { kind: 'usable' },
			},
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				account: { oauthAccountId: secondId },
				state: blocked('account-policy'),
			},
		]);
		expect(result.revisions.accounts).toEqual([
			{
				account: { oauthAccountId: accountId },
				grant: { owner: 'grant', revision: 'v1' },
				policy: { owner: 'policy', revision: 'v1' },
				consent: { owner: 'consent', revision: 'v1' },
			},
			{
				account: { oauthAccountId: secondId },
				grant: { owner: 'grant-2', revision: 'grant-v2' },
				policy: { owner: 'policy-2', revision: 'policy-v2' },
				consent: { owner: 'consent-2', revision: 'consent-v2' },
			},
		]);
		const selectedResult = assessor(selected);
		if (selectedResult.kind !== 'assessed') throw new Error('Expected selected assessment');
		expect(selectedResult.assessment.revisions.accounts).toEqual(result.revisions.accounts);
	});
});
