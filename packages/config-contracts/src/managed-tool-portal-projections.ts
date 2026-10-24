import {
	toolPortalCallPolicySchema,
	toolPortalNamespaceCallPolicySchema,
	toolPortalToolSelectorSchema,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import type {
	EffectiveManagedToolPortalConfig,
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalConfig,
} from './tool-portal-config.js';
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

export const ToolPortalControllerExecutionProjectionNamespaceSchema = z
	.object({
		calls: toolPortalNamespaceCallPolicySchema,
		tools: toolPortalToolSelectorSchema,
	})
	.strict();

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

	const namespaces: Record<string, unknown> = {};
	for (const namespace of Object.keys(profileConfig.namespaces)) {
		const namespacePolicy = profileConfig.namespaces[namespace];
		if (namespacePolicy?.backend.kind !== 'mcp_provider') continue;
		namespaces[namespace] = { calls: namespacePolicy.calls, tools: namespacePolicy.tools };
	}

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

	const namespaces: Record<string, unknown> = {};
	for (const namespace of Object.keys(profileConfig.namespaces)) {
		const namespacePolicy = profileConfig.namespaces[namespace];
		if (namespacePolicy?.backend.kind !== 'controller_execution') continue;
		namespaces[namespace] = { calls: namespacePolicy.calls, tools: namespacePolicy.tools };
	}

	return ToolPortalControllerExecutionProjectionSchema.parse({
		agentId: props.agentId,
		namespaces,
		profile: agentConfig.profile,
	});
}
