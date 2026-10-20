import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	type AccessState,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import {
	digest,
	driveService,
	revision,
	binding,
	assessor,
	fixture,
	namespace,
	account,
	googleFixture,
	cliFixture,
	state,
	notUsable,
	blocked,
} from './access-assessor-test-fixture.js';
describe('10-step first-unmet order', () => {
	const rows: readonly {
		name: string;
		change: (input: AssessAccessInput) => void;
		expected: AccessState;
	}[] = [
		{
			name: '1 revoked beats retained allowance and capability deny',
			change: (input) => {
				if (input.facts.workspace.kind === 'configured')
					input.facts.workspace.registration.status = 'revoked';
				namespace(input).tools.deny = ['run'];
			},
			expected: notUsable('registration-revoked'),
		},
		{
			name: '2 workspace deny beats missing assignment and surface',
			change: (input) => {
				if (input.facts.workspace.kind === 'configured')
					input.facts.workspace.allowance.allowed = false;
				input.facts.assignment.profile.namespaces = {};
				input.facts.surface.eligible = [];
			},
			expected: notUsable('not-allowed-in-workspace'),
		},
		{
			name: '3 hidden capability beats command deny',
			change: (input) => {
				namespace(input).tools.allow = [];
				account(input).decisions = [
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						result: { kind: 'denied', reason: 'command' },
					},
				];
			},
			expected: notUsable('not-given-to-agent'),
		},
		{
			name: '4 selector deny beats no grant and applying/account deny',
			change: (input) => {
				namespace(input).tools.deny = ['run'];
				account(input).granted = false;
				account(input).policySnapshotState = 'applying';
				account(input).decisions = [
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						result: { kind: 'denied', reason: 'policy' },
					},
				];
			},
			expected: blocked('profile-selector'),
		},
		{
			name: '5 not granted beats applying',
			change: (input) => {
				account(input).granted = false;
				account(input).policySnapshotState = 'applying';
			},
			expected: notUsable('account-not-granted'),
		},
		{
			name: '6 applying beats hard limit, consent and unavailable',
			change: (input) => {
				account(input).policySnapshotState = 'applying';
				account(input).availability = { kind: 'consent-required' };
				account(input).decisions = [
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						result: { kind: 'denied', reason: 'hard-limit' },
					},
				];
				input.facts.upstream.status = 'unavailable';
			},
			expected: notUsable('account-policy-paused'),
		},
		{
			name: '7 hard-limit deny beats missing consent',
			change: (input) => {
				account(input).availability = { kind: 'consent-required' };
				account(input).decisions = [
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						result: { kind: 'denied', reason: 'hard-limit' },
					},
				];
			},
			expected: blocked('account-policy'),
		},
		{
			name: '7 policy deny beats missing consent',
			change: (input) => {
				account(input).availability = { kind: 'consent-required' };
				account(input).decisions = [
					{
						operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
						result: { kind: 'denied', reason: 'policy' },
					},
				];
			},
			expected: blocked('account-policy'),
		},
		{
			name: '8 missing consent beats unavailable upstream',
			change: (input) => {
				account(input).availability = { kind: 'consent-required' };
				input.facts.upstream.status = 'unavailable';
			},
			expected: notUsable('consent-missing-or-expired'),
		},
		{
			name: '9 unavailable beats ask',
			change: (input) => {
				account(input).availability = {
					kind: 'ready',
					disposition: 'ask',
					overrideRevision: 1,
					defaultsRevision: 'd',
				};
				input.facts.upstream.status = 'unavailable';
			},
			expected: notUsable('service-unavailable'),
		},
		{ name: '10 fully satisfied allow', change: () => {}, expected: { kind: 'usable' } },
		{
			name: '10 one account source asks among allows',
			change: (input) => {
				account(input).availability = {
					kind: 'ready',
					disposition: 'ask',
					overrideRevision: 1,
					defaultsRevision: 'd',
				};
			},
			expected: { kind: 'approval-each-call' },
		},
	];
	it.each(rows)('$name', ({ change, expected }) => {
		const input = googleFixture();
		change(input);
		expect(state(input)).toEqual(expected);
	});
	it('MCP call-policy deny beats later service unavailability', () => {
		const input = fixture();
		namespace(input).calls = {
			kind: 'selectors',
			requiresApproval: { allow: [], deny: [] },
			withoutApproval: { allow: [], deny: [] },
		};
		input.facts.upstream.status = 'unavailable';
		expect(state(input)).toEqual(blocked('mcp-approval-policy'));
	});
	it('surface ineligibility beats explicit selector deny', () => {
		const input = fixture();
		input.facts.surface.eligible = [];
		namespace(input).tools.deny = ['run'];
		expect(state(input)).toEqual(notUsable('not-given-to-agent'));
	});
});

describe('full CLI arguments at admission', () => {
	it('admits the same path control and asks for a matched approval flag', () => {
		const input = cliFixture();
		expect(state(input)).toEqual({ kind: 'usable' });
		input.call = {
			arguments: { argv: ['project', 'edit', '--publish'], reason: 'test' },
			account: null,
			digest,
		};
		expect(state(input)).toEqual({ kind: 'approval-each-call' });
	});
	it.each([
		{ argv: ['project', 'edit', '--format', 'xml'], reason: 'test' },
		{ argv: ['project', 'edit', 'forbidden'], reason: 'test' },
		{ argv: ['project', 'edit'], reason: 'test', stdin: 'unexpected' },
		{ argv: ['project', 'edit', '--force'], reason: 'test' },
		{ argv: ['project', 'edit'], reason: 'test', timeoutMs: 100 },
		{ argv: ['project', 'edit'], reason: '' },
		{ argv: ['project', 'edit', '\n'], reason: 'test' },
	])('denies exact flag/pattern/stdin/malformed input %j', (args) => {
		const input = cliFixture();
		input.call = { arguments: args, account: null, digest };
		expect(state(input)).toEqual(blocked('cli-allowance'));
	});
	it('rejects malformed open input and derives the command from multi-operation argv', () => {
		const input = cliFixture();
		const operation = namespace(input).operations.run;
		if (operation?.cliPolicy === null || operation?.cliPolicy === undefined)
			throw new Error('Missing CLI policy');
		operation.cliPolicy.timeout = { kind: 'open' };
		operation.cliPolicy.commands.push({ path: ['project', 'show'], flagRules: [] });
		input.call = {
			arguments: { argv: ['project', 'edit'], reason: 'test', timeoutMs: -1 },
			account: null,
			digest,
		};
		expect(state(input)).toEqual(blocked('cli-allowance'));
		input.call = {
			arguments: { argv: ['project', 'show'], reason: 'test', timeoutMs: 100 },
			account: null,
			digest,
		};
		expect(state(input)).toEqual({ kind: 'usable' });
	});
	it('counts UTF-8 bytes, including surrogate replacement, without Node Buffer', () => {
		const input = cliFixture();
		const operation = namespace(input).operations.run;
		if (operation?.cliPolicy === null || operation?.cliPolicy === undefined)
			throw new Error('Missing CLI policy');
		operation.cliPolicy.stdin = { kind: 'bounded_text', maxBytes: 4, deniedPatterns: [] };
		for (const [stdin, expected] of [
			['😀', { kind: 'usable' }],
			['éé', { kind: 'usable' }],
			['ééa', blocked('cli-allowance')],
			['\ud800', { kind: 'usable' }],
		] satisfies readonly (readonly [string, AccessState])[]) {
			input.call = {
				arguments: { argv: ['project', 'edit'], reason: 'test', stdin },
				account: null,
				digest,
			};
			expect(state(input)).toEqual(expected);
		}
	});
});

describe('account facts and binding', () => {
	it('retains a static CLI approval matcher alongside Google account decisions', () => {
		const input = googleFixture();
		const operation = namespace(input).operations.run;
		if (operation?.cliPolicy === null || operation?.cliPolicy === undefined)
			throw new Error('Missing CLI policy');
		operation.cliPolicy.calls = {
			deny: [],
			requiresApproval: [{ path: ['drive', 'list'], flags: [] }],
			withoutApproval: 'remaining_admitted',
		};
		expect(state(input)).toEqual({ kind: 'approval-each-call' });
	});
	it('admits the exact no-OAuth command without inventing an account grant', () => {
		const input = googleFixture();
		const operation = namespace(input).operations.run;
		if (operation?.cliPolicy === null || operation?.cliPolicy === undefined)
			throw new Error('Missing CLI policy');
		operation.cliPolicy.commands.push({ path: ['--help'], flagRules: [] });
		input.call = { arguments: { argv: ['--help'], reason: 'help' }, account: null, digest };
		input.facts.accounts = [];
		expect(state(input)).toEqual({ kind: 'usable' });
		input.call = {
			arguments: { argv: ['--help', 'extra'], reason: 'help' },
			account: null,
			digest,
		};
		expect(state(input)).toEqual(blocked('cli-allowance'));
	});
	it('matching digest admitted; different or null admission binding refused', () => {
		const input = googleFixture();
		expect(state(input)).toEqual({ kind: 'usable' });
		for (const bound of ['b'.repeat(64), null]) {
			account(input).boundToCall = bound;
			expect(assessor(input)).toEqual({
				kind: 'facts-rejected',
				reason: 'account-decision-unbound',
			});
		}
	});
	it('explain accepts only null account bindings', () => {
		const input = googleFixture();
		input.call = null;
		expect(assessor(input)).toEqual({ kind: 'facts-rejected', reason: 'account-decision-unbound' });
		account(input).boundToCall = null;
		expect(assessor(input).kind).toBe('assessed');
	});
	it('command deny precedes applying; allowed command at that snapshot is paused', () => {
		const input = googleFixture();
		account(input).policySnapshotState = 'applying';
		account(input).decisions = [
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				result: { kind: 'denied', reason: 'command' },
			},
		];
		expect(state(input)).toEqual(blocked('cli-allowance'));
		account(input).decisions = [
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				result: { kind: 'allowed', disposition: 'allow', overrideRevision: 1 },
			},
		];
		expect(state(input)).toEqual(notUsable('account-policy-paused'));
	});
	it('applying unavailable is paused, active unavailable is unavailable, active consent is consent', () => {
		const input = googleFixture();
		account(input).decisions = [
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				result: { kind: 'unavailable' },
			},
		];
		account(input).policySnapshotState = 'applying';
		expect(state(input)).toEqual(notUsable('account-policy-paused'));
		account(input).policySnapshotState = 'active';
		expect(state(input)).toEqual(notUsable('service-unavailable'));
		account(input).decisions = [
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
				result: { kind: 'consent-required' },
			},
		];
		expect(state(input)).toEqual(notUsable('consent-missing-or-expired'));
	});
	it('no verified snapshot or decision fails closed, with a usable control', () => {
		const input = googleFixture();
		expect(state(input)).toEqual({ kind: 'usable' });
		account(input).decisions = [];
		expect(state(input)).toEqual(notUsable('service-unavailable'));
		const second = googleFixture();
		account(second).policySnapshotState = null;
		account(second).policyRevision = null;
		expect(state(second)).toEqual(notUsable('service-unavailable'));
	});
	it.each(['unavailable', 'consent-required', 'denied'] as const)(
		'projects activity availability %s',
		(kind) => {
			const input = googleFixture();
			account(input).availability = { kind };
			expect(state(input)).toEqual(
				kind === 'denied'
					? blocked('account-policy')
					: notUsable(
							kind === 'consent-required' ? 'consent-missing-or-expired' : 'service-unavailable',
						),
			);
		},
	);
	it.each(['none', 'met', 'unmet'] as const)('credential need %s', (credentialNeed) => {
		const input = fixture();
		input.facts.upstream.credentialNeed = credentialNeed;
		expect(state(input)).toEqual(
			credentialNeed === 'unmet' ? notUsable('service-unavailable') : { kind: 'usable' },
		);
	});
});

describe('surface and workspace binding', () => {
	it('the same arguments are eligible on one surface and each result names its snapshot', () => {
		const input = fixture();
		input.facts.surface.eligible = ['protected_uds'];
		expect(state(input)).toEqual(notUsable('not-given-to-agent'));
		const denied = assessor(input);
		input.surface = 'protected_uds';
		expect(state(input)).toEqual({ kind: 'usable' });
		const allowed = assessor(input);
		for (const [result, surface] of [
			[denied, 'mcp'],
			[allowed, 'protected_uds'],
		] as const) {
			if (result.kind !== 'assessed') throw new Error('Expected answer');
			expect(result.assessment.surface).toBe(surface);
			expect(result.assessment.revisions.surfaceSnapshot).toEqual(revision('surface'));
		}
	});
	it('not-configured skips workspace checks but still enforces the profile', () => {
		const input = fixture();
		input.facts.workspace = { kind: 'not-configured' };
		const assess = createAccessAssessor({ ...binding, workspaceLayer: 'not-configured' });
		const result = assess(input);
		if (result.kind !== 'assessed' || result.assessment.kind !== 'fixed')
			throw new Error('Expected fixed');
		expect(result.assessment.state).toEqual({ kind: 'usable' });
		expect(result.assessment.revisions.registration).toBeNull();
		expect(result.assessment.revisions.workspaceAllowance).toBeNull();
		namespace(input).tools.deny = ['run'];
		const denied = assess(input);
		if (denied.kind !== 'assessed' || denied.assessment.kind !== 'fixed')
			throw new Error('Expected fixed');
		expect(denied.assessment.state).toEqual(blocked('profile-selector'));
	});
	it('rejects both host/fact layer mismatches', () => {
		const input = fixture();
		expect(createAccessAssessor({ ...binding, workspaceLayer: 'not-configured' })(input)).toEqual({
			kind: 'facts-rejected',
			reason: 'workspace-layer-mismatch',
		});
		input.facts.workspace = { kind: 'not-configured' };
		expect(assessor(input)).toEqual({ kind: 'facts-rejected', reason: 'workspace-layer-mismatch' });
	});
	it('configured facts require registration and allowance', () => {
		const input = fixture();
		expect(
			assessAccessInput.safeParse({
				...input,
				facts: { ...input.facts, workspace: { kind: 'configured' } },
			}).success,
		).toBe(false);
	});
});
