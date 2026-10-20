import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	assessAccessResult,
	configuredCliPolicySchema,
	type AccessState,
	type AccountFact,
	type AssessAccessInput,
	type HostAccessBinding,
} from '@agent-collaboration/tool-access/contracts';
import { oauthAccountIdSchema, oauthServiceIdSchema } from '@agent-vm/oauth-broker-contracts';
import { expect } from 'vitest';

export const digest = 'a'.repeat(64);
export const accountId = oauthAccountIdSchema.parse('10000000-0000-4000-8000-000000000001');
export const driveService = oauthServiceIdSchema.parse('drive');
export const gmailService = oauthServiceIdSchema.parse('gmail');
export const revision = (owner: string): { owner: string; revision: string } => ({
	owner,
	revision: 'v1',
});
export const binding: HostAccessBinding = {
	workspaceLayer: 'configured',
	config: revision('host'),
};
export const assessor = createAccessAssessor(binding);

export function fixture(): AssessAccessInput {
	return assessAccessInput.parse({
		capability: { namespace: 'tools', tool: 'run' },
		surface: 'mcp',
		call: { arguments: {}, account: null, digest },
		facts: {
			workspace: {
				kind: 'configured',
				registration: { status: 'active', revision: revision('registration') },
				allowance: {
					allowed: true,
					rule: { source: 'workspace-allowance', ruleId: 'workspace' },
					revision: revision('allowance'),
				},
			},
			assignment: {
				profile: {
					profileId: 'builder',
					namespaces: {
						tools: {
							backendKind: 'mcp_provider',
							tools: { allow: '*', deny: [] },
							calls: {
								kind: 'selectors',
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: '*', deny: [] },
							},
							operations: {},
						},
					},
				},
				profileRevision: revision('profile'),
				revision: revision('assignment'),
			},
			surface: { eligible: ['mcp', 'protected_uds'], snapshot: revision('surface') },
			accounts: [],
			upstream: { status: 'available', credentialNeed: 'none', binding: revision('upstream') },
		},
	});
}

export function namespace(
	input: AssessAccessInput,
): AssessAccessInput['facts']['assignment']['profile']['namespaces'][string] {
	const value = input.facts.assignment.profile.namespaces.tools;
	if (value === undefined) throw new Error('Missing test namespace');
	return value;
}

export function account(input: AssessAccessInput): AccountFact {
	const value = input.facts.accounts[0];
	if (value === undefined) throw new Error('Missing test account');
	return value;
}

export function googleFixture(): AssessAccessInput {
	const input = fixture();
	input.call = {
		arguments: { argv: ['drive', 'list'], reason: 'test', accountId },
		account: { oauthAccountId: accountId },
		digest,
	};
	const policy = namespace(input);
	policy.backendKind = 'controller_execution';
	policy.calls = { kind: 'account-policy' };
	policy.operations.run = {
		cliPolicy: configuredCliPolicySchema.parse({
			commands: [{ path: ['drive', 'list'] }],
			calls: { source: 'managed_google_policy' },
			timeout: { kind: 'quick' },
		}),
		googleCommands: {
			descriptors: [
				{
					operationId: 'drive-list',
					familyId: 'documents',
					paths: [['drive', 'list']],
					requirements: [{ serviceId: driveService, effects: ['read'] }],
					sendsMail: false,
					positionals: { minimum: 0, maximum: 0 },
					flags: [],
				},
			],
			noOAuthPaths: [],
			applicationIdsByFamily: {
				documents: 'workspace-app',
				communications: 'gmail-app',
				youtube: 'youtube-app',
			},
			revision: 'b'.repeat(64),
		},
	};
	input.facts.accounts = [
		{
			account: { oauthAccountId: accountId },
			granted: true,
			grantRevision: revision('grant'),
			policySnapshotState: 'active',
			policyRevision: revision('policy'),
			consentRevision: revision('consent'),
			availability: {
				kind: 'ready',
				disposition: 'allow',
				overrideRevision: 1,
				defaultsRevision: 'defaults-v1',
			},
			boundToCall: digest,
			decisions: [
				{
					operationClass: { kind: 'google-effect', serviceId: driveService, effect: 'read' },
					result: { kind: 'allowed', disposition: 'allow', overrideRevision: 1 },
				},
			],
		},
	];
	return assessAccessInput.parse(input);
}

export function cliFixture(): AssessAccessInput {
	const input = fixture();
	const policy = namespace(input);
	policy.backendKind = 'controller_execution';
	policy.operations.run = {
		cliPolicy: configuredCliPolicySchema.parse({
			commands: [
				{
					path: ['project', 'edit'],
					flagRules: [{ kind: 'allowed_values', names: ['--format'], values: ['json'] }],
				},
			],
			deniedPatterns: [{ kind: 'literal', value: 'forbidden' }],
			stdin: { kind: 'none' },
			timeout: { kind: 'quick' },
			calls: {
				deny: [{ path: ['project', 'edit'], flags: [{ names: ['--force'] }] }],
				requiresApproval: [{ path: ['project', 'edit'], flags: [{ names: ['--publish'] }] }],
				withoutApproval: 'remaining_admitted',
			},
		}),
		googleCommands: null,
	};
	input.call = { arguments: { argv: ['project', 'edit'], reason: 'test' }, account: null, digest };
	return input;
}

export function state(input: AssessAccessInput): AccessState {
	const result = assessor(input);
	expect(assessAccessResult.safeParse(result).success).toBe(true);
	if (result.kind !== 'assessed' || result.assessment.kind !== 'fixed')
		throw new Error('Expected a fixed assessment');
	return result.assessment.state;
}
export const notUsable = (
	firstUnmet: Extract<AccessState, { kind: 'not-usable' }>['firstUnmet'],
): AccessState => ({ kind: 'not-usable', firstUnmet });
export const blocked = (
	source: 'profile-selector' | 'mcp-approval-policy' | 'cli-allowance' | 'account-policy',
): AccessState => ({ kind: 'blocked-by-policy', rule: { source, ruleId: 'run' } });

// Oracle: Program Design §1 at 7cb295d1. These competing conditions catch precedence inversions.
