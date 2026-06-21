import { z } from 'zod';

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

export const toolPortalBackendBindingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('mcp') }).strict(),
	z.object({ kind: z.literal('controller_host_action') }).strict(),
	z.object({ kind: z.literal('credentialed_runner') }).strict(),
]);

export type ToolPortalBackendBinding = z.infer<typeof toolPortalBackendBindingSchema>;

export const toolPortalCapabilityPolicySchema = z
	.object({
		backend: toolPortalBackendBindingSchema,
		calls: toolPortalCallPolicySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict();

export type ToolPortalCapabilityPolicy = z.infer<typeof toolPortalCapabilityPolicySchema>;

export const toolPortalProfileDefinitionSchema = z
	.object({
		capabilities: z.record(z.string().min(1), toolPortalCapabilityPolicySchema).default({}),
	})
	.strict();

export type ToolPortalProfileDefinition = z.infer<typeof toolPortalProfileDefinitionSchema>;

export const toolPortalAgentConfigSchema = z
	.object({
		profile: z.string().min(1),
	})
	.strict();

export type ToolPortalAgentConfig = z.infer<typeof toolPortalAgentConfigSchema>;

export const toolPortalConfigSchema = z
	.object({
		$schema: z.string().min(1).optional(),
		schemaVersion: z.literal(1),
		agents: z.record(z.string().min(1), toolPortalAgentConfigSchema).default({}),
		profiles: z.record(z.string().min(1), toolPortalProfileDefinitionSchema),
	})
	.strict()
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
	});

export type ToolPortalConfig = z.infer<typeof toolPortalConfigSchema>;

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

export interface CreateToolPortalMcpProjectionProps {
	readonly agentId: string;
	readonly config: ToolPortalConfig;
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
		Object.entries(profileConfig.capabilities)
			.filter(([, capabilityPolicy]) => capabilityPolicy.backend.kind === 'mcp')
			.map(([namespace, capabilityPolicy]) => [
				namespace,
				{
					calls: capabilityPolicy.calls,
					tools: capabilityPolicy.tools,
				},
			]),
	);

	return ToolPortalMcpProjectionSchema.parse({
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
