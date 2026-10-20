import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	jsonObjectSchema,
	accessFacts,
	type AssessAccessInput,
	type AccessState,
} from '@agent-collaboration/tool-access/contracts';
import {
	gatewayRuntimeManagedToolPortalConfigSchema,
	type GatewayRuntimeManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import { projectManagedAccessProfile } from '@agent-vm/gateway-runtime/managed-tool-engine/access-profile-projection.js';
import { compositionToolPortalConfig } from '@agent-vm/gateway-runtime/managed-tool-engine/composition-profile-test-fixture.js';
import {
	toolPortalConfig,
	semanticSnapshot,
} from '@agent-vm/gateway-runtime/managed-tool-engine/managed-profile-test-fixture.js';
import {
	createPreparedCliConfig,
	createPreparedGoogleConfig,
} from '@agent-vm/gateway-runtime/managed-tool-engine/prepared-policy-test-fixture.js';
import { callPolicyDecision } from '@agent-vm/tool-portal/policy-comparison';
import { describe, expect, it } from 'vitest';

const revision = { owner: 'controller', revision: 'policy:7' };
const digest = 'a'.repeat(64);
const accountId = '10000000-0000-4000-8000-000000000001';
const assess = createAccessAssessor({ workspaceLayer: 'not-configured', config: revision });
function input(props: {
	readonly config: GatewayRuntimeManagedToolPortalConfig;
	readonly profile: string;
	readonly namespace: string;
	readonly tool: string;
	readonly arguments: Record<string, unknown>;
	readonly surface?: 'mcp' | 'protected_uds';
}): AssessAccessInput {
	return assessAccessInput.parse({
		capability: { namespace: props.namespace, tool: props.tool },
		surface: props.surface ?? 'protected_uds',
		call: {
			arguments: props.arguments,
			account:
				typeof props.arguments.accountId === 'string'
					? { oauthAccountId: props.arguments.accountId }
					: null,
			digest,
		},
		facts: {
			workspace: { kind: 'not-configured' },
			assignment: {
				profile: projectManagedAccessProfile({ config: props.config, profileId: props.profile }),
				profileRevision: revision,
				revision,
			},
			surface: { eligible: ['protected_uds'], snapshot: revision },
			accounts: [],
			upstream: { status: 'available', credentialNeed: 'none', binding: revision },
		},
	});
}
function state(subject: AssessAccessInput): AccessState {
	const result = assess(subject);
	if (result.kind !== 'assessed' || result.assessment.kind !== 'fixed')
		throw new Error('Expected fixed assessment.');
	return result.assessment.state;
}
function compare(
	config: GatewayRuntimeManagedToolPortalConfig,
	subject: AssessAccessInput,
	expectedOld: string,
	expectedNew: string,
): void {
	if (subject.call === null) throw new Error('Expected call.');
	const profileId = subject.facts.assignment.profile.profileId;
	const old = callPolicyDecision({
		config,
		profileId,
		call: {
			id: 'parity',
			namespace: subject.capability.namespace,
			name: subject.capability.tool,
			arguments: jsonObjectSchema.parse(subject.call.arguments),
		},
		semanticSnapshot: {
			surfaceEligibilityByProfile: {
				[profileId]: { [subject.capability.namespace]: subject.facts.surface.eligible },
			},
		},
		surfaceClass: subject.surface,
	});
	// Two independent literal assertions accompany the old/new comparison.
	const projected = state(subject);
	expect(old.kind).toBe(expectedOld);
	expect(projected.kind).toBe(expectedNew);
	if (old.kind !== 'managed-google')
		expect(
			projected.kind === 'usable'
				? 'without-approval'
				: projected.kind === 'approval-each-call'
					? 'requires-approval'
					: 'denied',
		).toBe(old.kind);
}

describe('prepared managed policy projection parity', () => {
	it.each([
		['github', 'get_issue', 'without-approval', 'usable'],
		['github', 'backend_error', 'without-approval', 'usable'],
		['github', 'create_issue', 'requires-approval', 'approval-each-call'],
		['private_github', 'private_probe', 'without-approval', 'usable'],
		['github', 'hidden_probe', 'denied', 'not-usable'],
	] as const)(
		'keeps the original composition policy for %s/%s',
		(namespace, tool, expectedOld, expectedNew) => {
			compare(
				compositionToolPortalConfig,
				input({
					config: compositionToolPortalConfig,
					profile: 'code-builder',
					namespace,
					tool,
					arguments: {},
				}),
				expectedOld,
				expectedNew,
			);
		},
	);
	it.each([
		{ argv: ['drive', 'ls'], old: 'without-approval', next: 'usable' },
		{
			argv: ['drive', 'delete', 'file-1', '--permanent'],
			old: 'requires-approval',
			next: 'approval-each-call',
		},
		{
			argv: ['drive', 'delete', 'file-1', '--permanent', '--force'],
			old: 'denied',
			next: 'blocked-by-policy',
		},
		{ argv: ['mail', 'send'], old: 'denied', next: 'blocked-by-policy' },
	])('preserves prepared CLI command/call policy $argv', ({ argv, old, next }) => {
		const config = createPreparedCliConfig();
		compare(
			config,
			input({
				config,
				profile: 'profile',
				namespace: 'google',
				tool: 'gog',
				arguments: { argv, reason: 'parity' },
			}),
			old,
			next,
		);
	});
	it.each(['flag', 'pattern', 'stdin', 'quick-timeout', 'open-timeout', 'deny-selector'] as const)(
		'keeps the same-path %s decision',
		(scenario) => {
			const config = gatewayRuntimeManagedToolPortalConfigSchema.parse(createPreparedCliConfig());
			const policy = config.profiles.profile?.namespaces.google;
			if (policy?.backend.kind !== 'controller_execution')
				throw new Error('Expected controller policy.');
			const operation = policy.backend.operations.gog;
			if (operation?.kind !== 'configured_cli') throw new Error('Expected CLI.');
			let args: Record<string, unknown> = { argv: ['drive', 'ls'], reason: 'parity' };
			if (scenario === 'flag') {
				const command = operation.commands.find(
					(candidate) => candidate.path.join(' ') === 'drive ls',
				);
				if (command === undefined) throw new Error('Missing command');
				command.flagRules = [{ kind: 'allowed_values', names: ['--format'], values: ['json'] }];
				args = { ...args, argv: ['drive', 'ls', '--format', 'text'] };
			}
			if (scenario === 'pattern') {
				operation.deniedPatterns = [{ kind: 'literal', value: 'forbidden' }];
				args = { ...args, argv: ['drive', 'ls', 'forbidden'] };
			}
			if (scenario === 'stdin') args = { ...args, stdin: 'not admitted' };
			if (scenario === 'quick-timeout' || scenario === 'open-timeout')
				args = { ...args, timeoutMs: 10000 };
			if (scenario === 'open-timeout') operation.timeout = { kind: 'open' };
			if (scenario === 'deny-selector') policy.tools = { allow: ['gog'], deny: ['gog'] };
			compare(
				config,
				input({ config, profile: 'profile', namespace: 'google', tool: 'gog', arguments: args }),
				scenario === 'open-timeout' ? 'without-approval' : 'denied',
				scenario === 'open-timeout' ? 'usable' : 'blocked-by-policy',
			);
		},
	);
	it.each(['mcp', 'protected_uds'] as const)(
		'pins real managed paired-surface decisions and revision provenance on %s',
		(surface) => {
			const subject = input({
				config: toolPortalConfig,
				profile: 'gate-c-profile',
				namespace: 'github',
				tool: 'get_issue',
				arguments: {},
				surface,
			});
			subject.facts.surface.eligible =
				semanticSnapshot.surfaceEligibilityByProfile['gate-c-profile'].github;
			compare(
				toolPortalConfig,
				subject,
				surface === 'mcp' ? 'denied' : 'without-approval',
				surface === 'mcp' ? 'not-usable' : 'usable',
			);
			expect(assess(subject)).toMatchObject({
				kind: 'assessed',
				assessment: {
					surface,
					revisions: {
						hostConfig: revision,
						profile: revision,
						assignment: revision,
						surfaceSnapshot: revision,
						upstreamBinding: revision,
					},
				},
			});
		},
	);
	it('retains Google classification before account evaluation and denies unlisted help', () => {
		const config = createPreparedGoogleConfig();
		compare(
			config,
			input({
				config,
				profile: 'shared',
				namespace: 'gog',
				tool: 'gog_cli',
				arguments: { argv: ['gmail', 'search', 'query'], reason: 'parity', accountId },
			}),
			'managed-google',
			'not-usable',
		);
		compare(
			config,
			input({
				config,
				profile: 'shared',
				namespace: 'gog',
				tool: 'gog_cli',
				arguments: { argv: ['--help'], reason: 'parity' },
			}),
			'denied',
			'blocked-by-policy',
		);
		compare(
			config,
			input({
				config,
				profile: 'shared',
				namespace: 'gog',
				tool: 'gog_cli',
				arguments: { argv: ['gmail', 'delete'], reason: 'parity', accountId },
			}),
			'denied',
			'blocked-by-policy',
		);
	});
	it.each(['allow', 'ask', 'deny', 'applying', 'unavailable'] as const)(
		'uses account authority facts for final %s state',
		(disposition) => {
			const config = createPreparedGoogleConfig();
			const subject = input({
				config,
				profile: 'shared',
				namespace: 'gog',
				tool: 'gog_cli',
				arguments: { argv: ['gmail', 'search', 'query'], reason: 'parity', accountId },
			});
			subject.facts.accounts = accessFacts.shape.accounts.parse([
				{
					account: { oauthAccountId: accountId },
					granted: true,
					grantRevision: revision,
					policySnapshotState: disposition === 'applying' ? 'applying' : 'active',
					policyRevision: revision,
					consentRevision: revision,
					availability: {
						kind: 'ready',
						disposition: 'allow',
						overrideRevision: 1,
						defaultsRevision: 'defaults:1',
					},
					boundToCall: digest,
					decisions: [
						{
							operationClass: { kind: 'google-effect', serviceId: 'gmail', effect: 'read' },
							result:
								disposition === 'deny'
									? { kind: 'denied', reason: 'policy' }
									: disposition === 'unavailable' || disposition === 'applying'
										? { kind: 'unavailable' }
										: { kind: 'allowed', disposition, overrideRevision: 1 },
						},
					],
				},
			]);
			const expected: AccessState =
				disposition === 'allow'
					? { kind: 'usable' }
					: disposition === 'ask'
						? { kind: 'approval-each-call' }
						: disposition === 'deny'
							? { kind: 'blocked-by-policy', rule: { source: 'account-policy', ruleId: 'gog_cli' } }
							: {
									kind: 'not-usable',
									firstUnmet:
										disposition === 'applying' ? 'account-policy-paused' : 'service-unavailable',
								};
			expect(state(subject)).toEqual(expected);
		},
	);
});
