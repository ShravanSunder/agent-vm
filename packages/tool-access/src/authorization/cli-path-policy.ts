import type { ConfiguredCliPolicy } from '../contracts/cli-allowance-policy.js';
import {
	evaluateCliAllowanceInvocation,
	validateCliAllowanceInvocation,
} from './cli-allowances/index.js';

export type CliPathContribution = 'deny' | 'ask' | 'none';

// Explain only the fixed path; argument, flag and stdin decisions remain explicitly per-call.
export function classifyCliPathContribution(
	policy: ConfiguredCliPolicy,
	path: readonly string[],
): CliPathContribution {
	const input = { argv: [...path], reason: 'Explain command path' };
	const validation = validateCliAllowanceInvocation({ allowance: policy, input });
	if (!validation.ok || validation.matchedDenyRule) return 'deny';
	if ('source' in policy.calls) return 'none';
	const evaluated = evaluateCliAllowanceInvocation({
		allowance: policy,
		input,
		baseline: 'without_approval',
	});
	if (!evaluated.ok || evaluated.disposition === 'deny') return 'deny';
	return evaluated.disposition === 'requires_approval' ? 'ask' : 'none';
}

export function cliPolicyHasConditionalMatchers(policy: ConfiguredCliPolicy): boolean {
	const matchers =
		'source' in policy.calls
			? policy.calls.deny
			: [...policy.calls.deny, ...policy.calls.requiresApproval];
	return (
		policy.deniedPatterns.length > 0 ||
		policy.stdin.kind !== 'none' ||
		policy.commands.some((command) => command.flagRules.length > 0) ||
		matchers.some((matcher) => matcher.flags.length > 0)
	);
}
