import { createHash } from 'node:crypto';

import type { PortalCallRequest } from '@agent-vm/agent-portal-sdk';
import {
	createToolPortalMcpProjection,
	type GatewayRuntimeManagedToolPortalConfig,
	type ManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
} from '@agent-vm/gateway-control-contracts';
import type {
	ToolPortalBackendPort,
	ToolPortalInvocationOptions,
} from '@agent-vm/gateway-runtime/managed-tool-engine/models/managed-portal-ports.js';

import type {
	ManagedMcpProviderBackendFactory,
	McpProviderCapabilityBackend,
} from '#gateway-runtime/backends/managed-mcp-provider-backend';
export interface CreateManagedToolPortalMcpProviderBackendPortProps {
	readonly backendFactory: ManagedMcpProviderBackendFactory;
	readonly mode: 'managed';
	readonly toolPortalConfig: GatewayRuntimeManagedToolPortalConfig | ManagedToolPortalConfig;
}
function digestSessionIdentity(props: {
	readonly identitySegments: readonly (number | string)[];
	readonly mode: 'managed';
}): string {
	const digest = createHash('sha256')
		.update(JSON.stringify(props.identitySegments), 'utf8')
		.digest('base64url');
	return `tool-portal:${props.mode}:mcp:${digest}`;
}

function managedProviderPoolKey(options: ToolPortalInvocationOptions): string {
	return digestSessionIdentity({
		identitySegments: [
			deriveGatewayControlStablePrincipal({ principal: options.trustedContext.principal }),
		],
		mode: 'managed',
	});
}

function providerBackendForInvocation(props: {
	readonly agentId: string;
	readonly backendFactory: ManagedMcpProviderBackendFactory;
	readonly sessionKey: string;
	readonly toolPortalConfig: GatewayRuntimeManagedToolPortalConfig | ManagedToolPortalConfig;
}): McpProviderCapabilityBackend {
	const projection = createToolPortalMcpProjection({
		agentId: props.agentId,
		config: props.toolPortalConfig,
	});
	return props.backendFactory.createBackend(projection, {
		portalAgentScopeSource: 'tool-portal-service',
		sessionKey: props.sessionKey,
	});
}

function operationIdsByCallId(props: {
	readonly operationId: string;
	readonly request: PortalCallRequest;
}): Readonly<Record<string, string>> {
	if (props.request.calls.length !== 1) {
		throw new Error('MCP provider dispatch authority requires exactly one capability call.');
	}
	const call = props.request.calls[0];
	if (call === undefined) {
		throw new Error('MCP provider dispatch authority requires one capability call.');
	}
	return { [call.id]: props.operationId };
}

function operationIdFromManagedDispatchAuthority(
	authority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'mcp_provider'>,
): string {
	switch (authority.kind) {
		case 'without-approval':
			return authority.operationId;
		case 'approval-grant':
			return authority.grant.operationId;
	}
	const unsupportedAuthority: never = authority;
	throw new Error(`Unsupported managed MCP-provider authority: ${String(unsupportedAuthority)}`);
}

export function createToolPortalMcpProviderBackendPort(
	props: CreateManagedToolPortalMcpProviderBackendPortProps,
): ToolPortalBackendPort<'mcp_provider'> {
	const backendForInvocation = (
		options: ToolPortalInvocationOptions,
	): McpProviderCapabilityBackend =>
		providerBackendForInvocation({
			agentId: options.trustedContext.principal.agentId,
			backendFactory: props.backendFactory,
			sessionKey: managedProviderPoolKey(options),
			toolPortalConfig: props.toolPortalConfig,
		});
	return {
		backendKind: 'mcp_provider',
		call: async (request, options) => {
			const suppliedOperationIdsByCallId = operationIdsByCallId({
				operationId: operationIdFromManagedDispatchAuthority(options.dispatchAuthority),
				request,
			});
			return await backendForInvocation(options).call(request, {
				managedDispatchAuthority: options.dispatchAuthority,
				operationIdsByCallId: suppliedOperationIdsByCallId,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		},
		describe: async (request, options) =>
			await backendForInvocation(options).describe(
				request,
				options.signal === undefined ? {} : { signal: options.signal },
			),
		list: async (request, options) =>
			await backendForInvocation(options).list(
				request,
				options.signal === undefined ? {} : { signal: options.signal },
			),
		search: async (request, options) =>
			await backendForInvocation(options).search(
				request,
				options.signal === undefined ? {} : { signal: options.signal },
			),
	};
}
