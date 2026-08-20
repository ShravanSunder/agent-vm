import {
	configuredCliAllowedCommandSchema,
	configuredCliArgvTokenSchema,
	configuredCliFlagNameSchema,
	configuredCliFlagRuleSchema,
	configuredCliInputSchema,
	configuredCliPatternRuleSchema,
	configuredCliPolicySchema,
	configuredCliStdinPolicySchema,
	configuredCliTimeoutPolicySchema,
	openConfiguredCliInputSchema,
	quickConfiguredCliInputSchema,
	type ConfiguredCliAllowedCommand,
	type ConfiguredCliFlagRule,
	type ConfiguredCliInput,
	type ConfiguredCliPatternRule,
	type ConfiguredCliPolicy,
	type ConfiguredCliStdinPolicy,
	type ConfiguredCliTimeoutPolicy,
} from '@agent-vm/config-contracts';

export const CliArgvTokenSchema = configuredCliArgvTokenSchema;
export const CliPatternRuleSchema = configuredCliPatternRuleSchema;
export const CliFlagNameSchema = configuredCliFlagNameSchema;
export const CliFlagRuleSchema = configuredCliFlagRuleSchema;
export const CliAllowedCommandSchema = configuredCliAllowedCommandSchema;
export const CliStdinPolicySchema = configuredCliStdinPolicySchema;
export const CliTimeoutPolicySchema = configuredCliTimeoutPolicySchema;
export const CliAllowanceSchema = configuredCliPolicySchema;
export const QuickCliAllowanceInputSchema = quickConfiguredCliInputSchema;
export const OpenCliAllowanceInputSchema = openConfiguredCliInputSchema;
export const CliAllowanceInputSchema = configuredCliInputSchema;

export type CliPatternRule = ConfiguredCliPatternRule;
export type CliFlagRule = ConfiguredCliFlagRule;
export type CliAllowedCommand = ConfiguredCliAllowedCommand;
export type CliStdinPolicy = ConfiguredCliStdinPolicy;
export type CliTimeoutPolicy = ConfiguredCliTimeoutPolicy;
export type CliAllowance = ConfiguredCliPolicy;
export type CliAllowanceInput = ConfiguredCliInput;

export type ResolvedCliAllowanceTimeout =
	| {
			readonly kind: 'quick';
			readonly requestedTimeoutMs: null;
			readonly resolvedTimeoutMs: 5_000;
	  }
	| {
			readonly kind: 'open';
			readonly requestedTimeoutMs: number | null;
			readonly resolvedTimeoutMs: number;
	  };

export function resolveCliAllowanceTimeout(props: {
	readonly input: CliAllowanceInput;
	readonly kind: CliTimeoutPolicy['kind'];
}): ResolvedCliAllowanceTimeout {
	if (props.kind === 'quick') {
		QuickCliAllowanceInputSchema.parse(props.input);
		return { kind: 'quick', requestedTimeoutMs: null, resolvedTimeoutMs: 5_000 };
	}
	const input = OpenCliAllowanceInputSchema.parse(props.input);
	return {
		kind: 'open',
		requestedTimeoutMs: input.timeoutMs ?? null,
		resolvedTimeoutMs: input.timeoutMs ?? 120_000,
	};
}
