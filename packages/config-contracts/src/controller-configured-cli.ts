import { z } from 'zod';

import { jsonObjectSchema } from './json-value.js';
import { secretValueSchema } from './secret-value.js';

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

export const configuredCliInvocationCallPolicySchema = z
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
		for (const bucketName of ['deny', 'requiresApproval'] as const) {
			for (const [matcherIndex, matcher] of policy.calls[bucketName].entries()) {
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

export const configuredCliCredentialLogicalNameSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);

export const configuredCliCredentialRelativePathSchema = z
	.string()
	.min(1)
	.refine((value) => Buffer.byteLength(value, 'utf8') <= 256, {
		message: 'Configured CLI credential paths must be at most 256 UTF-8 bytes.',
	})
	.refine(
		(value) => {
			if (value.startsWith('/') || value.includes('\\') || !isControlFreeText(value)) return false;
			const segments = value.split('/');
			return segments.every(
				(segment) =>
					segment !== '.' && segment !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(segment),
			);
		},
		{
			message: 'Configured CLI credential paths must be canonical safe relative paths.',
		},
	);

export const configuredCliCredentialFileMappingSchema = z
	.object({
		path: configuredCliCredentialRelativePathSchema,
		source: configuredCliCredentialLogicalNameSchema,
	})
	.strict();

export const configuredCliCredentialEnvironmentValueSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('credential_root') }).strict(),
	z
		.object({
			kind: z.literal('credential_file'),
			source: configuredCliCredentialLogicalNameSchema,
		})
		.strict(),
]);

const configuredCliCredentialEnvironmentSchema = z
	.record(
		z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
		configuredCliCredentialEnvironmentValueSchema,
	)
	.refine((environment) => Object.keys(environment).length > 0, {
		message: 'Configured CLI credential environment must not be empty.',
	})
	.refine((environment) => Object.keys(environment).length <= 16, {
		message: 'Configured CLI credential environment must contain at most 16 entries.',
	});

const configuredCliCredentialFilesSchema = z
	.array(configuredCliCredentialFileMappingSchema)
	.min(1)
	.max(16);

const configuredCliMediatedCredentialSourceSchema = z
	.object({
		hosts: z.array(z.string().min(1)).min(1),
		secret: secretValueSchema,
	})
	.strict();

const configuredCliMediatedCredentialEnvironmentSchema = z
	.record(
		z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
		configuredCliMediatedCredentialSourceSchema,
	)
	.refine((environment) => Object.keys(environment).length > 0, {
		message: 'Configured CLI mediated credential environment must not be empty.',
	})
	.refine((environment) => Object.keys(environment).length <= 16, {
		message: 'Configured CLI mediated credential environment must contain at most 16 entries.',
	});

const configuredCliFileCredentialProjectionSchema = z
	.object({
		credentialBinding: configuredCliCredentialLogicalNameSchema,
		credentialEnvironment: configuredCliCredentialEnvironmentSchema,
		credentialFiles: configuredCliCredentialFilesSchema,
		kind: z.literal('file_binding'),
	})
	.strict();

const configuredCliHttpMediationCredentialProjectionSchema = z
	.object({
		environment: configuredCliMediatedCredentialEnvironmentSchema,
		kind: z.literal('http_mediation'),
	})
	.strict();

export const configuredCliCredentialProjectionSchema = z.discriminatedUnion('kind', [
	configuredCliFileCredentialProjectionSchema,
	configuredCliHttpMediationCredentialProjectionSchema,
]);

interface CredentialedManagedVmTargetForValidation {
	readonly allowedHosts: readonly string[];
	readonly credentialProjection: z.infer<typeof configuredCliCredentialProjectionSchema>;
	readonly environment: z.infer<typeof configuredCliEnvironmentPolicySchema>;
}

interface FileCredentialProjectionForValidation {
	readonly credentialEnvironment: Readonly<
		Record<string, z.infer<typeof configuredCliCredentialEnvironmentValueSchema>>
	>;
	readonly credentialFiles: readonly z.infer<typeof configuredCliCredentialFileMappingSchema>[];
}

function validateFileCredentialProjection(
	projection: FileCredentialProjectionForValidation,
	context: z.RefinementCtx,
): void {
	const seenSources = new Set<string>();
	const seenPaths = new Set<string>();
	for (const [mappingIndex, mapping] of projection.credentialFiles.entries()) {
		if (seenSources.has(mapping.source)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Configured CLI credential file sources must be unique.',
				path: ['credentialFiles', mappingIndex, 'source'],
			});
		}
		if (seenPaths.has(mapping.path)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Configured CLI credential file paths must be unique.',
				path: ['credentialFiles', mappingIndex, 'path'],
			});
		}
		seenSources.add(mapping.source);
		seenPaths.add(mapping.path);
	}
	for (const [environmentName, value] of Object.entries(projection.credentialEnvironment)) {
		if (value.kind === 'credential_file' && !seenSources.has(value.source)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Configured CLI credential environment references an unknown file source.',
				path: ['credentialEnvironment', environmentName, 'source'],
			});
		}
	}
}

function validateCredentialedManagedVmTarget(
	target: CredentialedManagedVmTargetForValidation,
	context: z.RefinementCtx,
): void {
	const projection = target.credentialProjection;
	if (projection.kind === 'file_binding') {
		validateFileCredentialProjection(projection, context);
	} else {
		const allowedHosts = new Set(target.allowedHosts);
		for (const [environmentName, source] of Object.entries(projection.environment)) {
			for (const [hostIndex, host] of source.hosts.entries()) {
				if (allowedHosts.has(host)) continue;
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Mediated credential hosts must also be allowed by the Managed VM target.',
					path: ['credentialProjection', 'environment', environmentName, 'hosts', hostIndex],
				});
			}
		}
	}
	if (target.environment.kind !== 'inherit_allowlist') return;
	const credentialEnvironmentNames =
		projection.kind === 'file_binding'
			? Object.keys(projection.credentialEnvironment)
			: Object.keys(projection.environment);
	for (const environmentName of credentialEnvironmentNames) {
		if (!target.environment.names.includes(environmentName)) continue;
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'Configured CLI credential and inherited environment names must not overlap.',
			path: ['credentialProjection', 'environment', environmentName],
		});
	}
}

const absoluteControlFreePathSchema = z.string().startsWith('/').refine(isControlFreeText, {
	message: 'Configured CLI paths must not contain control characters.',
});

export const CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX = 'agent-vm-prepared-image:v1:';

export const configuredCliPreparedImageIdentityPayloadSchema = z
	.object({
		fingerprint: z.string().min(1),
		imageReference: z.string().min(1),
		schemaVersion: z.literal(1),
	})
	.strict();

export type ConfiguredCliPreparedImageIdentity = z.infer<
	typeof configuredCliPreparedImageIdentityPayloadSchema
>;

export function encodeConfiguredCliPreparedImageIdentity(
	payload: ConfiguredCliPreparedImageIdentity,
): string {
	const parsedPayload = configuredCliPreparedImageIdentityPayloadSchema.parse(payload);
	const canonicalPayload = JSON.stringify({
		fingerprint: parsedPayload.fingerprint,
		imageReference: parsedPayload.imageReference,
		schemaVersion: parsedPayload.schemaVersion,
	});
	return `${CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX}${Buffer.from(canonicalPayload).toString('base64url')}`;
}

export function decodeConfiguredCliPreparedImageIdentity(
	identity: string,
): ConfiguredCliPreparedImageIdentity {
	if (!identity.startsWith(CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX)) {
		throw new Error('Configured CLI effective image identity has an invalid prefix.');
	}
	const encodedPayload = identity.slice(CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/u.test(encodedPayload)) {
		throw new Error('Configured CLI effective image identity is not canonical base64url.');
	}
	let untrustedPayload: unknown;
	try {
		untrustedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
	} catch {
		throw new Error('Configured CLI effective image identity is not valid JSON.');
	}
	const payload = configuredCliPreparedImageIdentityPayloadSchema.parse(untrustedPayload);
	if (encodeConfiguredCliPreparedImageIdentity(payload) !== identity) {
		throw new Error('Configured CLI effective image identity is not canonical.');
	}
	return payload;
}

export const configuredCliPreparedImageIdentitySchema = z.string().refine(
	(value) => {
		try {
			decodeConfiguredCliPreparedImageIdentity(value);
			return true;
		} catch {
			return false;
		}
	},
	{ message: 'Configured CLI effective image identity is malformed.' },
);

export const configuredCliImageRecipePathSchema = z
	.string()
	.min(1)
	.refine(isControlFreeText, {
		message: 'Configured CLI image recipe paths must not contain control characters.',
	})
	.refine((value) => !value.startsWith('agent-vm-prepared-image:'), {
		message:
			'Configured CLI authored image references cannot use the reserved prepared-image prefix.',
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
			credentialProjection: configuredCliCredentialProjectionSchema,
			environment: configuredCliEnvironmentPolicySchema,
			guestCwd: absoluteControlFreePathSchema,
			imageReference: configuredCliImageRecipePathSchema,
			kind: z.literal('ephemeral_managed_vm'),
		})
		.strict()
		.superRefine(validateCredentialedManagedVmTarget),
]);

export const configuredCliEffectiveExecutionTargetSchema = z.discriminatedUnion('kind', [
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
			credentialProjection: configuredCliCredentialProjectionSchema,
			environment: configuredCliEnvironmentPolicySchema,
			guestCwd: absoluteControlFreePathSchema,
			imageReference: configuredCliPreparedImageIdentitySchema,
			kind: z.literal('ephemeral_managed_vm'),
		})
		.strict()
		.superRefine(validateCredentialedManagedVmTarget),
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

export const effectiveControllerConfiguredCliOperationSchema = configuredCliPolicySchema
	.safeExtend({
		executablePath: absoluteControlFreePathSchema,
		executionTarget: configuredCliEffectiveExecutionTargetSchema,
		kind: z.literal('configured_cli'),
		mandatoryArgvPrefix: z.array(configuredCliArgvTokenSchema).max(64),
		output: configuredCliOutputPolicySchema,
		safeHelp: z.string().min(1).max(4_000),
	})
	.strict();

export const effectiveControllerExecutionOperationSchema = z.discriminatedUnion('kind', [
	controllerRegisteredOperationSchema,
	effectiveControllerConfiguredCliOperationSchema,
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
export type ConfiguredCliCredentialEnvironmentValue = z.infer<
	typeof configuredCliCredentialEnvironmentValueSchema
>;
export type ConfiguredCliCredentialProjection = z.infer<
	typeof configuredCliCredentialProjectionSchema
>;
export type ConfiguredCliCredentialFileMapping = z.infer<
	typeof configuredCliCredentialFileMappingSchema
>;
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
export type ControllerExecutionOperation = z.infer<typeof controllerExecutionOperationSchema>;
export type EffectiveControllerExecutionOperation = z.infer<
	typeof effectiveControllerExecutionOperationSchema
>;

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
