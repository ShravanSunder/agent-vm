import type { ToolVmCliAdvisoryHints } from '@agent-vm/config-contracts';
import { z } from 'zod/v4';

import type {
	CliAllowedCommand,
	CliAllowance,
	CliAllowanceBaseline,
	CliAllowanceInput,
	CliFlagRule,
	CliInvocationDisposition,
	CliInvocationFlagPredicate,
	CliInvocationMatcher,
	CliPatternRule,
} from './models/cli-allowance-schema.js';

export type CliAllowanceEvaluationResult =
	| {
			readonly disposition: 'deny';
			readonly error: {
				readonly code: string;
				readonly message: string;
			};
			readonly kind: 'denied';
			readonly ok: false;
	  }
	| {
			readonly argv: readonly string[];
			readonly disposition: CliInvocationDisposition;
			readonly kind: 'admitted';
			readonly matchedCommandPath: readonly string[];
			readonly matchedDenyRule: boolean;
			readonly matchedRequiresApprovalRule: boolean;
			readonly ok: true;
	  };

export interface EvaluateCliAllowanceInvocationProps {
	readonly allowance: CliAllowance;
	readonly baseline: CliAllowanceBaseline;
	readonly input: CliAllowanceInput;
}

export type ToolVmCliAdvisoryDisposition =
	| 'hint-deny'
	| 'hint-requires-approval'
	| 'without-approval';

export function evaluateToolVmCliAdvisoryHints(props: {
	readonly argv: readonly string[];
	readonly hints: ToolVmCliAdvisoryHints | undefined;
}): ToolVmCliAdvisoryDisposition {
	if (
		props.hints?.hintDeny.some((matcher) =>
			configuredCliInvocationMatcherApplies({ argv: props.argv, matcher }),
		) === true
	) {
		return 'hint-deny';
	}
	if (
		props.hints?.hintRequiresApproval.some((matcher) =>
			configuredCliInvocationMatcherApplies({ argv: props.argv, matcher }),
		) === true
	) {
		return 'hint-requires-approval';
	}
	return 'without-approval';
}

interface CliFlagOccurrence {
	readonly inlineValue?: string;
	readonly name: string;
	readonly separatedValue?: string;
}

export function evaluateCliAllowanceInvocation(
	props: EvaluateCliAllowanceInvocationProps,
): CliAllowanceEvaluationResult {
	const command = findMatchingCommand(props.allowance.commands, props.input.argv);
	if (command === undefined) {
		return deniedCliAllowance('CLI argv does not match an allowed command path.');
	}

	const deniedArgumentPattern = firstMatchingPattern(
		props.allowance.deniedPatterns,
		props.input.argv,
	);
	if (deniedArgumentPattern !== undefined) {
		return deniedCliAllowance(
			`CLI argv matched denied ${deniedArgumentPattern.kind} pattern "${deniedArgumentPattern.value}".`,
		);
	}

	const argvTail = props.input.argv.slice(command.path.length);
	const flagOccurrences = deriveFlagOccurrences(argvTail);
	const flagValidation = validateFlagRules({ flagOccurrences, flagRules: command.flagRules });
	if (flagValidation !== undefined) return flagValidation;

	const stdinValidation = validateStdin(props.allowance, props.input.stdin);
	if (stdinValidation !== undefined) return stdinValidation;

	const matchedDenyRule = props.allowance.calls.deny.some((matcher) =>
		configuredCliInvocationMatcherApplies({ argv: props.input.argv, matcher }),
	);
	const matchedRequiresApprovalRule = props.allowance.calls.requiresApproval.some((matcher) =>
		configuredCliInvocationMatcherApplies({ argv: props.input.argv, matcher }),
	);
	const disposition = strongestDisposition({
		baseline: props.baseline,
		matchedDenyRule,
		matchedRequiresApprovalRule,
	});

	return {
		argv: props.input.argv,
		disposition,
		kind: 'admitted',
		matchedCommandPath: command.path,
		matchedDenyRule,
		matchedRequiresApprovalRule,
		ok: true,
	};
}

function deniedCliAllowance(message: string): CliAllowanceEvaluationResult {
	return {
		disposition: 'deny',
		error: { code: 'cli_allowance_denied', message },
		kind: 'denied',
		ok: false,
	};
}

function findMatchingCommand(
	commands: readonly CliAllowedCommand[],
	argv: readonly string[],
): CliAllowedCommand | undefined {
	return commands.find((command) =>
		command.path.every((token, tokenIndex) => argv[tokenIndex] === token),
	);
}

function firstMatchingPattern(
	patterns: readonly CliPatternRule[],
	values: readonly string[],
): CliPatternRule | undefined {
	return patterns.find((pattern) =>
		values.some((value) =>
			pattern.kind === 'literal'
				? value.includes(pattern.value)
				: new RegExp(pattern.value, 'u').test(value),
		),
	);
}

function deriveFlagOccurrences(argvTail: readonly string[]): readonly CliFlagOccurrence[] {
	const occurrences: CliFlagOccurrence[] = [];
	for (const [tokenIndex, token] of argvTail.entries()) {
		if (token === '--' || !token.startsWith('-')) continue;
		const parsedFlag = parseFlagToken(token);
		const separatedValue = argvTail[tokenIndex + 1];
		occurrences.push({
			...(parsedFlag.inlineValue === undefined
				? separatedValue === undefined
					? {}
					: { separatedValue }
				: { inlineValue: parsedFlag.inlineValue }),
			name: parsedFlag.name,
		});
	}
	return occurrences;
}

function validateFlagRules(props: {
	readonly flagOccurrences: readonly CliFlagOccurrence[];
	readonly flagRules: readonly CliFlagRule[];
}): CliAllowanceEvaluationResult | undefined {
	for (const occurrence of props.flagOccurrences) {
		const matchingRule = props.flagRules.find((rule) => rule.names.includes(occurrence.name));
		if (matchingRule === undefined) continue;
		const value = occurrence.inlineValue ?? occurrence.separatedValue;
		if (value === undefined || !matchingRule.values.includes(value)) {
			return deniedCliAllowance(
				`CLI argv flag "${occurrence.name}" requires one configured allowed value.`,
			);
		}
	}
	return undefined;
}

export function configuredCliInvocationMatcherApplies(props: {
	readonly argv: readonly string[];
	readonly matcher: CliInvocationMatcher;
}): boolean {
	if (!isTokenPrefix(props.matcher.path, props.argv)) return false;
	const flagOccurrences = deriveFlagOccurrences(props.argv.slice(props.matcher.path.length));
	return props.matcher.flags.every((predicate) => flagPredicateApplies(predicate, flagOccurrences));
}

function flagPredicateApplies(
	predicate: CliInvocationFlagPredicate,
	flagOccurrences: readonly CliFlagOccurrence[],
): boolean {
	return flagOccurrences.some((occurrence) => {
		if (!predicate.names.includes(occurrence.name)) return false;
		if (predicate.values === undefined) return true;
		const value = occurrence.inlineValue ?? occurrence.separatedValue;
		return value !== undefined && predicate.values.includes(value);
	});
}

function strongestDisposition(props: {
	readonly baseline: CliAllowanceBaseline;
	readonly matchedDenyRule: boolean;
	readonly matchedRequiresApprovalRule: boolean;
}): CliInvocationDisposition {
	if (props.baseline === 'deny' || props.matchedDenyRule) return 'deny';
	if (props.baseline === 'requires_approval' || props.matchedRequiresApprovalRule) {
		return 'requires_approval';
	}
	return 'without_approval';
}

function isTokenPrefix(prefix: readonly string[], value: readonly string[]): boolean {
	return prefix.length <= value.length && prefix.every((token, index) => token === value[index]);
}

function parseFlagToken(token: string): {
	readonly inlineValue?: string;
	readonly name: string;
} {
	const separatorIndex = token.indexOf('=');
	if (separatorIndex === -1) return { name: token };
	return {
		inlineValue: token.slice(separatorIndex + 1),
		name: token.slice(0, separatorIndex),
	};
}

function validateStdin(
	allowance: CliAllowance,
	stdin: string | undefined,
): CliAllowanceEvaluationResult | undefined {
	if (allowance.stdin.kind === 'none') {
		return stdin === undefined
			? undefined
			: deniedCliAllowance('CLI stdin is not enabled for this operation.');
	}
	if (stdin === undefined) return undefined;
	if (new TextEncoder().encode(stdin).byteLength > allowance.stdin.maxBytes) {
		return deniedCliAllowance('CLI stdin exceeds the configured byte limit.');
	}
	if (allowance.stdin.kind === 'bounded_text') {
		const deniedStdinPattern = firstMatchingPattern(allowance.stdin.deniedPatterns, [stdin]);
		return deniedStdinPattern === undefined
			? undefined
			: deniedCliAllowance(
					`CLI stdin matched denied ${deniedStdinPattern.kind} pattern "${deniedStdinPattern.value}".`,
				);
	}
	try {
		const parsedJson: unknown = JSON.parse(stdin);
		return z.fromJSONSchema(allowance.stdin.schema).safeParse(parsedJson).success
			? undefined
			: deniedCliAllowance('CLI stdin does not match its configured JSON schema.');
	} catch {
		return deniedCliAllowance('CLI stdin must contain valid JSON.');
	}
}
