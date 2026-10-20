// Copied from agent-vm at 7cb295d1; existing packages remain unchanged until S4.
import { oauthAccountIdSchema } from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import { jsonObjectSchema } from './json-value.js';
export const configuredCliArgvTokenSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine(isControlFreeText, { message: 'CLI argv tokens must not contain control characters.' });

export const configuredCliPatternRuleSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('literal'), value: z.string().min(1) }).strict(),
	z.object({ kind: z.literal('regex'), value: z.string().min(1) }).strict(),
]);

export const configuredCliFlagNameSchema = z.string().regex(/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/u);

const uniqueConfiguredCliFlagNamesSchema = z
	.array(configuredCliFlagNameSchema)
	.min(1)
	.refine(hasUniqueStrings, { message: 'CLI flag names must be unique.' });

const uniqueConfiguredCliArgvTokensSchema = z
	.array(configuredCliArgvTokenSchema)
	.min(1)
	.refine(hasUniqueStrings, { message: 'CLI argv tokens must be unique.' });

export const configuredCliFlagRuleSchema = z
	.object({
		kind: z.literal('allowed_values'),
		names: uniqueConfiguredCliFlagNamesSchema,
		values: uniqueConfiguredCliArgvTokensSchema,
	})
	.strict();

export const configuredCliInvocationFlagPredicateSchema = z
	.object({
		names: uniqueConfiguredCliFlagNamesSchema,
		values: uniqueConfiguredCliArgvTokensSchema.optional(),
	})
	.strict();

export const configuredCliInvocationMatcherSchema = z
	.object({
		flags: z.array(configuredCliInvocationFlagPredicateSchema).default([]),
		path: z.array(configuredCliArgvTokenSchema).min(1).max(100),
	})
	.strict()
	.superRefine((matcher, context) => {
		const seenPredicateIdentities = new Set<string>();
		for (const [predicateIndex, predicate] of matcher.flags.entries()) {
			const identity = configuredCliFlagPredicateIdentity(predicate);
			if (seenPredicateIdentities.has(identity)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'CLI invocation matcher flag predicates must be semantically unique.',
					path: ['flags', predicateIndex],
				});
			}
			seenPredicateIdentities.add(identity);
		}
	});

export const configuredCliStaticInvocationCallPolicySchema = z
	.object({
		deny: z.array(configuredCliInvocationMatcherSchema).default([]),
		requiresApproval: z.array(configuredCliInvocationMatcherSchema).default([]),
		withoutApproval: z.literal('remaining_admitted'),
	})
	.strict()
	.superRefine((calls, context) => {
		for (const bucketName of ['deny', 'requiresApproval'] as const) {
			const seenMatcherIdentities = new Set<string>();
			for (const [matcherIndex, matcher] of calls[bucketName].entries()) {
				const identity = configuredCliInvocationMatcherIdentity(matcher);
				if (seenMatcherIdentities.has(identity)) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `CLI invocation ${bucketName} matchers must be semantically unique.`,
						path: [bucketName, matcherIndex],
					});
				}
				seenMatcherIdentities.add(identity);
			}
		}
	});

export const configuredCliManagedGoogleCallPolicySchema = z
	.object({
		source: z.literal('managed_google_policy'),
		deny: z.array(configuredCliInvocationMatcherSchema).default([]),
	})
	.strict()
	.refine(
		(policy) =>
			new Set(policy.deny.map(configuredCliInvocationMatcherIdentity)).size === policy.deny.length,
		{ message: 'CLI invocation deny matchers must be semantically unique.' },
	);

export const configuredCliInvocationCallPolicySchema = z.union([
	configuredCliStaticInvocationCallPolicySchema,
	configuredCliManagedGoogleCallPolicySchema,
]);

export const configuredCliInvocationDispositionSchema = z.enum([
	'deny',
	'requires_approval',
	'without_approval',
]);

export const configuredCliAllowedCommandSchema = z
	.object({
		flagRules: z.array(configuredCliFlagRuleSchema).default([]),
		path: z.array(configuredCliArgvTokenSchema).min(1).max(100),
	})
	.strict()
	.superRefine((command, context) => {
		const seenNames = new Set<string>();
		for (const [ruleIndex, rule] of command.flagRules.entries()) {
			for (const name of rule.names) {
				if (seenNames.has(name)) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: `CLI flag name "${name}" must appear in only one rule.`,
						path: ['flagRules', ruleIndex, 'names'],
					});
				}
				seenNames.add(name);
			}
		}
	});

export const configuredCliStdinPolicySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }).strict(),
	z
		.object({
			deniedPatterns: z.array(configuredCliPatternRuleSchema).default([]),
			kind: z.literal('bounded_text'),
			maxBytes: z.number().int().positive().max(1_048_576),
		})
		.strict(),
	z
		.object({
			kind: z.literal('json'),
			maxBytes: z.number().int().positive().max(1_048_576),
			schema: jsonObjectSchema,
		})
		.strict(),
]);

export const configuredCliTimeoutPolicySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('quick') }).strict(),
	z.object({ kind: z.literal('open') }).strict(),
]);

export const configuredCliPolicySchema = z
	.object({
		calls: configuredCliInvocationCallPolicySchema,
		commands: z.array(configuredCliAllowedCommandSchema).min(1),
		deniedPatterns: z.array(configuredCliPatternRuleSchema).default([]),
		stdin: configuredCliStdinPolicySchema.default({ kind: 'none' }),
		timeout: configuredCliTimeoutPolicySchema,
	})
	.strict()
	.superRefine((policy, context) => {
		const admittedPathIdentities = new Set(
			policy.commands.map((command) => configuredCliPathIdentity(command.path)),
		);
		const callBuckets =
			'source' in policy.calls
				? [['deny', policy.calls.deny] as const]
				: [
						['deny', policy.calls.deny] as const,
						['requiresApproval', policy.calls.requiresApproval] as const,
					];
		for (const [bucketName, matchers] of callBuckets) {
			for (const [matcherIndex, matcher] of matchers.entries()) {
				if (!admittedPathIdentities.has(configuredCliPathIdentity(matcher.path))) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'CLI invocation matcher path must exactly equal an admitted command path.',
						path: ['calls', bucketName, matcherIndex, 'path'],
					});
				}
			}
		}
		for (let leftIndex = 0; leftIndex < policy.commands.length; leftIndex += 1) {
			const leftPath = policy.commands[leftIndex]?.path;
			if (leftPath === undefined) continue;
			for (let rightIndex = leftIndex + 1; rightIndex < policy.commands.length; rightIndex += 1) {
				const rightPath = policy.commands[rightIndex]?.path;
				if (rightPath === undefined) continue;
				if (isTokenPrefix(leftPath, rightPath) || isTokenPrefix(rightPath, leftPath)) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'CLI command paths must be unique and must not overlap by proper prefix.',
						path: ['commands', rightIndex, 'path'],
					});
				}
			}
		}
		validateRegexPatterns(policy.deniedPatterns, ['deniedPatterns'], context);
		if (policy.stdin.kind === 'bounded_text') {
			validateRegexPatterns(policy.stdin.deniedPatterns, ['stdin', 'deniedPatterns'], context);
		}
	});

const configuredCliCommonInputShape = {
	argv: z.array(configuredCliArgvTokenSchema).min(1).max(100),
	reason: z.string().min(1).max(2_000),
	stdin: z.string().max(1_048_576).optional(),
} as const;

export const quickConfiguredCliInputSchema = z.object(configuredCliCommonInputShape).strict();
export const openConfiguredCliInputSchema = z
	.object({
		...configuredCliCommonInputShape,
		timeoutMs: z.number().int().positive().max(28_800_000).optional(),
	})
	.strict();

export const configuredCliInputSchema = z.union([
	quickConfiguredCliInputSchema,
	openConfiguredCliInputSchema,
]);

export const quickOAuthConfiguredCliInputSchema = z
	.object({
		...configuredCliCommonInputShape,
		accountId: oauthAccountIdSchema,
	})
	.strict();

export const openOAuthConfiguredCliInputSchema = z
	.object({
		...configuredCliCommonInputShape,
		accountId: oauthAccountIdSchema,
		timeoutMs: z.number().int().positive().max(28_800_000).optional(),
	})
	.strict();

export const oauthConfiguredCliInputSchema = z.union([
	quickOAuthConfiguredCliInputSchema,
	openOAuthConfiguredCliInputSchema,
]);

export const controllerConfiguredCliInputSchema = z.union([
	configuredCliInputSchema,
	oauthConfiguredCliInputSchema,
]);

export type ConfiguredCliAllowedCommand = z.infer<typeof configuredCliAllowedCommandSchema>;
export type ConfiguredCliFlagRule = z.infer<typeof configuredCliFlagRuleSchema>;
export type ConfiguredCliInput = z.infer<typeof configuredCliInputSchema>;
export type ControllerConfiguredCliInput = z.infer<typeof controllerConfiguredCliInputSchema>;
export type ConfiguredCliInvocationCallPolicy = z.infer<
	typeof configuredCliInvocationCallPolicySchema
>;
export type ConfiguredCliInvocationDisposition = z.infer<
	typeof configuredCliInvocationDispositionSchema
>;
export type ConfiguredCliInvocationFlagPredicate = z.infer<
	typeof configuredCliInvocationFlagPredicateSchema
>;
export type ConfiguredCliInvocationMatcher = z.infer<typeof configuredCliInvocationMatcherSchema>;
export type ConfiguredCliPatternRule = z.infer<typeof configuredCliPatternRuleSchema>;
export type ConfiguredCliPolicy = z.infer<typeof configuredCliPolicySchema>;
export type ConfiguredCliStdinPolicy = z.infer<typeof configuredCliStdinPolicySchema>;
export type ConfiguredCliTimeoutPolicy = z.infer<typeof configuredCliTimeoutPolicySchema>;
export type ResolvedConfiguredCliTimeout =
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

export function resolveConfiguredCliTimeout(props: {
	readonly input: ControllerConfiguredCliInput;
	readonly kind: ConfiguredCliTimeoutPolicy['kind'];
}): ResolvedConfiguredCliTimeout {
	if (props.kind === 'quick') {
		controllerConfiguredCliInputSchema.parse(props.input);
		return { kind: 'quick', requestedTimeoutMs: null, resolvedTimeoutMs: 5_000 };
	}
	const input = controllerConfiguredCliInputSchema.parse(props.input);
	const requestedTimeoutMs = 'timeoutMs' in input ? (input.timeoutMs ?? null) : null;
	return {
		kind: 'open',
		requestedTimeoutMs,
		resolvedTimeoutMs: requestedTimeoutMs ?? 120_000,
	};
}

function isTokenPrefix(left: readonly string[], right: readonly string[]): boolean {
	return left.length <= right.length && left.every((token, index) => token === right[index]);
}

function hasUniqueStrings(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function configuredCliPathIdentity(pathTokens: readonly string[]): string {
	return JSON.stringify(pathTokens);
}

function configuredCliFlagPredicateIdentity(
	predicate: z.infer<typeof configuredCliInvocationFlagPredicateSchema>,
): string {
	return JSON.stringify({
		names: predicate.names.toSorted(),
		...(predicate.values === undefined ? {} : { values: predicate.values.toSorted() }),
	});
}

function configuredCliInvocationMatcherIdentity(
	matcher: z.infer<typeof configuredCliInvocationMatcherSchema>,
): string {
	return JSON.stringify({
		flags: matcher.flags.map(configuredCliFlagPredicateIdentity).toSorted(),
		path: matcher.path,
	});
}

function validateRegexPatterns(
	patterns: readonly ConfiguredCliPatternRule[],
	basePath: readonly (number | string)[],
	context: z.RefinementCtx,
): void {
	for (const [patternIndex, pattern] of patterns.entries()) {
		if (pattern.kind !== 'regex') continue;
		try {
			const compiledPattern = new RegExp(pattern.value, 'u');
			void compiledPattern;
		} catch {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'CLI denied regex patterns must compile.',
				path: [...basePath, patternIndex, 'value'],
			});
		}
	}
}

function isControlFreeText(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			return false;
		}
	}
	return true;
}
