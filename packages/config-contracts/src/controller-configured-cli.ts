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

export const configuredCliFlagRuleSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('deny'),
			names: z.array(configuredCliFlagNameSchema).min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal('allowed_values'),
			names: z.array(configuredCliFlagNameSchema).min(1),
			values: z.array(configuredCliArgvTokenSchema).min(1),
		})
		.strict(),
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
		commands: z.array(configuredCliAllowedCommandSchema).min(1),
		deniedPatterns: z.array(configuredCliPatternRuleSchema).default([]),
		stdin: configuredCliStdinPolicySchema.default({ kind: 'none' }),
		timeout: configuredCliTimeoutPolicySchema,
	})
	.strict()
	.superRefine((policy, context) => {
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

export const configuredCliEnvironmentPolicySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('empty') }).strict(),
	z
		.object({
			kind: z.literal('inherit_allowlist'),
			names: z
				.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u))
				.min(1)
				.refine((names) => new Set(names).size === names.length, {
					message: 'Inherited environment names must be unique.',
				}),
		})
		.strict(),
]);

const absoluteControlFreePathSchema = z.string().startsWith('/').refine(isControlFreeText, {
	message: 'Configured CLI paths must not contain control characters.',
});

export const configuredCliExecutionTargetSchema = z.discriminatedUnion('kind', [
	z
		.object({
			cwd: absoluteControlFreePathSchema,
			environment: configuredCliEnvironmentPolicySchema,
			kind: z.literal('controller_host'),
		})
		.strict(),
	z
		.object({
			allowedHosts: z.array(z.string().min(1)).default([]),
			environment: configuredCliEnvironmentPolicySchema,
			guestCwd: absoluteControlFreePathSchema,
			imageReference: z.string().min(1),
			kind: z.literal('ephemeral_managed_vm'),
		})
		.strict(),
]);

export const configuredCliOutputPolicySchema = z
	.object({
		modelVisibleStderr: z.enum(['none', 'fixed_safe_summary']),
		overflow: z.enum(['fail', 'truncate']),
		stderrMaxBytes: z.number().int().positive().max(16_777_216),
		stdoutMaxBytes: z.number().int().positive().max(16_777_216),
	})
	.strict();

export const controllerRegisteredOperationSchema = z
	.object({ kind: z.literal('registered_action') })
	.strict();

export const controllerConfiguredCliOperationSchema = configuredCliPolicySchema
	.safeExtend({
		executablePath: absoluteControlFreePathSchema,
		executionTarget: configuredCliExecutionTargetSchema,
		kind: z.literal('configured_cli'),
		mandatoryArgvPrefix: z.array(configuredCliArgvTokenSchema).max(64),
		output: configuredCliOutputPolicySchema,
		safeHelp: z.string().min(1).max(4_000),
	})
	.strict();

export const controllerExecutionOperationSchema = z.discriminatedUnion('kind', [
	controllerRegisteredOperationSchema,
	controllerConfiguredCliOperationSchema,
]);

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

export type ConfiguredCliAllowedCommand = z.infer<typeof configuredCliAllowedCommandSchema>;
export type ConfiguredCliFlagRule = z.infer<typeof configuredCliFlagRuleSchema>;
export type ConfiguredCliInput = z.infer<typeof configuredCliInputSchema>;
export type ConfiguredCliPatternRule = z.infer<typeof configuredCliPatternRuleSchema>;
export type ConfiguredCliPolicy = z.infer<typeof configuredCliPolicySchema>;
export type ConfiguredCliStdinPolicy = z.infer<typeof configuredCliStdinPolicySchema>;
export type ConfiguredCliTimeoutPolicy = z.infer<typeof configuredCliTimeoutPolicySchema>;
export type ControllerExecutionOperation = z.infer<typeof controllerExecutionOperationSchema>;

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
	readonly input: ConfiguredCliInput;
	readonly kind: ConfiguredCliTimeoutPolicy['kind'];
}): ResolvedConfiguredCliTimeout {
	if (props.kind === 'quick') {
		quickConfiguredCliInputSchema.parse(props.input);
		return { kind: 'quick', requestedTimeoutMs: null, resolvedTimeoutMs: 5_000 };
	}
	const input = openConfiguredCliInputSchema.parse(props.input);
	return {
		kind: 'open',
		requestedTimeoutMs: input.timeoutMs ?? null,
		resolvedTimeoutMs: input.timeoutMs ?? 120_000,
	};
}

function isTokenPrefix(left: readonly string[], right: readonly string[]): boolean {
	return left.length <= right.length && left.every((token, index) => token === right[index]);
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
