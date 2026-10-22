import { toolPortalNamespaceAllowsOperation } from '@agent-collaboration/tool-access/authorization';
import {
	compiledGoogleCommandSetSchema,
	configuredCliAllowedCommandSchema,
	configuredCliInvocationCallPolicySchema,
	configuredCliPatternRuleSchema,
	configuredCliStaticInvocationCallPolicySchema,
	configuredCliStdinPolicySchema,
	configuredCliTimeoutPolicySchema,
	googleOAuthApplicationIdSchema,
	namespaceDiscoverySchema,
	toolPortalAgentConfigSchema,
	toolPortalBackendKindSchema,
	toolPortalCallPolicySchema,
	toolPortalNamespaceCallPolicySchema,
	toolPortalToolSelectorSchema,
	type ToolPortalNamespaceCallPolicy,
} from '@agent-collaboration/tool-access/contracts';
import {
	standaloneToolPortalConfigSchema,
	validateStandaloneToolPortalConfig,
	type StandaloneToolPortalConfig,
} from '@agent-collaboration/tool-host-node';
import { z } from 'zod';

import {
	configuredCliAuthorizationSchema,
	configuredCliCredentialLogicalNameSchema,
	controllerExecutionOperationSchema,
	controllerRegisteredOperationSchema,
	effectiveControllerHostConfiguredCliOperationSchema,
	isEffectiveControllerEphemeralManagedVmConfiguredCliOperation,
	isEffectiveControllerToolVmConfiguredCliOperation,
	effectiveControllerExecutionOperationSchema as preparedControllerExecutionOperationSchema,
} from './controller-configured-cli.js';
import {
	googleConsentRecommendationConfigSchema,
	googlePolicyDefaultsConfigSchema,
} from './google-policy-defaults-config.js';
import { loadJsonConfigFile } from './json-config-file.js';
import { googleOAuthCeilingSchema } from './oauth-config.js';

function validateManagedGoogleNamespace(
	policy: {
		readonly calls: ToolPortalNamespaceCallPolicy;
		readonly backend: {
			readonly kind: string;
			readonly operations?:
				| Readonly<
						Record<
							string,
							{
								readonly kind: string;
								readonly authorization?: { readonly kind: string } | undefined;
							}
						>
				  >
				| undefined;
		};
	},
	context: z.RefinementCtx,
): void {
	const managed = 'source' in policy.calls;
	if (managed && policy.backend.kind !== 'controller_execution') {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: 'Managed Google policy requires controller execution.',
			path: ['calls'],
		});
		return;
	}
	for (const [name, operation] of Object.entries(policy.backend.operations ?? {})) {
		const google =
			operation.kind === 'configured_cli' && operation.authorization?.kind === 'oauth_account';
		if (google !== managed)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					'Managed Google namespaces contain only account-authorized Google CLI operations; other namespaces retain static call policy.',
				path: ['backend', 'operations', name],
			});
	}
}

const sandboxOperationDescriptionSchema = z.string().min(1);
const sandboxExecutableSchema = z
	.string()
	.min(1)
	.refine((value) => value.startsWith('/') && !value.includes('\0'), {
		message: 'Sandbox command executables must be absolute and contain no NUL bytes.',
	});
const sandboxMandatoryArgvPrefixSchema = z
	.array(
		z
			.string()
			.max(4_096)
			.refine((value) => !value.includes('\0'), {
				message: 'Sandbox command arguments must contain no NUL bytes.',
			}),
	)
	.max(64);
const sandboxWorkingDirectorySchema = z
	.string()
	.min(1)
	.refine(
		(value) => !value.includes('\0') && !value.startsWith('/') && !value.split('/').includes('..'),
		{
			message: 'Sandbox command working directories must stay relative to the Tool VM work root.',
		},
	);

export const toolPortalSandboxSshOperationDefinitionSchema = z.discriminatedUnion('kind', [
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			executable: sandboxExecutableSchema,
			kind: z.literal('command.fixed'),
			mandatoryArgvPrefix: sandboxMandatoryArgvPrefixSchema,
			workingDirectory: sandboxWorkingDirectorySchema,
		})
		.strict(),
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			kind: z.literal('filesystem.read'),
		})
		.strict(),
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			kind: z.literal('filesystem.write'),
		})
		.strict(),
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			kind: z.literal('process.cancel'),
		})
		.strict(),
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			kind: z.literal('process.logs'),
		})
		.strict(),
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			executable: sandboxExecutableSchema,
			kind: z.literal('process.start'),
			mandatoryArgvPrefix: sandboxMandatoryArgvPrefixSchema,
			maxRuntimeMs: z.number().int().positive().max(3_600_000),
			retainOutputBytes: z.number().int().positive().max(16_777_216),
			workingDirectory: sandboxWorkingDirectorySchema,
		})
		.strict(),
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			kind: z.literal('process.status'),
		})
		.strict(),
	z
		.object({
			description: sandboxOperationDescriptionSchema,
			kind: z.literal('process.wait'),
			timeoutMs: z.number().int().positive().max(3_600_000),
		})
		.strict(),
]);

export type ToolPortalSandboxSshOperationDefinition = z.infer<
	typeof toolPortalSandboxSshOperationDefinitionSchema
>;

export const toolPortalSandboxSshBackendBindingSchema = z
	.object({
		kind: z.literal(toolPortalBackendKindSchema.enum.tool_vm_runner),
		operations: z
			.record(z.string().min(1), toolPortalSandboxSshOperationDefinitionSchema)
			.refine((operations) => Object.keys(operations).length > 0, {
				message: 'Tool VM runner bindings must configure at least one operation.',
			}),
		profile: z.literal('sandbox_ssh'),
	})
	.strict();

export type ToolPortalSandboxSshBackendBinding = z.infer<
	typeof toolPortalSandboxSshBackendBindingSchema
>;

export const toolPortalControllerExecutionBackendBindingSchema = z
	.object({
		kind: z.literal(toolPortalBackendKindSchema.enum.controller_execution),
		operations: z
			.record(z.string().min(1), controllerExecutionOperationSchema)
			.refine((operations) => Object.keys(operations).length > 0, {
				message: 'Controller execution bindings must configure at least one operation.',
			}),
	})
	.strict();

export type ToolPortalControllerExecutionBackendBinding = z.infer<
	typeof toolPortalControllerExecutionBackendBindingSchema
>;

export const toolPortalBackendBindingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal(toolPortalBackendKindSchema.enum.mcp_provider) }).strict(),
	toolPortalControllerExecutionBackendBindingSchema,
	toolPortalSandboxSshBackendBindingSchema,
]);

export type ToolPortalBackendBinding = z.infer<typeof toolPortalBackendBindingSchema>;

const toolPortalNamespacePolicyCommonShape = {
	calls: toolPortalCallPolicySchema,
	tools: toolPortalToolSelectorSchema,
} as const;

const toolPortalMcpNamespacePolicySchema = z
	.object({
		...toolPortalNamespacePolicyCommonShape,
		backend: z.object({ kind: z.literal('mcp_provider') }).strict(),
	})
	.strict();

const toolPortalControllerExecutionNamespacePolicySchema = z
	.object({
		...toolPortalNamespacePolicyCommonShape,
		calls: toolPortalNamespaceCallPolicySchema,
		backend: toolPortalControllerExecutionBackendBindingSchema,
		discovery: namespaceDiscoverySchema.default({}),
	})
	.strict()
	.superRefine(validateManagedGoogleNamespace);

const toolPortalSandboxSshNamespacePolicySchema = z
	.object({
		...toolPortalNamespacePolicyCommonShape,
		backend: toolPortalSandboxSshBackendBindingSchema,
		discovery: namespaceDiscoverySchema.default({}),
	})
	.strict();

export const toolPortalNamespacePolicySchema = z.union([
	toolPortalMcpNamespacePolicySchema,
	toolPortalControllerExecutionNamespacePolicySchema,
	toolPortalSandboxSshNamespacePolicySchema,
]);

export type ToolPortalNamespacePolicy = z.infer<typeof toolPortalNamespacePolicySchema>;

export const toolPortalProfileDefinitionSchema = z
	.object({
		catalogMode: z.enum(['compact', 'catalog']).optional(),
		namespaces: z.record(z.string().min(1), toolPortalNamespacePolicySchema).default({}),
		oauthApplications: z
			.partialRecord(
				googleOAuthApplicationIdSchema,
				z
					.object({
						ceiling: googleOAuthCeilingSchema,
						consentRecommendation: googleConsentRecommendationConfigSchema.optional(),
						policyDefaults: googlePolicyDefaultsConfigSchema.optional(),
					})
					.strict(),
			)
			.optional(),
	})
	.strict();

export type ToolPortalProfileDefinition = z.infer<typeof toolPortalProfileDefinitionSchema>;

const toolPortalCredentialFileSecretSchema = z
	.object({
		ref: z.string().regex(/^op:\/\//u, '1Password refs must start with op://'),
		source: z.literal('1password'),
	})
	.strict();

export const toolPortalCredentialBindingSchema = z
	.object({
		files: z
			.record(configuredCliCredentialLogicalNameSchema, toolPortalCredentialFileSecretSchema)
			.refine((files) => Object.keys(files).length > 0, {
				message: 'Credential bindings must contain at least one file.',
			})
			.refine((files) => Object.keys(files).length <= 16, {
				message: 'Credential bindings must contain at most 16 files.',
			}),
	})
	.strict();

export const managedToolPortalAgentConfigSchema = z
	.object({
		credentialBindings: z
			.record(configuredCliCredentialLogicalNameSchema, toolPortalCredentialBindingSchema)
			.optional(),
		profile: z.string().min(1),
	})
	.strict();

export type ManagedToolPortalAgentConfig = z.infer<typeof managedToolPortalAgentConfigSchema>;

const toolPortalCommonConfigShape = {
	$schema: z.string().min(1).optional(),
	profiles: z.record(z.string().min(1), toolPortalProfileDefinitionSchema),
	schemaVersion: z.literal(1),
} as const;

export const managedToolPortalConfigSchema = z
	.object({
		...toolPortalCommonConfigShape,
		agents: z.record(z.string().min(1), managedToolPortalAgentConfigSchema).default({}),
		mode: z.literal('managed'),
	})
	.strict();

export type ManagedToolPortalConfig = z.infer<typeof managedToolPortalConfigSchema>;

const preparedToolPortalControllerExecutionBackendBindingSchema = z
	.object({
		kind: z.literal('controller_execution'),
		operations: z
			.record(z.string().min(1), preparedControllerExecutionOperationSchema)
			.refine((operations) => Object.keys(operations).length > 0),
	})
	.strict();

const preparedToolPortalBackendBindingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('mcp_provider') }).strict(),
	preparedToolPortalControllerExecutionBackendBindingSchema,
	toolPortalSandboxSshBackendBindingSchema,
]);

const preparedToolPortalNamespacePolicySchema = z
	.object({
		backend: preparedToolPortalBackendBindingSchema,
		calls: toolPortalNamespaceCallPolicySchema,
		discovery: namespaceDiscoverySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict()
	.superRefine(validateManagedGoogleNamespace);

const preparedToolPortalProfileDefinitionSchema = z
	.object({
		catalogMode: z.enum(['compact', 'catalog']).optional(),
		namespaces: z.record(z.string().min(1), preparedToolPortalNamespacePolicySchema),
	})
	.strict();

export const preparedManagedToolPortalConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		agents: z.record(z.string().min(1), managedToolPortalAgentConfigSchema).default({}),
		mode: z.literal('managed'),
		profiles: z.record(z.string().min(1), preparedToolPortalProfileDefinitionSchema),
		schemaVersion: z.literal(1),
	})
	.strict();

export type PreparedManagedToolPortalConfig = z.infer<typeof preparedManagedToolPortalConfigSchema>;

const gatewayRuntimeConfiguredCliCommonShape = {
	calls: configuredCliInvocationCallPolicySchema,
	commands: z.array(configuredCliAllowedCommandSchema).min(1),
	deniedPatterns: z.array(configuredCliPatternRuleSchema),
	kind: z.literal('configured_cli'),
	safeHelp: z.string().min(1).max(4_000),
	stdin: configuredCliStdinPolicySchema,
	timeout: configuredCliTimeoutPolicySchema,
} as const;

export const gatewayRuntimeControllerHostConfiguredCliOperationSchema = z
	.object({
		...gatewayRuntimeConfiguredCliCommonShape,
		authorization: configuredCliAuthorizationSchema.optional(),
		targetKind: z.literal('controller_host'),
	})
	.strict();

export const gatewayRuntimeEphemeralManagedVmConfiguredCliOperationSchema = z
	.object({
		...gatewayRuntimeConfiguredCliCommonShape,
		authorization: configuredCliAuthorizationSchema.optional(),
		compiledGoogle: compiledGoogleCommandSetSchema.optional(),
		targetKind: z.literal('ephemeral_managed_vm'),
	})
	.strict();

export const gatewayRuntimeToolVmConfiguredCliOperationSchema = z
	.object({
		...gatewayRuntimeConfiguredCliCommonShape,
		calls: configuredCliStaticInvocationCallPolicySchema,
		executablePath: z.string().min(1),
		mandatoryArgvPrefix: z.array(z.string().max(4_096)).max(64),
		output: z
			.object({
				modelVisibleStderr: z.enum(['none', 'fixed_safe_summary']),
				overflow: z.enum(['fail', 'truncate']),
				stderrMaxBytes: z.number().int().positive().max(16_777_216),
				stdoutMaxBytes: z.number().int().positive().max(16_777_216),
			})
			.strict(),
		targetKind: z.literal('tool_vm'),
		workingDirectory: z.string().min(1),
	})
	.strict();

export const gatewayRuntimeConfiguredCliOperationSchema = z.discriminatedUnion('targetKind', [
	gatewayRuntimeControllerHostConfiguredCliOperationSchema,
	gatewayRuntimeEphemeralManagedVmConfiguredCliOperationSchema,
	gatewayRuntimeToolVmConfiguredCliOperationSchema,
]);

export const gatewayRuntimeControllerExecutionOperationSchema = z.discriminatedUnion('kind', [
	controllerRegisteredOperationSchema,
	gatewayRuntimeConfiguredCliOperationSchema,
]);

export type GatewayRuntimeControllerExecutionOperation = z.infer<
	typeof gatewayRuntimeControllerExecutionOperationSchema
>;

const effectiveControllerExecutionOperationSchema = z.union([
	controllerRegisteredOperationSchema,
	effectiveControllerHostConfiguredCliOperationSchema,
	gatewayRuntimeEphemeralManagedVmConfiguredCliOperationSchema,
	gatewayRuntimeToolVmConfiguredCliOperationSchema,
]);

const effectiveControllerExecutionBackendBindingSchema = z
	.object({
		kind: z.literal('controller_execution'),
		operations: z
			.record(z.string().min(1), effectiveControllerExecutionOperationSchema)
			.refine((operations) => Object.keys(operations).length > 0),
	})
	.strict();

const effectiveToolPortalBackendBindingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('mcp_provider') }).strict(),
	effectiveControllerExecutionBackendBindingSchema,
	toolPortalSandboxSshBackendBindingSchema,
]);

const effectiveToolPortalNamespacePolicySchema = z
	.object({
		backend: effectiveToolPortalBackendBindingSchema,
		calls: toolPortalNamespaceCallPolicySchema,
		discovery: namespaceDiscoverySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict()
	.superRefine(validateManagedGoogleNamespace);

const effectiveToolPortalProfileDefinitionSchema = z
	.object({
		catalogMode: z.enum(['compact', 'catalog']).optional(),
		namespaces: z.record(z.string().min(1), effectiveToolPortalNamespacePolicySchema),
	})
	.strict();

export const gatewayRuntimeControllerExecutionBackendBindingSchema = z
	.object({
		kind: z.literal('controller_execution'),
		operations: z
			.record(z.string().min(1), gatewayRuntimeControllerExecutionOperationSchema)
			.refine((operations) => Object.keys(operations).length > 0),
	})
	.strict();

const gatewayRuntimeToolPortalBackendBindingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('mcp_provider') }).strict(),
	gatewayRuntimeControllerExecutionBackendBindingSchema,
	toolPortalSandboxSshBackendBindingSchema,
]);

const gatewayRuntimeToolPortalNamespacePolicySchema = z
	.object({
		backend: gatewayRuntimeToolPortalBackendBindingSchema,
		calls: toolPortalNamespaceCallPolicySchema,
		discovery: namespaceDiscoverySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict()
	.superRefine(validateManagedGoogleNamespace);

const gatewayRuntimeToolPortalProfileDefinitionSchema = z
	.object({
		catalogMode: z.enum(['compact', 'catalog']).optional(),
		namespaces: z.record(z.string().min(1), gatewayRuntimeToolPortalNamespacePolicySchema),
	})
	.strict();

export const effectiveManagedToolPortalConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		agents: z.record(z.string().min(1), toolPortalAgentConfigSchema).default({}),
		credentialedRuntimeRevision: z.string().min(1).optional(),
		mode: z.literal('managed'),
		profiles: z.record(z.string().min(1), effectiveToolPortalProfileDefinitionSchema),
		schemaVersion: z.literal(1),
	})
	.strict();

export type EffectiveManagedToolPortalConfig = z.infer<
	typeof effectiveManagedToolPortalConfigSchema
>;

function projectedConfiguredCliOperation(
	operation: Extract<
		PreparedManagedToolPortalConfig['profiles'][string]['namespaces'][string]['backend'],
		{ readonly kind: 'controller_execution' }
	>['operations'][string],
): GatewayRuntimeControllerExecutionOperation {
	if (operation.kind === 'registered_action') return operation;
	if (isEffectiveControllerEphemeralManagedVmConfiguredCliOperation(operation)) {
		return gatewayRuntimeEphemeralManagedVmConfiguredCliOperationSchema.parse({
			...(operation.authorization === undefined ? {} : { authorization: operation.authorization }),
			...(operation.compiledGoogle === undefined
				? {}
				: { compiledGoogle: operation.compiledGoogle }),
			calls: operation.calls,
			commands: operation.commands,
			deniedPatterns: operation.deniedPatterns,
			kind: 'configured_cli',
			safeHelp: operation.safeHelp,
			stdin: operation.stdin,
			targetKind: operation.executionTarget.kind,
			timeout: operation.timeout,
		});
	}
	if (isEffectiveControllerToolVmConfiguredCliOperation(operation)) {
		return gatewayRuntimeToolVmConfiguredCliOperationSchema.parse({
			calls: operation.calls,
			commands: operation.commands,
			deniedPatterns: operation.deniedPatterns,
			executablePath: operation.executablePath,
			kind: 'configured_cli',
			mandatoryArgvPrefix: operation.mandatoryArgvPrefix,
			output: operation.output,
			safeHelp: operation.safeHelp,
			stdin: operation.stdin,
			targetKind: operation.executionTarget.kind,
			timeout: operation.timeout,
			workingDirectory: operation.executionTarget.workingDirectory,
		});
	}
	return gatewayRuntimeControllerHostConfiguredCliOperationSchema.parse({
		...(operation.authorization === undefined ? {} : { authorization: operation.authorization }),
		calls: operation.calls,
		commands: operation.commands,
		deniedPatterns: operation.deniedPatterns,
		kind: 'configured_cli',
		safeHelp: operation.safeHelp,
		stdin: operation.stdin,
		targetKind: operation.executionTarget.kind,
		timeout: operation.timeout,
	});
}

export function createEffectiveManagedToolPortalConfig(
	config: PreparedManagedToolPortalConfig,
	options: { readonly credentialedRuntimeRevision?: string } = {},
): EffectiveManagedToolPortalConfig {
	return effectiveManagedToolPortalConfigSchema.parse({
		...(config.$schema === undefined ? {} : { $schema: config.$schema }),
		agents: Object.fromEntries(
			Object.entries(config.agents).map(([agentId, agent]) => [
				agentId,
				{ profile: agent.profile },
			]),
		),
		...(options.credentialedRuntimeRevision === undefined
			? {}
			: { credentialedRuntimeRevision: options.credentialedRuntimeRevision }),
		mode: 'managed',
		profiles: Object.fromEntries(
			Object.entries(config.profiles).map(([profileId, profile]) => [
				profileId,
				{
					...(profile.catalogMode === undefined ? {} : { catalogMode: profile.catalogMode }),
					namespaces: Object.fromEntries(
						Object.entries(profile.namespaces).map(([namespaceId, namespacePolicy]) => [
							namespaceId,
							{
								...namespacePolicy,
								backend:
									namespacePolicy.backend.kind !== 'controller_execution'
										? namespacePolicy.backend
										: {
												kind: 'controller_execution',
												operations: Object.fromEntries(
													Object.entries(namespacePolicy.backend.operations).map(
														([operationName, operation]) => [
															operationName,
															operation.kind === 'configured_cli' &&
															operation.executionTarget.kind === 'controller_host'
																? operation
																: projectedConfiguredCliOperation(operation),
														],
													),
												),
											},
							},
						]),
					),
				},
			]),
		),
		schemaVersion: 1,
	});
}

export const gatewayRuntimeManagedToolPortalConfigSchema = z
	.object({
		agents: z.record(z.string().min(1), toolPortalAgentConfigSchema),
		mode: z.literal('managed'),
		profiles: z.record(z.string().min(1), gatewayRuntimeToolPortalProfileDefinitionSchema),
		schemaVersion: z.literal(1),
	})
	.strict();

export type GatewayRuntimeManagedToolPortalConfig = z.infer<
	typeof gatewayRuntimeManagedToolPortalConfigSchema
>;

export function createGatewayRuntimeManagedToolPortalConfig(
	config: EffectiveManagedToolPortalConfig,
): GatewayRuntimeManagedToolPortalConfig {
	return gatewayRuntimeManagedToolPortalConfigSchema.parse({
		agents: config.agents,
		mode: 'managed',
		profiles: Object.fromEntries(
			Object.entries(config.profiles).map(([profileId, profile]) => [
				profileId,
				{
					...(profile.catalogMode === undefined ? {} : { catalogMode: profile.catalogMode }),
					namespaces: Object.fromEntries(
						Object.entries(profile.namespaces).map(([namespaceId, namespacePolicy]) => [
							namespaceId,
							{
								...namespacePolicy,
								backend:
									namespacePolicy.backend.kind !== 'controller_execution'
										? namespacePolicy.backend
										: {
												kind: 'controller_execution',
												operations: Object.fromEntries(
													Object.entries(namespacePolicy.backend.operations).map(
														([operationName, operation]) => [
															operationName,
															operation.kind === 'registered_action' ||
															!('executionTarget' in operation)
																? operation
																: projectedConfiguredCliOperation(operation),
														],
													),
												),
											},
							},
						]),
					),
				},
			]),
		),
		schemaVersion: 1,
	});
}

export const toolPortalConfigSchema = z
	.discriminatedUnion('mode', [managedToolPortalConfigSchema, standaloneToolPortalConfigSchema])
	.superRefine((config, context) => {
		if (config.mode === 'standalone') {
			validateStandaloneToolPortalConfig(config, context);
			return;
		}
		if (Object.keys(config.profiles).length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'tool-portal.config.jsonc must define at least one profile.',
				path: ['profiles'],
			});
		}

		for (const [agentId, agentConfig] of Object.entries(config.agents)) {
			if (config.profiles[agentConfig.profile] === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Tool Portal agent "${agentId}" references missing profile "${agentConfig.profile}".`,
					path: ['agents', agentId, 'profile'],
				});
			}
		}

		if (config.mode === 'managed') {
			for (const [agentId, agentConfig] of Object.entries(config.agents)) {
				const profile = config.profiles[agentConfig.profile];
				if (profile === undefined) continue;
				for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
					if (namespacePolicy.backend.kind !== 'controller_execution') continue;
					for (const [operationName, operation] of Object.entries(
						namespacePolicy.backend.operations,
					)) {
						if (!toolPortalNamespaceAllowsOperation(namespacePolicy, operationName)) continue;
						if (
							operation.kind !== 'configured_cli' ||
							operation.executionTarget.kind !== 'ephemeral_managed_vm'
						) {
							continue;
						}
						const target = operation.executionTarget;
						const projection = target.credentialProjection;
						if (projection.kind !== 'file_binding') continue;
						const binding = agentConfig.credentialBindings?.[projection.credentialBinding];
						if (binding === undefined) {
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Tool Portal agent "${agentId}" is missing credential binding "${projection.credentialBinding}" required by configured operation "${operationName}".`,
								path: ['agents', agentId, 'credentialBindings', projection.credentialBinding],
							});
							continue;
						}
						for (const [mappingIndex, mapping] of projection.credentialFiles.entries()) {
							if (binding.files[mapping.source] !== undefined) continue;
							context.addIssue({
								code: z.ZodIssueCode.custom,
								message: `Configured operation "${operationName}" references missing credential source "${mapping.source}" for agent "${agentId}".`,
								path: [
									'profiles',
									agentConfig.profile,
									'namespaces',
									namespaceId,
									'backend',
									'operations',
									operationName,
									'executionTarget',
									'credentialProjection',
									'credentialFiles',
									mappingIndex,
									'source',
								],
							});
						}
					}
				}
			}
		}

		if (config.mode === 'managed') {
			for (const [profileId, profile] of Object.entries(config.profiles)) {
				for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
					if (
						namespacePolicy.backend.kind !== 'tool_vm_runner' &&
						namespacePolicy.backend.kind !== 'controller_execution'
					) {
						continue;
					}
					const operationNames = new Set(Object.keys(namespacePolicy.backend.operations));
					const selectors = [
						[['tools'], namespacePolicy.tools] as const,
						...('source' in namespacePolicy.calls
							? []
							: [
									[['calls', 'requiresApproval'], namespacePolicy.calls.requiresApproval] as const,
									[['calls', 'withoutApproval'], namespacePolicy.calls.withoutApproval] as const,
								]),
					];
					for (const [selectorPath, selector] of selectors) {
						const explicitNames = [
							...(selector.allow === '*' ? [] : selector.allow),
							...selector.deny,
						];
						for (const operationName of explicitNames) {
							if (!operationNames.has(operationName)) {
								context.addIssue({
									code: z.ZodIssueCode.custom,
									message: `${namespacePolicy.backend.kind} selector references missing operation "${operationName}".`,
									path: ['profiles', profileId, 'namespaces', namespaceId, ...selectorPath],
								});
							}
						}
					}
				}
			}
		}
	});

export type ToolPortalConfig = ManagedToolPortalConfig | StandaloneToolPortalConfig;

export async function loadToolPortalConfig(configPath: string): Promise<ToolPortalConfig> {
	return toolPortalConfigSchema.parse(await loadJsonConfigFile(configPath));
}
