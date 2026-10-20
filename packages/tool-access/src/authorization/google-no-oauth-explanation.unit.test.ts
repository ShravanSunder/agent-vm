import {
	assessAccessInput,
	type AccessAssessment,
	type AccessState,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import { oauthAccountIdSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import {
	account,
	assessor,
	blocked,
	digest,
	driveService,
	googleFixture,
	namespace,
	notUsable,
	state,
} from './access-assessor-test-fixture.js';

function helpFixture(
	mode: 'source' | 'static',
	accountCount: number,
	denied = false,
): AssessAccessInput {
	const input = googleFixture();
	const operation = namespace(input).operations.run;
	if (operation === undefined || operation.cliPolicy === null || operation.googleCommands === null)
		throw new Error('Missing Google operation');
	operation.googleCommands.noOAuthPaths = [['--help']];
	operation.cliPolicy.commands.push({ path: ['--help'], flagRules: [] });
	const deny = denied ? [{ path: ['--help'], flags: [] }] : [];
	operation.cliPolicy.calls =
		mode === 'source'
			? { source: 'managed_google_policy', deny }
			: { deny, requiresApproval: [], withoutApproval: 'remaining_admitted' };
	const second = structuredClone(account(input));
	second.account = {
		oauthAccountId: oauthAccountIdSchema.parse('10000000-0000-4000-8000-000000000002'),
	};
	input.facts.accounts =
		accountCount === 0
			? []
			: accountCount === 1
				? input.facts.accounts
				: [...input.facts.accounts, second];
	input.call = { arguments: { argv: ['--help'], reason: 'help' }, account: null, digest };
	return assessAccessInput.parse(input);
}

function explain(input: AssessAccessInput): Extract<AccessAssessment, { kind: 'call-dependent' }> {
	const value = structuredClone(input);
	value.call = null;
	value.facts.accounts = value.facts.accounts.map((fact) => ({ ...fact, boundToCall: null }));
	const result = assessor(assessAccessInput.parse(value));
	const admission = assessor(input);
	if (
		result.kind !== 'assessed' ||
		result.assessment.kind !== 'call-dependent' ||
		admission.kind !== 'assessed'
	)
		throw new Error('Expected explanation and admission');
	expect(result.assessment.revisions).toEqual(admission.assessment.revisions);
	expect(result.assessment.surface).toBe(admission.assessment.surface);
	return result.assessment;
}

function expectedEntries(
	input: AssessAccessInput,
	helpState: AccessState,
): Extract<AccessAssessment, { kind: 'call-dependent' }>['entries'] {
	return [
		...(input.facts.accounts.length === 0
			? [
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						account: null,
						state: notUsable('account-not-granted'),
					} satisfies Extract<AccessAssessment, { kind: 'call-dependent' }>['entries'][number],
				]
			: input.facts.accounts.map((fact) => ({
					operationClass: {
						kind: 'google-effect',
						serviceId: driveService,
						effect: 'read',
					} as const,
					account: fact.account,
					state: { kind: 'usable' } as const,
				}))),
		{
			operationClass: { kind: 'cli-command', commandPath: ['--help'] },
			account: null,
			state: helpState,
		},
	];
}

// Oracle: Lead's no-OAuth R28 correction. No account may be required or attached to the help entry.
describe.each(['source', 'static'] as const)('Google no-OAuth explanation (%s calls)', (mode) => {
	it.each([0, 1, 2])(
		'shows exact help once with account null alongside %i accounts',
		(accountCount) => {
			const input = helpFixture(mode, accountCount);
			expect(state(input)).toEqual({ kind: 'usable' });
			const result = explain(input);
			expect(result.entries).toEqual(expectedEntries(input, { kind: 'usable' }));
			expect(result.perCallRule).toEqual({ source: 'account-policy', ruleId: 'run' });
			const extra = structuredClone(input);
			extra.call = {
				arguments: { argv: ['--help', 'extra'], reason: 'help' },
				account: null,
				digest,
			};
			expect(state(extra)).toEqual(blocked('cli-allowance'));
		},
	);
	it('keeps a no-OAuth path-wide CLI deny as a known state', () => {
		const input = helpFixture(mode, 0, true);
		expect(state(input)).toEqual(blocked('cli-allowance'));
		expect(explain(input).entries).toEqual(expectedEntries(input, blocked('cli-allowance')));
	});
	it('deduplicates configured no-OAuth paths', () => {
		const input = helpFixture(mode, 2);
		const operation = namespace(input).operations.run;
		if (operation?.googleCommands === null || operation?.googleCommands === undefined)
			throw new Error('Missing Google set');
		operation.googleCommands.noOAuthPaths = [['--help'], ['--help']];
		expect(state(input)).toEqual({ kind: 'usable' });
		expect(explain(input).entries).toEqual(expectedEntries(input, { kind: 'usable' }));
	});
	it('still applies upstream readiness without an account', () => {
		const input = helpFixture(mode, 0);
		input.facts.upstream.status = 'unavailable';
		expect(state(input)).toEqual(notUsable('service-unavailable'));
		expect(explain(input).entries).toEqual(
			expectedEntries(input, notUsable('service-unavailable')),
		);
	});
});
