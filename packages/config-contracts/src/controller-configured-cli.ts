import { isIP } from 'node:net';

import {
	compiledGoogleCommandSetSchema,
	configuredCliAllowedCommandSchema,
	configuredCliArgvTokenSchema,
	type configuredCliInvocationCallPolicySchema,
	configuredCliInvocationMatcherSchema,
	configuredCliPatternRuleSchema,
	configuredCliPolicySchema,
	configuredCliStaticInvocationCallPolicySchema,
	configuredCliStdinPolicySchema,
	configuredCliTimeoutPolicySchema,
	secretValueSchema,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

export const suggestedConfiguredCliInvocationCallPolicySchema = z
	.object({
		suggestDeny: z.array(configuredCliInvocationMatcherSchema).default([]),
		suggestRequiresApproval: z.array(configuredCliInvocationMatcherSchema).default([]),
		suggestWithoutApproval: z.literal('remaining_admitted'),
	})
	.strict();

export const suggestedConfiguredCliPolicySchema = z
	.object({
		suggestCalls: suggestedConfiguredCliInvocationCallPolicySchema,
		suggestCommands: z.array(configuredCliAllowedCommandSchema).min(1),
		suggestDeniedPatterns: z.array(configuredCliPatternRuleSchema).default([]),
		suggestStdin: configuredCliStdinPolicySchema.default({ kind: 'none' }),
		suggestTimeout: configuredCliTimeoutPolicySchema,
	})
	.strict()
	.superRefine((suggestions, context) => {
		const parsed = configuredCliPolicySchema.safeParse({
			calls: {
				deny: suggestions.suggestCalls.suggestDeny,
				requiresApproval: suggestions.suggestCalls.suggestRequiresApproval,
				withoutApproval: suggestions.suggestCalls.suggestWithoutApproval,
			},
			commands: suggestions.suggestCommands,
			deniedPatterns: suggestions.suggestDeniedPatterns,
			stdin: suggestions.suggestStdin,
			timeout: suggestions.suggestTimeout,
		});
		if (parsed.success) return;
		for (const issue of parsed.error.issues) {
			context.addIssue({
				...issue,
				path: issue.path.map((segment) => {
					if (segment === 'calls') return 'suggestCalls';
					if (segment === 'deny') return 'suggestDeny';
					if (segment === 'requiresApproval') return 'suggestRequiresApproval';
					if (segment === 'withoutApproval') return 'suggestWithoutApproval';
					if (segment === 'commands') return 'suggestCommands';
					if (segment === 'deniedPatterns') return 'suggestDeniedPatterns';
					if (segment === 'stdin') return 'suggestStdin';
					if (segment === 'timeout') return 'suggestTimeout';
					return segment;
				}),
			});
		}
	});

export function configuredCliPolicyFromSuggestions(
	suggestions: z.infer<typeof suggestedConfiguredCliPolicySchema>,
): z.infer<typeof configuredCliPolicySchema> {
	return configuredCliPolicySchema.parse({
		calls: {
			deny: suggestions.suggestCalls.suggestDeny,
			requiresApproval: suggestions.suggestCalls.suggestRequiresApproval,
			withoutApproval: suggestions.suggestCalls.suggestWithoutApproval,
		},
		commands: suggestions.suggestCommands,
		deniedPatterns: suggestions.suggestDeniedPatterns,
		stdin: suggestions.suggestStdin,
		timeout: suggestions.suggestTimeout,
	});
}

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

function isCanonicalExactNetworkHost(value: string): boolean {
	if (value !== value.toLowerCase()) return false;
	if (isIP(value) !== 0) return true;
	if (value.length > 253 || value.endsWith('.')) return false;
	return value
		.split('.')
		.every(
			(label) =>
				label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
		);
}

export const configuredCliExactNetworkHostSchema = z
	.string()
	.min(1)
	.refine(isCanonicalExactNetworkHost, {
		message: 'Configured CLI hosts must be canonical exact DNS names or IP addresses.',
	});

const configuredCliExactNetworkHostsSchema = z
	.array(configuredCliExactNetworkHostSchema)
	.refine((hosts) => new Set(hosts).size === hosts.length, {
		message: 'Configured CLI hosts must be unique.',
	});

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
		hosts: configuredCliExactNetworkHostsSchema.min(1),
		secret: secretValueSchema,
	})
	.strict();

const configuredCliOAuthAccessTokenSourceSchema = z
	.object({ kind: z.literal('oauth_access_token') })
	.strict();

const configuredCliMediatedCredentialEnvironmentSchema = z
	.record(
		z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
		z.union([
			configuredCliMediatedCredentialSourceSchema,
			configuredCliOAuthAccessTokenSourceSchema,
		]),
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
				path: ['credentialProjection', 'credentialFiles', mappingIndex, 'source'],
			});
		}
		if (seenPaths.has(mapping.path)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Configured CLI credential file paths must be unique.',
				path: ['credentialProjection', 'credentialFiles', mappingIndex, 'path'],
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
				path: ['credentialProjection', 'credentialEnvironment', environmentName, 'source'],
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
			if ('kind' in source) continue;
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
			path: [
				'credentialProjection',
				projection.kind === 'file_binding' ? 'credentialEnvironment' : 'environment',
				environmentName,
			],
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

export const configuredCliControllerHostExecutionTargetSchema = z
	.object({
		cwd: absoluteControlFreePathSchema,
		environment: configuredCliEnvironmentPolicySchema,
		kind: z.literal('controller_host'),
	})
	.strict();
export const configuredCliEphemeralManagedVmExecutionTargetSchema = z
	.object({
		allowedHosts: configuredCliExactNetworkHostsSchema.default([]),
		credentialProjection: configuredCliCredentialProjectionSchema,
		environment: configuredCliEnvironmentPolicySchema,
		guestCwd: absoluteControlFreePathSchema,
		imageReference: configuredCliImageRecipePathSchema,
		kind: z.literal('ephemeral_managed_vm'),
	})
	.strict()
	.superRefine(validateCredentialedManagedVmTarget);
export const configuredCliToolVmExecutionTargetSchema = z
	.object({
		kind: z.literal('tool_vm'),
		workingDirectory: z
			.string()
			.min(1)
			.refine(
				(value) =>
					!value.includes('\0') && !value.startsWith('/') && !value.split('/').includes('..'),
				{ message: 'Tool VM configured CLI working directories must remain work-relative.' },
			),
	})
	.strict();

export const configuredCliExecutionTargetSchema = z.discriminatedUnion('kind', [
	configuredCliControllerHostExecutionTargetSchema,
	configuredCliEphemeralManagedVmExecutionTargetSchema,
	configuredCliToolVmExecutionTargetSchema,
]);

export const configuredCliEffectiveControllerHostExecutionTargetSchema = z
	.object({
		cwd: absoluteControlFreePathSchema,
		environment: configuredCliEnvironmentPolicySchema,
		kind: z.literal('controller_host'),
	})
	.strict();
export const configuredCliEffectiveEphemeralManagedVmExecutionTargetSchema = z
	.object({
		allowedHosts: configuredCliExactNetworkHostsSchema.default([]),
		credentialProjection: configuredCliCredentialProjectionSchema,
		environment: configuredCliEnvironmentPolicySchema,
		guestCwd: absoluteControlFreePathSchema,
		imageReference: configuredCliPreparedImageIdentitySchema,
		kind: z.literal('ephemeral_managed_vm'),
	})
	.strict()
	.superRefine(validateCredentialedManagedVmTarget);

export const configuredCliEffectiveExecutionTargetSchema = z.discriminatedUnion('kind', [
	configuredCliEffectiveControllerHostExecutionTargetSchema,
	configuredCliEffectiveEphemeralManagedVmExecutionTargetSchema,
	configuredCliToolVmExecutionTargetSchema,
]);

export const configuredCliOutputPolicySchema = z
	.object({
		modelVisibleStderr: z.enum(['none', 'fixed_safe_summary']),
		overflow: z.enum(['fail', 'truncate']),
		stderrMaxBytes: z.number().int().positive().max(16_777_216),
		stdoutMaxBytes: z.number().int().positive().max(16_777_216),
	})
	.strict();

export const configuredCliAuthorizationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }).strict(),
	z.object({ kind: z.literal('oauth_account') }).strict(),
]);

interface ConfiguredCliOperationAuthorizationValidation {
	readonly calls: z.infer<typeof configuredCliInvocationCallPolicySchema>;
	readonly authorization?: z.infer<typeof configuredCliAuthorizationSchema> | undefined;
	readonly commands: readonly z.infer<typeof configuredCliAllowedCommandSchema>[];
	readonly executionTarget:
		| { readonly kind: 'controller_host' }
		| {
				readonly credentialProjection: z.infer<typeof configuredCliCredentialProjectionSchema>;
				readonly kind: 'ephemeral_managed_vm';
		  }
		| { readonly kind: 'tool_vm' };
}

function validateConfiguredCliOperationAuthorization(
	operation: ConfiguredCliOperationAuthorizationValidation,
	context: z.RefinementCtx,
): void {
	const managedCalls = 'source' in operation.calls;
	const accountAuthorization = operation.authorization?.kind === 'oauth_account';
	if (managedCalls !== accountAuthorization) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message:
				'Google account authorization requires managed Google calls, without authored Ask/Allow rules.',
			path: ['calls'],
		});
	}
	const hasOAuthAccessTokenSource =
		operation.executionTarget.kind === 'ephemeral_managed_vm' &&
		operation.executionTarget.credentialProjection.kind === 'http_mediation' &&
		Object.values(operation.executionTarget.credentialProjection.environment).some(
			(source) => 'kind' in source && source.kind === 'oauth_access_token',
		);
	if (operation.authorization === undefined || operation.authorization.kind === 'none') {
		if (hasOAuthAccessTokenSource) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'OAuth access-token mediation requires OAuth account authorization.',
				path: ['authorization'],
			});
		}
		return;
	}
	if (operation.executionTarget.kind !== 'ephemeral_managed_vm') {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'OAuth-configured CLI operations must execute in an ephemeral Managed VM.',
			path: ['executionTarget', 'kind'],
		});
	}
	const oauthProjectionIsValid = (() => {
		if (operation.executionTarget.kind !== 'ephemeral_managed_vm') return false;
		const projection = operation.executionTarget.credentialProjection;
		if (projection.kind !== 'http_mediation') return false;
		const source = projection.environment.GOG_ACCESS_TOKEN;
		return (
			Object.keys(projection.environment).length === 1 &&
			source !== undefined &&
			'kind' in source &&
			source.kind === 'oauth_access_token'
		);
	})();
	if (operation.executionTarget.kind === 'ephemeral_managed_vm' && !oauthProjectionIsValid) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message:
				'OAuth-configured CLI operations require only the code-owned GOG_ACCESS_TOKEN OAuth mediation source.',
			path: ['executionTarget', 'credentialProjection'],
		});
	}
}

export const controllerRegisteredOperationSchema = z
	.object({ kind: z.literal('registered_action') })
	.strict();

const configuredCliOperationCommonShape = {
	executablePath: absoluteControlFreePathSchema,
	kind: z.literal('configured_cli'),
	mandatoryArgvPrefix: z.array(configuredCliArgvTokenSchema).max(64),
	output: configuredCliOutputPolicySchema,
	safeHelp: z.string().min(1).max(4_000),
} as const;

const configuredCliAuthorizedOperationCommonShape = {
	...configuredCliOperationCommonShape,
	authorization: configuredCliAuthorizationSchema.optional(),
} as const;

export const controllerHostConfiguredCliOperationSchema = configuredCliPolicySchema
	.safeExtend({
		...configuredCliAuthorizedOperationCommonShape,
		executionTarget: configuredCliControllerHostExecutionTargetSchema,
	})
	.strict()
	.superRefine(validateConfiguredCliOperationAuthorization);

export const controllerEphemeralManagedVmConfiguredCliOperationSchema = configuredCliPolicySchema
	.safeExtend({
		...configuredCliAuthorizedOperationCommonShape,
		executionTarget: configuredCliEphemeralManagedVmExecutionTargetSchema,
	})
	.strict()
	.superRefine(validateConfiguredCliOperationAuthorization);

export const controllerEnforcedConfiguredCliOperationSchema = z.union([
	controllerHostConfiguredCliOperationSchema,
	controllerEphemeralManagedVmConfiguredCliOperationSchema,
]);

export const controllerToolVmConfiguredCliOperationSchema = suggestedConfiguredCliPolicySchema
	.safeExtend({
		...configuredCliOperationCommonShape,
		executionTarget: configuredCliToolVmExecutionTargetSchema,
	})
	.strict();

export const controllerConfiguredCliOperationSchema = z.union([
	controllerHostConfiguredCliOperationSchema,
	controllerEphemeralManagedVmConfiguredCliOperationSchema,
	controllerToolVmConfiguredCliOperationSchema,
]);

export type ControllerHostConfiguredCliOperation = z.infer<
	typeof controllerHostConfiguredCliOperationSchema
>;
export type ControllerEphemeralManagedVmConfiguredCliOperation = z.infer<
	typeof controllerEphemeralManagedVmConfiguredCliOperationSchema
>;
export type ControllerToolVmConfiguredCliOperation = z.infer<
	typeof controllerToolVmConfiguredCliOperationSchema
>;
export type ControllerConfiguredCliOperation = z.infer<
	typeof controllerConfiguredCliOperationSchema
>;

export function isControllerEphemeralManagedVmConfiguredCliOperation(
	operation: ControllerConfiguredCliOperation,
): operation is ControllerEphemeralManagedVmConfiguredCliOperation {
	return operation.executionTarget.kind === 'ephemeral_managed_vm';
}

export function isControllerToolVmConfiguredCliOperation(
	operation: ControllerConfiguredCliOperation,
): operation is ControllerToolVmConfiguredCliOperation {
	return operation.executionTarget.kind === 'tool_vm';
}

export const controllerExecutionOperationSchema = z.union([
	controllerRegisteredOperationSchema,
	controllerConfiguredCliOperationSchema,
]);

export const effectiveControllerHostConfiguredCliOperationSchema = configuredCliPolicySchema
	.safeExtend({
		...configuredCliAuthorizedOperationCommonShape,
		executionTarget: configuredCliEffectiveControllerHostExecutionTargetSchema,
	})
	.strict()
	.superRefine(validateConfiguredCliOperationAuthorization);

export const effectiveControllerEphemeralManagedVmConfiguredCliOperationSchema =
	configuredCliPolicySchema
		.safeExtend({
			...configuredCliAuthorizedOperationCommonShape,
			compiledGoogle: compiledGoogleCommandSetSchema.optional(),
			executionTarget: configuredCliEffectiveEphemeralManagedVmExecutionTargetSchema,
		})
		.strict()
		.superRefine(validateConfiguredCliOperationAuthorization);

export const effectiveControllerToolVmConfiguredCliOperationSchema = configuredCliPolicySchema
	.safeExtend({
		...configuredCliOperationCommonShape,
		calls: configuredCliStaticInvocationCallPolicySchema,
		executionTarget: configuredCliToolVmExecutionTargetSchema,
	})
	.strict();

export const effectiveControllerConfiguredCliOperationSchema = z.union([
	effectiveControllerHostConfiguredCliOperationSchema,
	effectiveControllerEphemeralManagedVmConfiguredCliOperationSchema,
	effectiveControllerToolVmConfiguredCliOperationSchema,
]);

export type EffectiveControllerHostConfiguredCliOperation = z.infer<
	typeof effectiveControllerHostConfiguredCliOperationSchema
>;
export type EffectiveControllerEphemeralManagedVmConfiguredCliOperation = z.infer<
	typeof effectiveControllerEphemeralManagedVmConfiguredCliOperationSchema
>;
export type EffectiveControllerToolVmConfiguredCliOperation = z.infer<
	typeof effectiveControllerToolVmConfiguredCliOperationSchema
>;
export type EffectiveControllerConfiguredCliOperation = z.infer<
	typeof effectiveControllerConfiguredCliOperationSchema
>;

export function isEffectiveControllerHostConfiguredCliOperation(
	operation: EffectiveControllerConfiguredCliOperation,
): operation is EffectiveControllerHostConfiguredCliOperation {
	return operation.executionTarget.kind === 'controller_host';
}

export function isEffectiveControllerEphemeralManagedVmConfiguredCliOperation(
	operation: EffectiveControllerConfiguredCliOperation,
): operation is EffectiveControllerEphemeralManagedVmConfiguredCliOperation {
	return operation.executionTarget.kind === 'ephemeral_managed_vm';
}

export function isEffectiveControllerToolVmConfiguredCliOperation(
	operation: EffectiveControllerConfiguredCliOperation,
): operation is EffectiveControllerToolVmConfiguredCliOperation {
	return operation.executionTarget.kind === 'tool_vm';
}

export const effectiveControllerExecutionOperationSchema = z.union([
	controllerRegisteredOperationSchema,
	effectiveControllerConfiguredCliOperationSchema,
]);

export function normalizePreparedControllerExecutionOperation(
	operation: z.infer<typeof controllerExecutionOperationSchema>,
): z.infer<typeof effectiveControllerExecutionOperationSchema> {
	if (operation.kind === 'registered_action') return operation;
	if (!isControllerToolVmConfiguredCliOperation(operation)) {
		return operation.executionTarget.kind === 'controller_host'
			? effectiveControllerHostConfiguredCliOperationSchema.parse(operation)
			: effectiveControllerEphemeralManagedVmConfiguredCliOperationSchema.parse(operation);
	}
	const policy = configuredCliPolicyFromSuggestions(operation);
	return effectiveControllerToolVmConfiguredCliOperationSchema.parse({
		calls: policy.calls,
		commands: policy.commands,
		deniedPatterns: policy.deniedPatterns,
		executablePath: operation.executablePath,
		executionTarget: operation.executionTarget,
		kind: operation.kind,
		mandatoryArgvPrefix: operation.mandatoryArgvPrefix,
		output: operation.output,
		safeHelp: operation.safeHelp,
		stdin: policy.stdin,
		timeout: policy.timeout,
	});
}
export type ConfiguredCliAuthorization = z.infer<typeof configuredCliAuthorizationSchema>;
export type ConfiguredCliCredentialEnvironmentValue = z.infer<
	typeof configuredCliCredentialEnvironmentValueSchema
>;
export type ConfiguredCliCredentialProjection = z.infer<
	typeof configuredCliCredentialProjectionSchema
>;
export type ConfiguredCliCredentialFileMapping = z.infer<
	typeof configuredCliCredentialFileMappingSchema
>;
export type ControllerExecutionOperation = z.infer<typeof controllerExecutionOperationSchema>;
export type ControllerEnforcedConfiguredCliOperation = z.infer<
	typeof controllerEnforcedConfiguredCliOperationSchema
>;
export type EffectiveControllerExecutionOperation = z.infer<
	typeof effectiveControllerExecutionOperationSchema
>;

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
