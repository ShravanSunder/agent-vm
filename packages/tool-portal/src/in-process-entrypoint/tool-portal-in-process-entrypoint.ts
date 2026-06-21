import {
	PortalCallRequestSchema,
	type PortalCallResult,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-vm/agent-portal-sdk';
import {
	createToolPortalMcpProjection,
	toolPortalConfigSchema,
	type ToolPortalMcpProjection,
} from '@agent-vm/config-contracts';

export interface ToolPortalOperationOptions {
	readonly signal?: AbortSignal;
}

export interface ToolPortalCapabilityBackend {
	readonly call: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly list: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly search: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
}

export interface ToolPortalInProcessEntryPoint {
	readonly call: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly list: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
	readonly search: (
		request: unknown,
		options?: ToolPortalOperationOptions,
	) => Promise<PortalCallResult>;
}

export interface CreateToolPortalInProcessEntryPointProps {
	readonly agentId: string;
	readonly config: unknown;
	readonly createMcpBackend: (projection: ToolPortalMcpProjection) => ToolPortalCapabilityBackend;
}

export function createToolPortalInProcessEntryPoint(
	props: CreateToolPortalInProcessEntryPointProps,
): ToolPortalInProcessEntryPoint {
	const config = toolPortalConfigSchema.parse(props.config);
	const mcpProjection = createToolPortalMcpProjection({
		agentId: props.agentId,
		config,
	});
	const mcpBackend = props.createMcpBackend(mcpProjection);

	return {
		call: async (request, options) =>
			await mcpBackend.call(PortalCallRequestSchema.parse(request), options),
		describe: async (request, options) =>
			await mcpBackend.describe(PortalDescribeRequestSchema.parse(request), options),
		list: async (request, options) =>
			await mcpBackend.list(PortalListRequestSchema.parse(request), options),
		search: async (request, options) =>
			await mcpBackend.search(PortalSearchRequestSchema.parse(request), options),
	};
}
