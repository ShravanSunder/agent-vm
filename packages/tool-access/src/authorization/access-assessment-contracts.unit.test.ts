import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	accessAssessment,
	assessAccessInput,
	assessAccessResult,
	hostAccessBinding,
	type AssessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import {
	accountId,
	driveService,
	gmailService,
	revision,
	binding,
	assessor,
	fixture,
	namespace,
	account,
	googleFixture,
	cliFixture,
	blocked,
} from './access-assessor-test-fixture.js';
function freeze(value: unknown): void {
	if (value === null || typeof value !== 'object') return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}
describe('explain result contract', () => {
	it('argument-independent capability is fixed', () => {
		const input = fixture();
		input.call = null;
		const result = assessor(input);
		expect(result.kind).toBe('assessed');
		if (result.kind === 'assessed')
			expect(result.assessment).toMatchObject({ kind: 'fixed', state: { kind: 'usable' } });
	});
	it('CLI paths retain path-wide denies and asks and a per-call flag/stdin rule', () => {
		const input = cliFixture();
		const operation = namespace(input).operations.run;
		if (operation?.cliPolicy === null || operation?.cliPolicy === undefined)
			throw new Error('Missing policy');
		operation.cliPolicy.commands.push(
			{ path: ['remove'], flagRules: [] },
			{ path: ['publish'], flagRules: [] },
		);
		if ('source' in operation.cliPolicy.calls) throw new Error('Expected static policy');
		operation.cliPolicy.calls.deny.push({ path: ['remove'], flags: [] });
		operation.cliPolicy.calls.requiresApproval.push({ path: ['publish'], flags: [] });
		input.call = null;
		const result = assessor(input);
		if (result.kind !== 'assessed') throw new Error('Expected assessment');
		expect(result.assessment).toMatchObject({
			kind: 'call-dependent',
			perCallRule: { source: 'cli-allowance', ruleId: 'run' },
			entries: [
				{
					operationClass: { kind: 'cli-command', commandPath: ['project', 'edit'] },
					account: null,
					state: { kind: 'usable' },
				},
				{
					operationClass: { kind: 'cli-command', commandPath: ['remove'] },
					account: null,
					state: blocked('cli-allowance'),
				},
				{
					operationClass: { kind: 'cli-command', commandPath: ['publish'] },
					account: null,
					state: { kind: 'approval-each-call' },
				},
			],
		});
	});
	it('Google keeps distinct service/effect/account allow, ask and deny entries', () => {
		const input = googleFixture();
		input.call = null;
		account(input).boundToCall = null;
		const operation = namespace(input).operations.run;
		if (operation?.googleCommands === null || operation?.googleCommands === undefined)
			throw new Error('Missing Google set');
		operation.googleCommands.descriptors = operation.googleCommands.descriptors.map(
			(descriptor) => ({
				...descriptor,
				requirements: [
					...descriptor.requirements,
					{ serviceId: gmailService, effects: ['write'] },
					{ serviceId: driveService, effects: ['write'] },
				],
			}),
		);
		account(input).decisions = [
			...account(input).decisions,
			{
				operationClass: { kind: 'google-effect', serviceId: gmailService, effect: 'write' },
				result: { kind: 'allowed', disposition: 'ask', overrideRevision: 1 },
			},
			{
				operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'write' },
				result: { kind: 'denied', reason: 'policy' },
			},
		];
		const result = assessor(input);
		if (result.kind !== 'assessed') throw new Error('Expected assessment');
		expect(result.assessment).toMatchObject({
			kind: 'call-dependent',
			perCallRule: { source: 'account-policy', ruleId: 'run' },
			entries: [
				{
					operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
					account: { oauthAccountId: accountId },
					state: { kind: 'usable' },
				},
				{
					operationClass: { kind: 'google-effect', serviceId: gmailService, effect: 'write' },
					account: { oauthAccountId: accountId },
					state: { kind: 'approval-each-call' },
				},
				{
					operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'write' },
					account: { oauthAccountId: accountId },
					state: blocked('account-policy'),
				},
			],
		});
	});
	it('generated valid admission inputs always return parsed fixed answers or facts-rejected', () => {
		let generated = 0;
		for (const surface of ['mcp', 'protected_uds'] as const)
			for (const granted of [true, false])
				for (const snapshot of ['active', 'applying', null] as const)
					for (const upstream of ['available', 'unavailable'] as const)
						for (const decision of [
							{ kind: 'allowed', disposition: 'allow', overrideRevision: 1 },
							{ kind: 'allowed', disposition: 'ask', overrideRevision: 1 },
							{ kind: 'denied', reason: 'command' },
							{ kind: 'denied', reason: 'policy' },
							{ kind: 'consent-required' },
							{ kind: 'unavailable' },
						] as const) {
							const input = googleFixture();
							input.surface = surface;
							account(input).granted = granted;
							account(input).policySnapshotState = snapshot;
							account(input).policyRevision = snapshot === null ? null : revision('policy');
							input.facts.upstream.status = upstream;
							account(input).decisions = [
								{
									operationClass: {
										kind: 'google-effect',
										serviceId: driveService,
										effect: 'read',
									},
									result: decision,
								},
							];
							const result = assessAccessResult.parse(assessor(assessAccessInput.parse(input)));
							if (result.kind === 'assessed') expect(result.assessment.kind).toBe('fixed');
							generated++;
						}
		expect(generated).toBe(144);
	});
});

describe('strict schemas, revisions and purity', () => {
	it('accepts neutral input and rejects supplied summaries, execution fields, tags, malformed revisions and unknowns', () => {
		const input = fixture();
		expect(assessAccessInput.safeParse(input).success).toBe(true);
		for (const key of [
			'state',
			'operationClass',
			'target',
			'image',
			'credential',
			'executor',
			'unknown',
		]) {
			expect(assessAccessInput.safeParse({ ...input, [key]: 'forged' }).success).toBe(false);
			expect(
				assessAccessInput.safeParse({
					...input,
					facts: {
						...input.facts,
						assignment: {
							...input.facts.assignment,
							profile: { ...input.facts.assignment.profile, [key]: 'forged' },
						},
					},
				}).success,
			).toBe(false);
			expect(
				assessAccessInput.safeParse({ ...input, call: { ...input.call, [key]: 'forged' } }).success,
			).toBe(false);
		}
		expect(hostAccessBinding.safeParse({ ...binding, workspaceLayer: 'forged' }).success).toBe(
			false,
		);
		expect(
			hostAccessBinding.safeParse({ ...binding, config: { owner: '', revision: 'v1' } }).success,
		).toBe(false);
		expect(
			assessAccessInput.safeParse({
				...input,
				facts: {
					...input.facts,
					assignment: { ...input.facts.assignment, revision: { owner: 'x', revision: 1 } },
				},
			}).success,
		).toBe(false);
	});
	it('strictly accepts and refuses both assessment variants', () => {
		const input = fixture();
		const result = assessor(input);
		if (result.kind !== 'assessed') throw new Error('Expected answer');
		expect(accessAssessment.safeParse(result.assessment).success).toBe(true);
		expect(accessAssessment.safeParse({ ...result.assessment, extra: true }).success).toBe(false);
		expect(
			accessAssessment.safeParse({ ...result.assessment, state: { kind: 'not-usable' } }).success,
		).toBe(false);
		const conditional = {
			kind: 'call-dependent',
			surface: 'mcp',
			revisions: result.assessment.revisions,
			entries: [],
			perCallRule: { source: 'cli-allowance', ruleId: 'run' },
		};
		expect(accessAssessment.safeParse(conditional).success).toBe(true);
		expect(
			accessAssessment.safeParse({
				...conditional,
				perCallRule: { source: 'invented', ruleId: 'run' },
			}).success,
		).toBe(false);
		expect(accessAssessment.safeParse({ ...conditional, state: { kind: 'usable' } }).success).toBe(
			false,
		);
		expect(
			accessAssessment.safeParse({
				...conditional,
				entries: [{ operationClass: null, account: null, state: { kind: 'blocked-by-policy' } }],
			}).success,
		).toBe(false);
	});
	it('copies each revision from its named source; one changed source changes only that field', () => {
		const input = googleFixture();
		const result = assessor(input);
		if (result.kind !== 'assessed') throw new Error('Expected answer');
		const expected = {
			hostConfig: revision('host'),
			registration: revision('registration'),
			workspaceAllowance: revision('allowance'),
			profile: revision('profile'),
			assignment: revision('assignment'),
			surfaceSnapshot: revision('surface'),
			upstreamBinding: revision('upstream'),
			accounts: [
				{
					account: { oauthAccountId: accountId },
					grant: revision('grant'),
					policy: revision('policy'),
					consent: revision('consent'),
				},
			],
		};
		expect(result.assessment.revisions).toEqual(expected);
		const variations: readonly { field: string; change: (input: AssessAccessInput) => void }[] = [
			{
				field: 'registration',
				change: (value) => {
					if (value.facts.workspace.kind === 'configured')
						value.facts.workspace.registration.revision = revision('changed');
				},
			},
			{
				field: 'workspaceAllowance',
				change: (value) => {
					if (value.facts.workspace.kind === 'configured')
						value.facts.workspace.allowance.revision = revision('changed');
				},
			},
			{
				field: 'profile',
				change: (value) => {
					value.facts.assignment.profileRevision = revision('changed');
				},
			},
			{
				field: 'assignment',
				change: (value) => {
					value.facts.assignment.revision = revision('changed');
				},
			},
			{
				field: 'surfaceSnapshot',
				change: (value) => {
					value.facts.surface.snapshot = revision('changed');
				},
			},
			{
				field: 'upstreamBinding',
				change: (value) => {
					value.facts.upstream.binding = revision('changed');
				},
			},
		];
		for (const { field, change } of variations) {
			const value = googleFixture();
			change(value);
			const changed = assessor(value);
			if (changed.kind !== 'assessed') throw new Error('Expected answer');
			expect(changed.assessment.revisions).toEqual({ ...expected, [field]: revision('changed') });
		}
		for (const field of ['grant', 'policy', 'consent'] as const) {
			const value = googleFixture();
			const fact = account(value);
			if (field === 'grant') fact.grantRevision = revision('changed');
			if (field === 'policy') fact.policyRevision = revision('changed');
			if (field === 'consent') fact.consentRevision = revision('changed');
			const changed = assessor(value);
			if (changed.kind !== 'assessed') throw new Error('Expected answer');
			expect(changed.assessment.revisions).toEqual({
				...expected,
				accounts: [{ ...expected.accounts[0], [field]: revision('changed') }],
			});
		}
		const changed = createAccessAssessor({ ...binding, config: revision('changed') })(input);
		if (changed.kind !== 'assessed') throw new Error('Expected answer');
		expect(changed.assessment.revisions).toEqual({ ...expected, hostConfig: revision('changed') });
	});
	it('does not mutate frozen input or binding and is deterministic', () => {
		const input = googleFixture();

		freeze(input);
		const localBinding = structuredClone(binding);
		freeze(localBinding);
		const assess = createAccessAssessor(localBinding);
		const before = JSON.stringify(input);
		expect(assess(input)).toEqual(assess(input));
		expect(JSON.stringify(input)).toBe(before);
	});
});
