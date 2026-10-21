import {
	assessAccessInput,
	type AccessAssessment,
	type AccessState,
	type AssessAccessInput,
	type CompiledGoogleCommandSet,
	type ConfiguredCliPolicy,
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
	gmailService,
	googleFixture,
	namespace,
	state,
} from '#tool-access/authorization/access-assessor-test-fixture';

type AccessEntry = Extract<AccessAssessment, { kind: 'call-dependent' }>['entries'][number];
type CallsMode = 'source' | 'static';

function googleOperation(input: AssessAccessInput): {
	cliPolicy: ConfiguredCliPolicy;
	googleCommands: CompiledGoogleCommandSet;
} {
	const operation = namespace(input).operations.run;
	if (operation === undefined || operation.cliPolicy === null || operation.googleCommands === null)
		throw new Error('Missing Google policy');
	return { cliPolicy: operation.cliPolicy, googleCommands: operation.googleCommands };
}

function setCalls(input: AssessAccessInput, mode: CallsMode, deniedPaths: string[][] = []): void {
	const { cliPolicy } = googleOperation(input);
	const deny = deniedPaths.map((path) => ({ path, flags: [] }));
	cliPolicy.calls =
		mode === 'source'
			? { source: 'managed_google_policy', deny }
			: { deny, requiresApproval: [], withoutApproval: 'remaining_admitted' };
}

function explain(input: AssessAccessInput): Extract<AccessAssessment, { kind: 'call-dependent' }> {
	const explanationInput = structuredClone(input);
	explanationInput.call = null;
	explanationInput.facts.accounts = explanationInput.facts.accounts.map((fact) => ({
		...fact,
		boundToCall: null,
	}));
	const result = assessor(assessAccessInput.parse(explanationInput));
	const admission = assessor(assessAccessInput.parse(input));
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

function selectPath(
	input: AssessAccessInput,
	path: readonly string[],
	selectedId = accountId,
): AssessAccessInput {
	const selected = structuredClone(input);
	selected.call = {
		arguments: { argv: [...path], reason: 'test', accountId: selectedId },
		account: { oauthAccountId: selectedId },
		digest,
	};
	return assessAccessInput.parse(selected);
}

function sortedEntries(entries: readonly AccessEntry[]): readonly AccessEntry[] {
	return entries.toSorted((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
}

function commandEntry(
	path: readonly string[],
	expected: AccessState,
	selectedId = accountId,
): AccessEntry {
	return {
		operationClass: { kind: 'cli-command', commandPath: path },
		account: { oauthAccountId: selectedId },
		state: expected,
	};
}

// Literal oracles: Lead's N2 correction. Admission is exercised separately, never used to derive expected entries.
describe.each(['source', 'static'] as const)(
	'Google argv-dependent CLI attribution (%s calls)',
	(mode) => {
		it.each(['literal', 'regex'] as const)(
			'names CLI for a %s positional denial, preserving public admission',
			(kind) => {
				const input = googleFixture();
				setCalls(input, mode);
				const { cliPolicy, googleCommands } = googleOperation(input);
				cliPolicy.deniedPatterns = [{ kind, value: kind === 'literal' ? 'private' : '^private$' }];
				googleCommands.descriptors = googleCommands.descriptors.map((descriptor) => ({
					...descriptor,
					positionals: { minimum: 1, maximum: 1 },
				}));
				const publicCall = selectPath(input, ['drive', 'list', 'public']);
				const privateCall = selectPath(input, ['drive', 'list', 'private']);
				expect(state(publicCall)).toEqual({ kind: 'usable' });
				expect(state(privateCall)).toEqual(blocked('cli-allowance'));
				const expectedEntries: readonly AccessEntry[] = [
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						account: { oauthAccountId: accountId },
						state: { kind: 'usable' },
					},
				];
				for (const selected of [publicCall, privateCall]) {
					const result = explain(selected);
					expect(result.entries).toEqual(expectedEntries);
					expect(result.perCallRule).toEqual({ source: 'cli-allowance', ruleId: 'run' });
				}
			},
		);
		it('retains a pattern matching the fixed path as a known CLI denial', () => {
			const input = googleFixture();
			setCalls(input, mode);
			googleOperation(input).cliPolicy.deniedPatterns = [{ kind: 'literal', value: 'list' }];
			expect(state(input)).toEqual(blocked('cli-allowance'));
			const result = explain(input);
			expect(result.entries).toEqual([
				{
					operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
					account: { oauthAccountId: accountId },
					state: blocked('cli-allowance'),
				},
			]);
			expect(result.perCallRule).toEqual({ source: 'cli-allowance', ruleId: 'run' });
		});
	},
);

function threePathFixture(
	mode: CallsMode,
	reverseDescriptors: boolean,
	reverseEffects: boolean,
): AssessAccessInput {
	const input = googleFixture();
	const { cliPolicy, googleCommands } = googleOperation(input);
	cliPolicy.commands = [
		['drive', 'combo'],
		['drive', 'read'],
		['gmail', 'send'],
	].map((path) => ({ path, flagRules: [] }));
	setCalls(input, mode, [['gmail', 'send']]);
	const comboRequirements: CompiledGoogleCommandSet['descriptors'][number]['requirements'] = [
		{ serviceId: driveService, effects: ['read'] },
		{ serviceId: gmailService, effects: ['write'] },
	];
	const descriptors: CompiledGoogleCommandSet['descriptors'] = [
		{
			operationId: 'drive-combo',
			familyId: 'documents',
			paths: [['drive', 'combo']],
			requirements: reverseEffects ? comboRequirements.toReversed() : comboRequirements,
			sendsMail: false,
			positionals: { minimum: 0, maximum: 0 },
			flags: [],
		},
		{
			operationId: 'drive-read',
			familyId: 'documents',
			paths: [['drive', 'read']],
			requirements: [{ serviceId: driveService, effects: ['read'] }],
			sendsMail: false,
			positionals: { minimum: 0, maximum: 0 },
			flags: [],
		},
		{
			operationId: 'gmail-send',
			familyId: 'communications',
			paths: [['gmail', 'send']],
			requirements: [{ serviceId: gmailService, effects: ['write'] }],
			sendsMail: false,
			positionals: { minimum: 0, maximum: 0 },
			flags: [],
		},
	];
	googleCommands.descriptors = reverseDescriptors ? descriptors.toReversed() : descriptors;
	account(input).decisions = [
		...account(input).decisions,
		{
			operationClass: { kind: 'google-effect', serviceId: gmailService, effect: 'write' },
			result: { kind: 'denied', reason: 'policy' },
		},
	];
	return selectPath(input, ['drive', 'combo']);
}

const variations = [false, true].flatMap((descriptors) =>
	[false, true].map((effects) => ({ descriptors, effects })),
);

describe.each(['source', 'static'] as const)(
	'Google full-path/account grouping (%s calls)',
	(mode) => {
		it.each(variations)(
			'keeps the three-path witness truthful (descriptor order $descriptors, effect order $effects)',
			({ descriptors, effects }) => {
				const input = threePathFixture(mode, descriptors, effects);
				expect(state(selectPath(input, ['drive', 'combo']))).toEqual(blocked('account-policy'));
				expect(state(selectPath(input, ['drive', 'read']))).toEqual({ kind: 'usable' });
				expect(state(selectPath(input, ['gmail', 'send']))).toEqual(blocked('cli-allowance'));
				const result = explain(input);
				expect(sortedEntries(result.entries)).toEqual(
					sortedEntries([
						commandEntry(['drive', 'combo'], blocked('account-policy')),
						commandEntry(['drive', 'read'], { kind: 'usable' }),
						commandEntry(['gmail', 'send'], blocked('cli-allowance')),
					]),
				);
				expect(result.perCallRule).toEqual({ source: 'account-policy', ruleId: 'run' });
			},
		);
		it('groups separately for two accounts and deduplicates split paths per account', () => {
			const input = threePathFixture(mode, false, false);
			const secondId = oauthAccountIdSchema.parse('10000000-0000-4000-8000-000000000002');
			const second = structuredClone(account(input));
			second.account = { oauthAccountId: secondId };
			second.policyRevision = { owner: 'second-policy', revision: 'v2' };
			second.decisions = second.decisions.map((decision) => ({
				...decision,
				result: { kind: 'allowed', disposition: 'allow', overrideRevision: 2 },
			}));
			input.facts.accounts = [...input.facts.accounts, second];
			for (const selectedId of [accountId, secondId]) {
				expect(state(selectPath(input, ['drive', 'combo'], selectedId))).toEqual(
					selectedId === accountId ? blocked('account-policy') : { kind: 'usable' },
				);
				expect(state(selectPath(input, ['drive', 'read'], selectedId))).toEqual({ kind: 'usable' });
				expect(state(selectPath(input, ['gmail', 'send'], selectedId))).toEqual(
					blocked('cli-allowance'),
				);
			}
			const result = explain(input);
			expect(sortedEntries(result.entries)).toEqual(
				sortedEntries([
					commandEntry(['drive', 'combo'], blocked('account-policy')),
					commandEntry(['drive', 'read'], { kind: 'usable' }),
					commandEntry(['gmail', 'send'], blocked('cli-allowance')),
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						account: { oauthAccountId: secondId },
						state: { kind: 'usable' },
					},
					commandEntry(['drive', 'combo'], { kind: 'usable' }, secondId),
					commandEntry(['gmail', 'send'], blocked('cli-allowance'), secondId),
				]),
			);
			expect(result.perCallRule).toEqual({ source: 'account-policy', ruleId: 'run' });
			expect(explain(selectPath(input, ['drive', 'combo'], secondId))).toEqual(result);
		});
		it.each(['allow', 'ask', 'deny'] as const)(
			'wholly collapses a multi-effect path to its complete %s state',
			(decision) => {
				const input = threePathFixture(mode, false, false);
				const { cliPolicy, googleCommands } = googleOperation(input);
				googleCommands.descriptors = googleCommands.descriptors.filter(
					(descriptor) => descriptor.operationId === 'drive-combo',
				);
				cliPolicy.commands = [{ path: ['drive', 'combo'], flagRules: [] }];
				setCalls(input, mode);
				account(input).decisions = account(input).decisions.map((entry) =>
					entry.operationClass.serviceId === gmailService
						? {
								...entry,
								result:
									decision === 'deny'
										? { kind: 'denied', reason: 'policy' }
										: { kind: 'allowed', disposition: decision, overrideRevision: 1 },
							}
						: entry,
				);
				const expected: AccessState =
					decision === 'deny'
						? blocked('account-policy')
						: { kind: decision === 'ask' ? 'approval-each-call' : 'usable' };
				expect(state(input)).toEqual(expected);
				const result = explain(input);
				expect(sortedEntries(result.entries)).toEqual(
					sortedEntries([
						{
							operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
							account: { oauthAccountId: accountId },
							state: expected,
						},
						{
							operationClass: { kind: 'google-effect', serviceId: gmailService, effect: 'write' },
							account: { oauthAccountId: accountId },
							state: expected,
						},
					]),
				);
				expect(result.perCallRule).toEqual({ source: 'account-policy', ruleId: 'run' });
			},
		);
	},
);
