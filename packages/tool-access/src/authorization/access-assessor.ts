import type { GoogleAccountInvocationPolicyResult } from '@agent-vm/oauth-broker-contracts';

import {
	evaluateCliAllowanceInvocation,
	validateCliAllowanceInvocation,
} from '#tool-access/authorization/cli-allowances/index';
import {
	classifyCliPathContribution,
	cliPolicyHasConditionalMatchers,
	type CliPathContribution,
} from '#tool-access/authorization/cli-path-policy';
import { resolveCompiledGoogleCommand } from '#tool-access/authorization/compiled-google-command-resolution';
import { mcpPortalCallPolicyDecision } from '#tool-access/authorization/mcp-approval-policy';
import { toolPortalSelectorAllowsOperation } from '#tool-access/authorization/tool-selector-policy';
import {
	assessAccessInput,
	hostAccessBinding,
	openConfiguredCliInputSchema,
	quickConfiguredCliInputSchema,
	controllerConfiguredCliInputSchema,
	type AccessAssessment,
	type AccessNamespacePolicy,
	type AccessState,
	type AccountFact,
	type AssessAccessInput,
	type AssessAccessResult,
	type HostAccessBinding,
	type InputRevisions,
	type OperationClassRef,
	type PolicyRuleRef,
	type CompiledGoogleCommandSet,
	type ConfiguredCliPolicy,
} from '#tool-access/contracts/index';
import { resolvedMcpPortalProfileSchema } from '#tool-access/contracts/mcp-approval-profile';

export function assertNever(value: never): never {
	throw new Error(`Unhandled access variant: ${JSON.stringify(value)}`);
}

function rule(input: AssessAccessInput, source: PolicyRuleRef['source']): PolicyRuleRef {
	// The projection's record key names the capability policy; source names its rule family.
	return { source, ruleId: input.capability.tool };
}

function blocked(policyRule: PolicyRuleRef): AccessState {
	return { kind: 'blocked-by-policy', rule: policyRule };
}

function unmet(
	firstUnmet: Extract<AccessState, { kind: 'not-usable' }>['firstUnmet'],
): AccessState {
	return { kind: 'not-usable', firstUnmet };
}

function revisions(binding: HostAccessBinding, input: AssessAccessInput): InputRevisions {
	const facts = input.facts;
	return {
		hostConfig: binding.config,
		registration:
			facts.workspace.kind === 'configured' ? facts.workspace.registration.revision : null,
		workspaceAllowance:
			facts.workspace.kind === 'configured' ? facts.workspace.allowance.revision : null,
		profile: facts.assignment.profileRevision,
		assignment: facts.assignment.revision,
		surfaceSnapshot: facts.surface.snapshot,
		upstreamBinding: facts.upstream.binding,
		accounts: facts.accounts.map((fact) => ({
			account: fact.account,
			grant: fact.grantRevision,
			policy: fact.policyRevision,
			consent: fact.consentRevision,
		})),
	};
}

function namespaceFor(input: AssessAccessInput): AccessNamespacePolicy | undefined {
	const namespaces = input.facts.assignment.profile.namespaces;
	return Object.hasOwn(namespaces, input.capability.namespace)
		? namespaces[input.capability.namespace]
		: undefined;
}

function operationFor(
	input: AssessAccessInput,
	namespace: AccessNamespacePolicy,
): AccessNamespacePolicy['operations'][string] | undefined {
	return Object.hasOwn(namespace.operations, input.capability.tool)
		? namespace.operations[input.capability.tool]
		: undefined;
}

function earlyState(
	input: AssessAccessInput,
	namespace: AccessNamespacePolicy | undefined,
): AccessState | undefined {
	const { workspace, surface } = input.facts;
	if (workspace.kind === 'configured') {
		if (workspace.registration.status === 'revoked') return unmet('registration-revoked');
		if (!workspace.allowance.allowed) return unmet('not-allowed-in-workspace');
	}
	if (namespace === undefined || !surface.eligible.includes(input.surface))
		return unmet('not-given-to-agent');
	if (namespace.tools.allow !== '*' && !namespace.tools.allow.includes(input.capability.tool))
		return unmet('not-given-to-agent');
	if (namespace.backendKind !== 'mcp_provider' && operationFor(input, namespace) === undefined)
		return unmet('not-given-to-agent');
	if (!toolPortalSelectorAllowsOperation(namespace.tools, input.capability.tool))
		return blocked(rule(input, 'profile-selector'));
	return undefined;
}

function namespaceDecision(
	input: AssessAccessInput,
	namespace: AccessNamespacePolicy,
): 'allow_without_approval' | 'blocked' | 'requires_approval' {
	switch (namespace.calls.kind) {
		case 'account-policy':
			return 'allow_without_approval';
		case 'selectors':
			return mcpPortalCallPolicyDecision(
				resolvedMcpPortalProfileSchema.parse({
					enabledNamespaces: [input.capability.namespace],
					enabledToolsByNamespace: {},
					hiddenToolsByNamespace: {},
					logging: { enabled: false },
					promptContext: { enabled: false, maxNamespaces: 1 },
					cache: { catalogTtlMs: 1 },
					approval: {
						callPoliciesByNamespace: {
							[input.capability.namespace]: {
								requiresApproval: namespace.calls.requiresApproval,
								withoutApproval: namespace.calls.withoutApproval,
							},
						},
					},
				}),
				{ namespace: input.capability.namespace, toolName: input.capability.tool },
			).kind;
		default:
			return assertNever(namespace.calls);
	}
}

interface CallClassification {
	readonly deny: AccessState | null;
	readonly ask: boolean;
	readonly requirements: readonly Extract<OperationClassRef, { kind: 'google-effect' }>[];
	readonly accountRequired: boolean;
}

function classifyCall(
	input: AssessAccessInput,
	namespace: AccessNamespacePolicy,
): CallClassification {
	const baseline = namespaceDecision(input, namespace);
	const initial: CallClassification = {
		deny: baseline === 'blocked' ? blocked(rule(input, 'mcp-approval-policy')) : null,
		ask: baseline === 'requires_approval',
		requirements: [],
		accountRequired: namespace.calls.kind === 'account-policy',
	};
	if (initial.deny !== null || input.call === null) return initial;
	const operation = operationFor(input, namespace);
	if (operation?.cliPolicy === null || operation?.cliPolicy === undefined) return initial;
	const allowance = operation.cliPolicy;
	const google = operation.googleCommands !== null;
	const schema = google
		? controllerConfiguredCliInputSchema
		: allowance.timeout.kind === 'quick'
			? quickConfiguredCliInputSchema
			: openConfiguredCliInputSchema;
	const parsed = schema.safeParse(input.call.arguments);
	const denied: CallClassification = { ...initial, deny: blocked(rule(input, 'cli-allowance')) };
	if (!parsed.success) return denied;
	const validation = validateCliAllowanceInvocation({ allowance, input: parsed.data });
	if (!validation.ok || validation.matchedDenyRule) return denied;
	let classified = initial;
	if (!('source' in allowance.calls)) {
		const evaluated = evaluateCliAllowanceInvocation({
			allowance,
			input: parsed.data,
			baseline: initial.ask ? 'requires_approval' : 'without_approval',
		});
		if (!evaluated.ok || evaluated.disposition === 'deny') return denied;
		classified = { ...initial, ask: evaluated.disposition === 'requires_approval' };
	}
	if (!google) return 'source' in allowance.calls ? denied : classified;
	if (operation.googleCommands === null) return denied;
	const resolved = resolveCompiledGoogleCommand(operation.googleCommands, parsed.data.argv);
	switch (resolved.kind) {
		case 'denied':
			return denied;
		case 'no-oauth':
			return { ...classified, accountRequired: false };
		case 'oauth': {
			if (
				!('accountId' in parsed.data) ||
				parsed.data.accountId !== input.call.account?.oauthAccountId
			)
				return denied;
			return {
				...classified,
				accountRequired: true,
				requirements: resolved.requirements.flatMap((requirement) =>
					requirement.effects.map((effect) => ({
						kind: 'google-effect',
						serviceId: requirement.serviceId,
						effect,
					})),
				),
			};
		}
		default:
			return assertNever(resolved);
	}
}

function accountResults(
	account: AccountFact,
	requirements: CallClassification['requirements'],
): readonly (GoogleAccountInvocationPolicyResult | undefined)[] {
	return requirements.map(
		(requirement) =>
			account.decisions.find(
				(decision) =>
					decision.operationClass.serviceId === requirement.serviceId &&
					decision.operationClass.effect === requirement.effect,
			)?.result,
	);
}

function stateFor(props: {
	readonly input: AssessAccessInput;
	readonly classification: CallClassification;
	readonly account: AccountFact | undefined;
}): AccessState {
	const { input, classification, account } = props;
	if (classification.deny !== null) return classification.deny;
	const decisions =
		account === undefined ? [] : accountResults(account, classification.requirements);
	// Command denials precede grant and snapshot checks, even when the snapshot is applying.
	if (decisions.some((decision) => decision?.kind === 'denied' && decision.reason === 'command'))
		return blocked(rule(input, 'cli-allowance'));
	if (classification.accountRequired) {
		if (account === undefined || !account.granted) return unmet('account-not-granted');
		if (account.policySnapshotState === 'applying') return unmet('account-policy-paused');
		if (decisions.some((decision) => decision?.kind === 'denied'))
			return blocked(rule(input, 'account-policy'));
		if (account.availability.kind === 'denied') return blocked(rule(input, 'account-policy'));
		if (
			account.availability.kind === 'consent-required' ||
			decisions.some((decision) => decision?.kind === 'consent-required')
		)
			return unmet('consent-missing-or-expired');
		if (
			account.policySnapshotState === null ||
			account.availability.kind === 'unavailable' ||
			decisions.length === 0 ||
			decisions.some((decision) => decision === undefined || decision.kind === 'unavailable')
		)
			return unmet('service-unavailable');
	}
	if (
		input.facts.upstream.status === 'unavailable' ||
		input.facts.upstream.credentialNeed === 'unmet'
	)
		return unmet('service-unavailable');
	const ask =
		classification.ask ||
		(classification.accountRequired &&
			((account?.availability.kind === 'ready' && account.availability.disposition === 'ask') ||
				decisions.some(
					(decision) => decision?.kind === 'allowed' && decision.disposition === 'ask',
				)));
	return { kind: ask ? 'approval-each-call' : 'usable' };
}

type GoogleEffect = Extract<OperationClassRef, { kind: 'google-effect' }>;
type AccessEntry = Extract<AccessAssessment, { kind: 'call-dependent' }>['entries'][number];
interface GoogleCommandPath {
	readonly path: readonly string[];
	readonly requirements: readonly GoogleEffect[];
	readonly contribution: CliPathContribution;
}

function sameGoogleEffect(left: GoogleEffect, right: GoogleEffect): boolean {
	return left.serviceId === right.serviceId && left.effect === right.effect;
}

function googleCommandPaths(
	commands: CompiledGoogleCommandSet,
	cliPolicy: ConfiguredCliPolicy,
): readonly GoogleCommandPath[] {
	return commands.descriptors.flatMap((descriptor) =>
		descriptor.paths.map((path) => ({
			path,
			requirements: descriptor.requirements.flatMap((requirement) =>
				requirement.effects.map(
					(effect) =>
						({
							kind: 'google-effect',
							serviceId: requirement.serviceId,
							effect,
						}) satisfies GoogleEffect,
				),
			),
			contribution: classifyCliPathContribution(cliPolicy, path),
		})),
	);
}

function foldCliContribution(props: {
	readonly base: CallClassification;
	readonly contribution: CliPathContribution;
	readonly requirements: readonly GoogleEffect[];
	readonly input: AssessAccessInput;
}): CallClassification {
	const { base, contribution, requirements, input } = props;
	return {
		...base,
		accountRequired: true,
		requirements,
		deny: contribution === 'deny' ? blocked(rule(input, 'cli-allowance')) : base.deny,
		ask: base.ask || contribution === 'ask',
	};
}

function sameAccessState(left: AccessState, right: AccessState): boolean {
	switch (left.kind) {
		case 'usable':
		case 'approval-each-call':
			return right.kind === left.kind;
		case 'not-usable':
			return right.kind === left.kind && right.firstUnmet === left.firstUnmet;
		case 'blocked-by-policy':
			return (
				right.kind === left.kind &&
				right.rule.source === left.rule.source &&
				right.rule.ruleId === left.rule.ruleId
			);
		default:
			return assertNever(left);
	}
}

function googleExplainEntries(props: {
	readonly input: AssessAccessInput;
	readonly base: CallClassification;
	readonly commands: CompiledGoogleCommandSet;
	readonly cliPolicy: ConfiguredCliPolicy;
}): readonly AccessEntry[] {
	const { input, base } = props;
	const paths = googleCommandPaths(props.commands, props.cliPolicy);
	const requirements = paths.flatMap((command) => command.requirements);
	const unique = requirements.filter(
		(requirement, index) =>
			requirements.findIndex((other) => sameGoogleEffect(other, requirement)) === index,
	);
	const accounts = input.facts.accounts.length === 0 ? [undefined] : input.facts.accounts;
	// Every displayed state describes the complete path, including its other effects.
	const evaluatedAccounts = accounts.map((account) => ({
		account: account?.account ?? null,
		paths: paths.map((command) => ({
			command,
			state: stateFor({
				input,
				account,
				classification: foldCliContribution({
					base,
					contribution: command.contribution,
					requirements: command.requirements,
					input,
				}),
			}),
		})),
	}));
	const entries: AccessEntry[] = [];
	const splitPaths = new Set<string>();
	for (const operationClass of unique) {
		for (const evaluated of evaluatedAccounts) {
			const matching = evaluated.paths.filter(({ command }) =>
				command.requirements.some((requirement) => sameGoogleEffect(requirement, operationClass)),
			);
			const first = matching[0];
			if (first === undefined) continue;
			if (matching.every(({ state }) => sameAccessState(state, first.state))) {
				entries.push({ operationClass, account: evaluated.account, state: first.state });
			} else {
				for (const { command, state } of matching) {
					const pathAccountKey = JSON.stringify([command.path, evaluated.account]);
					if (splitPaths.has(pathAccountKey)) continue;
					splitPaths.add(pathAccountKey);
					entries.push({
						operationClass: { kind: 'cli-command', commandPath: command.path },
						account: evaluated.account,
						state,
					});
				}
			}
		}
	}
	for (const path of props.commands.noOAuthPaths) {
		const pathAccountKey = JSON.stringify([path, null]);
		if (splitPaths.has(pathAccountKey)) continue;
		splitPaths.add(pathAccountKey);
		entries.push({
			operationClass: { kind: 'cli-command', commandPath: path },
			account: null,
			state: stateFor({
				input,
				account: undefined,
				classification: {
					...foldCliContribution({
						base,
						input,
						contribution: classifyCliPathContribution(props.cliPolicy, path),
						requirements: [],
					}),
					accountRequired: false,
				},
			}),
		});
	}
	return entries;
}

function explain(
	input: AssessAccessInput,
	namespace: AccessNamespacePolicy,
	resultRevisions: InputRevisions,
): AccessAssessment {
	const operation = operationFor(input, namespace);
	const base = classifyCall(input, namespace);
	if (base.deny !== null)
		return { kind: 'fixed', surface: input.surface, revisions: resultRevisions, state: base.deny };
	if (operation?.cliPolicy === null || operation?.cliPolicy === undefined) {
		return {
			kind: 'fixed',
			surface: input.surface,
			revisions: resultRevisions,
			state: stateFor({ input, classification: base, account: undefined }),
		};
	}
	const entries: Extract<AccessAssessment, { kind: 'call-dependent' }>['entries'][number][] = [];
	if (operation.googleCommands !== null) {
		entries.push(
			...googleExplainEntries({
				input,
				base,
				commands: operation.googleCommands,
				cliPolicy: operation.cliPolicy,
			}),
		);
	} else {
		for (const command of operation.cliPolicy.commands) {
			// Path-wide rules are decidable without guessing flags or stdin. Conditional rules stay per-call.
			const pathInput: AssessAccessInput = {
				...input,
				call: {
					arguments: { argv: command.path, reason: 'Explain command path' },
					account: null,
					digest: '0'.repeat(64),
				},
			};
			entries.push({
				operationClass: { kind: 'cli-command', commandPath: command.path },
				account: null,
				state: stateFor({
					input,
					account: undefined,
					classification: classifyCall(pathInput, namespace),
				}),
			});
		}
	}
	return {
		kind: 'call-dependent',
		surface: input.surface,
		revisions: resultRevisions,
		entries,
		perCallRule: rule(
			input,
			operation.googleCommands === null || cliPolicyHasConditionalMatchers(operation.cliPolicy)
				? 'cli-allowance'
				: 'account-policy',
		),
	};
}

export function createAccessAssessor(
	bindingInput: HostAccessBinding,
): (input: AssessAccessInput) => AssessAccessResult {
	const binding = hostAccessBinding.parse(bindingInput);
	return function assessAccess(inputValue: AssessAccessInput): AssessAccessResult {
		const input = assessAccessInput.parse(inputValue);
		if (input.facts.workspace.kind !== binding.workspaceLayer)
			return { kind: 'facts-rejected', reason: 'workspace-layer-mismatch' };
		if (
			input.facts.accounts.some((account) => account.boundToCall !== (input.call?.digest ?? null))
		)
			return { kind: 'facts-rejected', reason: 'account-decision-unbound' };
		const resultRevisions = revisions(binding, input);
		const namespace = namespaceFor(input);
		const early = earlyState(input, namespace);
		if (early !== undefined)
			return {
				kind: 'assessed',
				assessment: {
					kind: 'fixed',
					surface: input.surface,
					revisions: resultRevisions,
					state: early,
				},
			};
		if (namespace === undefined)
			return {
				kind: 'assessed',
				assessment: {
					kind: 'fixed',
					surface: input.surface,
					revisions: resultRevisions,
					state: unmet('not-given-to-agent'),
				},
			};
		if (input.call === null)
			return { kind: 'assessed', assessment: explain(input, namespace, resultRevisions) };
		const classification = classifyCall(input, namespace);
		const account = input.facts.accounts.find(
			(fact) => fact.account.oauthAccountId === input.call?.account?.oauthAccountId,
		);
		return {
			kind: 'assessed',
			assessment: {
				kind: 'fixed',
				surface: input.surface,
				revisions: resultRevisions,
				state: stateFor({ input, classification, account }),
			},
		};
	};
}
