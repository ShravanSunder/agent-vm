import {
	configuredCliAllowedCommandSchema,
	configuredCliArgvTokenSchema,
	configuredCliFlagNameSchema,
	configuredCliFlagRuleSchema,
	configuredCliInputSchema,
	configuredCliInvocationCallPolicySchema,
	configuredCliInvocationDispositionSchema,
	configuredCliInvocationFlagPredicateSchema,
	configuredCliInvocationMatcherSchema,
	configuredCliPatternRuleSchema,
	configuredCliPolicySchema,
	configuredCliStdinPolicySchema,
	configuredCliTimeoutPolicySchema,
	openConfiguredCliInputSchema,
	quickConfiguredCliInputSchema,
	resolveConfiguredCliTimeout,
	type ConfiguredCliAllowedCommand,
	type ConfiguredCliFlagRule,
	type ConfiguredCliInput,
	type ConfiguredCliInvocationCallPolicy,
	type ConfiguredCliInvocationDisposition,
	type ConfiguredCliInvocationFlagPredicate,
	type ConfiguredCliInvocationMatcher,
	type ConfiguredCliPatternRule,
	type ConfiguredCliPolicy,
	type ConfiguredCliStdinPolicy,
	type ConfiguredCliTimeoutPolicy,
} from '@agent-vm/config-contracts';

export const CliArgvTokenSchema = configuredCliArgvTokenSchema;
export const CliPatternRuleSchema = configuredCliPatternRuleSchema;
export const CliFlagNameSchema = configuredCliFlagNameSchema;
export const CliFlagRuleSchema = configuredCliFlagRuleSchema;
export const CliInvocationFlagPredicateSchema = configuredCliInvocationFlagPredicateSchema;
export const CliInvocationMatcherSchema = configuredCliInvocationMatcherSchema;
export const CliInvocationCallPolicySchema = configuredCliInvocationCallPolicySchema;
export const CliInvocationDispositionSchema = configuredCliInvocationDispositionSchema;
export const CliAllowedCommandSchema = configuredCliAllowedCommandSchema;
export const CliStdinPolicySchema = configuredCliStdinPolicySchema;
export const CliTimeoutPolicySchema = configuredCliTimeoutPolicySchema;
export const CliAllowanceSchema = configuredCliPolicySchema;
export const QuickCliAllowanceInputSchema = quickConfiguredCliInputSchema;
export const OpenCliAllowanceInputSchema = openConfiguredCliInputSchema;
export const CliAllowanceInputSchema = configuredCliInputSchema;

export type CliPatternRule = ConfiguredCliPatternRule;
export type CliFlagRule = ConfiguredCliFlagRule;
export type CliInvocationCallPolicy = ConfiguredCliInvocationCallPolicy;
export type CliInvocationDisposition = ConfiguredCliInvocationDisposition;
export type CliInvocationFlagPredicate = ConfiguredCliInvocationFlagPredicate;
export type CliInvocationMatcher = ConfiguredCliInvocationMatcher;
export type CliAllowedCommand = ConfiguredCliAllowedCommand;
export type CliStdinPolicy = ConfiguredCliStdinPolicy;
export type CliTimeoutPolicy = ConfiguredCliTimeoutPolicy;
export type CliAllowance = ConfiguredCliPolicy;
export type CliAllowanceInput = ConfiguredCliInput;
export type CliAllowanceBaseline = ConfiguredCliInvocationDisposition;

export type ResolvedCliAllowanceTimeout = ReturnType<typeof resolveConfiguredCliTimeout>;

export function resolveCliAllowanceTimeout(props: {
	readonly input: CliAllowanceInput;
	readonly kind: CliTimeoutPolicy['kind'];
}): ResolvedCliAllowanceTimeout {
	return resolveConfiguredCliTimeout(props);
}
