import { z } from 'zod';

import {
	configuredCliAllowedCommandSchema,
	configuredCliInvocationCallPolicySchema,
	configuredCliPatternRuleSchema,
	configuredCliStdinPolicySchema,
	configuredCliTimeoutPolicySchema,
	controllerExecutionOperationSchema,
	controllerRegisteredOperationSchema,
	effectiveControllerExecutionOperationSchema,
} from './controller-configured-cli.js';
import { loadJsonConfigFile } from './json-config-file.js';
import { namespaceDiscoverySchema } from './mcp-config.js';
import { secretValueSchema } from './secret-value.js';

export const toolPortalToolSelectorSchema = z
	.object({
		allow: z.union([z.literal('*'), z.array(z.string().min(1))]),
		deny: z.array(z.string().min(1)).default([]),
	})
	.strict();

export type ToolPortalToolSelector = z.infer<typeof toolPortalToolSelectorSchema>;

export const toolPortalCallPolicySchema = z
	.object({
		requiresApproval: toolPortalToolSelectorSchema,
		withoutApproval: toolPortalToolSelectorSchema,
	})
	.strict()
	.superRefine((policy, context) => {
		if (toolSelectorsOverlap(policy.requiresApproval, policy.withoutApproval)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Tool Portal call policy cannot list one tool in both approval selectors.',
				path: ['withoutApproval'],
			});
		}
	});

export type ToolPortalCallPolicy = z.infer<typeof toolPortalCallPolicySchema>;

export const toolPortalBackendKindSchema = z.enum([
	'mcp_provider',
	'controller_execution',
	'tool_vm_runner',
]);

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

export type ToolPortalBackendKind = z.infer<typeof toolPortalBackendKindSchema>;
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
		backend: toolPortalControllerExecutionBackendBindingSchema,
		discovery: namespaceDiscoverySchema.default({}),
	})
	.strict();

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
		namespaces: z.record(z.string().min(1), toolPortalNamespacePolicySchema).default({}),
	})
	.strict();

export type ToolPortalProfileDefinition = z.infer<typeof toolPortalProfileDefinitionSchema>;

export const toolPortalAgentConfigSchema = z
	.object({
		profile: z.string().min(1),
	})
	.strict();

export type ToolPortalAgentConfig = z.infer<typeof toolPortalAgentConfigSchema>;

export const toolPortalStandaloneAgentAuthenticationSchema = z
	.object({
		approvalHmacKey: secretValueSchema,
		bearerKey: secretValueSchema,
		credentialVersion: z.number().int().positive(),
	})
	.strict();

export type ToolPortalStandaloneAgentAuthentication = z.infer<
	typeof toolPortalStandaloneAgentAuthenticationSchema
>;

export const toolPortalStandaloneAuthenticationSchema = z
	.object({
		agents: z.record(z.string().min(1), toolPortalStandaloneAgentAuthenticationSchema),
	})
	.strict();

export type ToolPortalStandaloneAuthentication = z.infer<
	typeof toolPortalStandaloneAuthenticationSchema
>;

export const toolPortalNetworkAddressSchema = z
	.object({
		host: z.string().min(1),
		port: z.number().int().min(1).max(65_535),
	})
	.strict();

export type ToolPortalNetworkAddress = z.infer<typeof toolPortalNetworkAddressSchema>;

const toolPortalBearerEntrypointAuthenticationSchema = z
	.object({
		kind: z.literal('bearer'),
	})
	.strict();

const toolPortalEntrypointRouteSchema = z
	.string()
	.min(1)
	.refine((route) => route.startsWith('/'), {
		message: 'Tool Portal entrypoint routes must start with "/".',
	});

export const toolPortalHttpEntrypointSchema = z
	.object({
		address: toolPortalNetworkAddressSchema,
		allowedHosts: z.array(z.string().min(1)).min(1),
		allowedOrigins: z.array(z.string().url()),
		authentication: toolPortalBearerEntrypointAuthenticationSchema,
		enabled: z.literal(true),
		route: toolPortalEntrypointRouteSchema,
	})
	.strict();

export type ToolPortalHttpEntrypoint = z.infer<typeof toolPortalHttpEntrypointSchema>;

export const toolPortalMcpEntrypointSchema = z
	.object({
		address: toolPortalNetworkAddressSchema,
		allowedHosts: z.array(z.string().min(1)).min(1),
		allowedOrigins: z.array(z.string().url()),
		authentication: toolPortalBearerEntrypointAuthenticationSchema,
		enabled: z.literal(true),
		route: toolPortalEntrypointRouteSchema,
		transport: z.literal('streamable-http'),
	})
	.strict();

export type ToolPortalMcpEntrypoint = z.infer<typeof toolPortalMcpEntrypointSchema>;

export const toolPortalStdioEntrypointSchema = z
	.object({
		authentication: z
			.object({
				agentId: z.string().min(1),
				kind: z.literal('scoped-principal'),
			})
			.strict(),
		enabled: z.literal(true),
	})
	.strict();

export type ToolPortalStdioEntrypoint = z.infer<typeof toolPortalStdioEntrypointSchema>;

export const toolPortalStandaloneEntrypointsSchema = z
	.object({
		http: toolPortalHttpEntrypointSchema.optional(),
		mcp: toolPortalMcpEntrypointSchema.optional(),
		stdio: toolPortalStdioEntrypointSchema.optional(),
	})
	.strict();

export type ToolPortalStandaloneEntrypoints = z.infer<typeof toolPortalStandaloneEntrypointsSchema>;

const toolPortalCommonConfigShape = {
	$schema: z.string().min(1).optional(),
	agents: z.record(z.string().min(1), toolPortalAgentConfigSchema).default({}),
	profiles: z.record(z.string().min(1), toolPortalProfileDefinitionSchema),
	schemaVersion: z.literal(1),
} as const;

export const managedToolPortalConfigSchema = z
	.object({
		...toolPortalCommonConfigShape,
		mode: z.literal('managed'),
	})
	.strict();

export type ManagedToolPortalConfig = z.infer<typeof managedToolPortalConfigSchema>;

const effectiveToolPortalControllerExecutionBackendBindingSchema = z
	.object({
		kind: z.literal('controller_execution'),
		operations: z
			.record(z.string().min(1), effectiveControllerExecutionOperationSchema)
			.refine((operations) => Object.keys(operations).length > 0),
	})
	.strict();

const effectiveToolPortalBackendBindingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('mcp_provider') }).strict(),
	effectiveToolPortalControllerExecutionBackendBindingSchema,
	toolPortalSandboxSshBackendBindingSchema,
]);

const effectiveToolPortalNamespacePolicySchema = z
	.object({
		backend: effectiveToolPortalBackendBindingSchema,
		calls: toolPortalCallPolicySchema,
		discovery: namespaceDiscoverySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict();

const effectiveToolPortalProfileDefinitionSchema = z
	.object({
		namespaces: z.record(z.string().min(1), effectiveToolPortalNamespacePolicySchema),
	})
	.strict();

export const effectiveManagedToolPortalConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		agents: z.record(z.string().min(1), toolPortalAgentConfigSchema).default({}),
		mode: z.literal('managed'),
		profiles: z.record(z.string().min(1), effectiveToolPortalProfileDefinitionSchema),
		schemaVersion: z.literal(1),
	})
	.strict();

export type EffectiveManagedToolPortalConfig = z.infer<
	typeof effectiveManagedToolPortalConfigSchema
>;

export const gatewayRuntimeConfiguredCliOperationSchema = z
	.object({
		calls: configuredCliInvocationCallPolicySchema,
		commands: z.array(configuredCliAllowedCommandSchema).min(1),
		deniedPatterns: z.array(configuredCliPatternRuleSchema),
		kind: z.literal('configured_cli'),
		safeHelp: z.string().min(1).max(4_000),
		stdin: configuredCliStdinPolicySchema,
		targetKind: z.enum(['controller_host', 'ephemeral_managed_vm']),
		timeout: configuredCliTimeoutPolicySchema,
	})
	.strict();

export const gatewayRuntimeControllerExecutionOperationSchema = z.discriminatedUnion('kind', [
	controllerRegisteredOperationSchema,
	gatewayRuntimeConfiguredCliOperationSchema,
]);

export type GatewayRuntimeControllerExecutionOperation = z.infer<
	typeof gatewayRuntimeControllerExecutionOperationSchema
>;

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
		calls: toolPortalCallPolicySchema,
		discovery: namespaceDiscoverySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict();

const gatewayRuntimeToolPortalProfileDefinitionSchema = z
	.object({
		namespaces: z.record(z.string().min(1), gatewayRuntimeToolPortalNamespacePolicySchema),
	})
	.strict();

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

function recordEntries<TValue>(
	record: Readonly<Record<string, TValue>>,
): readonly (readonly [string, TValue])[] {
	return Object.entries(record);
}

type GatewayRuntimeConfigSourceProfile = EffectiveManagedToolPortalConfig['profiles'][string];
type GatewayRuntimeConfigSourceNamespacePolicy =
	GatewayRuntimeConfigSourceProfile['namespaces'][string];

export function createGatewayRuntimeManagedToolPortalConfig(
	config: EffectiveManagedToolPortalConfig,
): GatewayRuntimeManagedToolPortalConfig {
	return gatewayRuntimeManagedToolPortalConfigSchema.parse({
		agents: config.agents,
		mode: 'managed',
		profiles: Object.fromEntries(
			recordEntries<GatewayRuntimeConfigSourceProfile>(config.profiles).map(
				([profileId, profile]) => [
					profileId,
					{
						namespaces: Object.fromEntries(
							recordEntries<GatewayRuntimeConfigSourceNamespacePolicy>(profile.namespaces).map(
								([namespaceId, namespacePolicy]) => [
									namespaceId,
									{
										...namespacePolicy,
										backend:
											namespacePolicy.backend.kind !== 'controller_execution'
												? namespacePolicy.backend
												: {
														kind: 'controller_execution',
														operations: Object.fromEntries(
															recordEntries(namespacePolicy.backend.operations).map(
																([operationName, operation]) => [
																	operationName,
																	operation.kind === 'registered_action'
																		? operation
																		: {
																				calls: operation.calls,
																				commands: operation.commands,
																				deniedPatterns: operation.deniedPatterns,
																				kind: operation.kind,
																				safeHelp: operation.safeHelp,
																				stdin: operation.stdin,
																				targetKind: operation.executionTarget.kind,
																				timeout: operation.timeout,
																			},
																],
															),
														),
													},
									},
								],
							),
						),
					},
				],
			),
		),
		schemaVersion: 1,
	});
}

export const standaloneToolPortalConfigSchema = z
	.object({
		...toolPortalCommonConfigShape,
		authentication: toolPortalStandaloneAuthenticationSchema,
		drain: z
			.object({
				timeoutMs: z.number().int().positive(),
			})
			.strict(),
		entrypoints: toolPortalStandaloneEntrypointsSchema,
		mode: z.literal('standalone'),
	})
	.strict();

export type StandaloneToolPortalConfig = z.infer<typeof standaloneToolPortalConfigSchema>;

export const toolPortalConfigSchema = z
	.discriminatedUnion('mode', [managedToolPortalConfigSchema, standaloneToolPortalConfigSchema])
	.superRefine((config, context) => {
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

		for (const [profileId, profile] of Object.entries(config.profiles)) {
			for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
				if (
					namespacePolicy.backend.kind !== 'tool_vm_runner' &&
					namespacePolicy.backend.kind !== 'controller_execution'
				) {
					continue;
				}
				const operationNames = new Set(Object.keys(namespacePolicy.backend.operations));
				for (const [selectorPath, selector] of [
					[['tools'], namespacePolicy.tools],
					[['calls', 'requiresApproval'], namespacePolicy.calls.requiresApproval],
					[['calls', 'withoutApproval'], namespacePolicy.calls.withoutApproval],
				] as const) {
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

		if (config.mode !== 'standalone') {
			return;
		}

		for (const [profileId, profile] of Object.entries(config.profiles)) {
			for (const [namespaceId, namespacePolicy] of Object.entries(profile.namespaces)) {
				if (namespacePolicy.backend.kind === 'mcp_provider') {
					continue;
				}
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Standalone Tool Portal version 1 does not admit the privileged "${namespacePolicy.backend.kind}" backend.`,
					path: ['profiles', profileId, 'namespaces', namespaceId, 'backend', 'kind'],
				});
			}
		}

		const configuredAgentIds = Object.keys(config.agents);
		if (configuredAgentIds.length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Standalone Tool Portal must define at least one agent.',
				path: ['agents'],
			});
		}

		for (const configuredAgentId of configuredAgentIds) {
			if (config.authentication.agents[configuredAgentId] === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Standalone Tool Portal agent "${configuredAgentId}" is missing authentication material.`,
					path: ['authentication', 'agents', configuredAgentId],
				});
			}
		}

		for (const authenticatedAgentId of Object.keys(config.authentication.agents)) {
			if (config.agents[authenticatedAgentId] === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Standalone Tool Portal authentication references unknown agent "${authenticatedAgentId}".`,
					path: ['authentication', 'agents', authenticatedAgentId],
				});
			}
		}

		if (Object.values(config.entrypoints).every((entrypoint) => entrypoint === undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Standalone Tool Portal must explicitly enable at least one entrypoint.',
				path: ['entrypoints'],
			});
		}

		const stdioAgentId = config.entrypoints.stdio?.authentication.agentId;
		if (stdioAgentId !== undefined && config.agents[stdioAgentId] === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Standalone Tool Portal stdio principal references unknown agent "${stdioAgentId}".`,
				path: ['entrypoints', 'stdio', 'authentication', 'agentId'],
			});
		}
	});

export type ToolPortalConfig = z.infer<typeof toolPortalConfigSchema>;

export async function loadToolPortalConfig(configPath: string): Promise<ToolPortalConfig> {
	return toolPortalConfigSchema.parse(await loadJsonConfigFile(configPath));
}

export const ToolPortalMcpProjectionNamespaceSchema = z
	.object({
		calls: toolPortalCallPolicySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict();

export type ToolPortalMcpProjectionNamespace = z.infer<
	typeof ToolPortalMcpProjectionNamespaceSchema
>;

export const ToolPortalMcpProjectionSchema = z
	.object({
		agentId: z.string().min(1),
		namespaces: z.record(z.string().min(1), ToolPortalMcpProjectionNamespaceSchema),
		profile: z.string().min(1),
	})
	.strict();

export type ToolPortalMcpProjection = z.infer<typeof ToolPortalMcpProjectionSchema>;

export const ToolPortalControllerExecutionProjectionNamespaceSchema =
	ToolPortalMcpProjectionNamespaceSchema;

export type ToolPortalControllerExecutionProjectionNamespace = z.infer<
	typeof ToolPortalControllerExecutionProjectionNamespaceSchema
>;

export const ToolPortalControllerExecutionProjectionSchema = z
	.object({
		agentId: z.string().min(1),
		namespaces: z.record(z.string().min(1), ToolPortalControllerExecutionProjectionNamespaceSchema),
		profile: z.string().min(1),
	})
	.strict();

export type ToolPortalControllerExecutionProjection = z.infer<
	typeof ToolPortalControllerExecutionProjectionSchema
>;

export interface CreateToolPortalMcpProjectionProps {
	readonly agentId: string;
	readonly config:
		| EffectiveManagedToolPortalConfig
		| GatewayRuntimeManagedToolPortalConfig
		| ToolPortalConfig;
}

export function createToolPortalMcpProjection(
	props: CreateToolPortalMcpProjectionProps,
): ToolPortalMcpProjection {
	const agentConfig = props.config.agents[props.agentId];
	if (agentConfig === undefined) {
		throw new Error(`Tool Portal agent "${props.agentId}" is not configured.`);
	}

	const profileConfig = props.config.profiles[agentConfig.profile];
	if (profileConfig === undefined) {
		throw new Error(
			`Tool Portal agent "${props.agentId}" references missing profile "${agentConfig.profile}".`,
		);
	}

	const namespaces = Object.fromEntries(
		Object.entries(profileConfig.namespaces)
			.filter(([, namespacePolicy]) => namespacePolicy.backend.kind === 'mcp_provider')
			.map(([namespace, namespacePolicy]) => [
				namespace,
				{
					calls: namespacePolicy.calls,
					tools: namespacePolicy.tools,
				},
			]),
	);

	return ToolPortalMcpProjectionSchema.parse({
		agentId: props.agentId,
		namespaces,
		profile: agentConfig.profile,
	});
}

export interface CreateToolPortalControllerExecutionProjectionProps {
	readonly agentId: string;
	readonly config:
		| EffectiveManagedToolPortalConfig
		| GatewayRuntimeManagedToolPortalConfig
		| ToolPortalConfig;
}

export function createToolPortalControllerExecutionProjection(
	props: CreateToolPortalControllerExecutionProjectionProps,
): ToolPortalControllerExecutionProjection {
	const agentConfig = props.config.agents[props.agentId];
	if (agentConfig === undefined) {
		throw new Error(`Tool Portal agent "${props.agentId}" is not configured.`);
	}

	const profileConfig = props.config.profiles[agentConfig.profile];
	if (profileConfig === undefined) {
		throw new Error(
			`Tool Portal agent "${props.agentId}" references missing profile "${agentConfig.profile}".`,
		);
	}

	const namespaces = Object.fromEntries(
		Object.entries(profileConfig.namespaces)
			.filter(([, namespacePolicy]) => namespacePolicy.backend.kind === 'controller_execution')
			.map(([namespace, namespacePolicy]) => [
				namespace,
				{
					calls: namespacePolicy.calls,
					tools: namespacePolicy.tools,
				},
			]),
	);

	return ToolPortalControllerExecutionProjectionSchema.parse({
		agentId: props.agentId,
		namespaces,
		profile: agentConfig.profile,
	});
}

function toolSelectorsOverlap(
	left: ToolPortalToolSelector,
	right: ToolPortalToolSelector,
): boolean {
	const leftAllow = left.allow;
	const rightAllow = right.allow;
	if (leftAllow === '*' && rightAllow === '*') {
		return true;
	}
	if (leftAllow === '*') {
		if (rightAllow === '*') {
			return true;
		}
		return rightAllow.some((toolName) => !left.deny.includes(toolName));
	}
	if (rightAllow === '*') {
		return leftAllow.some((toolName) => !right.deny.includes(toolName));
	}
	return leftAllow.some(
		(toolName) =>
			rightAllow.includes(toolName) &&
			!left.deny.includes(toolName) &&
			!right.deny.includes(toolName),
	);
}
