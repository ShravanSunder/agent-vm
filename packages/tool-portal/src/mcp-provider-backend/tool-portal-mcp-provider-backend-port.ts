import { createHash } from 'node:crypto';

import type { PortalCallRequest } from '@agent-vm/agent-portal-sdk';
import {
	createToolPortalMcpProjection,
	type GatewayRuntimeManagedToolPortalConfig,
	type ManagedToolPortalConfig,
	type StandaloneToolPortalConfig,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
} from '@agent-vm/gateway-control-contracts';
import type {
	ManagedMcpProviderBackendFactory,
	McpProviderCapabilityBackend,
} from '@agent-vm/mcp-portal/mcp-provider-backend';

import type {
	ToolPortalBackendPort,
	ToolPortalInvocationOptions,
	ToolPortalStandaloneMcpBackendInvocationOptions,
	ToolPortalStandaloneMcpBackendPort,
	ToolPortalStandaloneMcpBackendReadOptions,
	ToolPortalStandaloneMcpDispatchAuthority,
} from '../tool-portal-service.js';

export interface CreateManagedToolPortalMcpProviderBackendPortProps {
	readonly backendFactory: ManagedMcpProviderBackendFactory;
	readonly mode: 'managed';
	readonly toolPortalConfig: GatewayRuntimeManagedToolPortalConfig | ManagedToolPortalConfig;
}

export interface CreateStandaloneV1ToolPortalMcpProviderBackendPortProps {
	readonly backendFactory: ManagedMcpProviderBackendFactory;
	readonly mode: 'standalone-v1';
	readonly toolPortalConfig: StandaloneToolPortalConfig;
}

export type CreateToolPortalMcpProviderBackendPortProps =
	| CreateManagedToolPortalMcpProviderBackendPortProps
	| CreateStandaloneV1ToolPortalMcpProviderBackendPortProps;

function digestSessionIdentity(props: {
	readonly identitySegments: readonly (number | string)[];
	readonly mode: 'managed' | 'standalone-v1';
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

function standaloneProviderPoolKey(options: ToolPortalStandaloneMcpBackendReadOptions): string {
	const envelope = options.origin.authenticatedEnvelope;
	const principal = envelope.principal;
	return digestSessionIdentity({
		identitySegments: [
			envelope.audience,
			envelope.serviceGeneration,
			principal.agentId,
			principal.toolPortalProfileId,
			principal.profileAssignmentRevision,
			principal.credentialVersion,
			options.correlation.sessionId,
		],
		mode: 'standalone-v1',
	});
}

function providerBackendForInvocation(props: {
	readonly agentId: string;
	readonly backendFactory: ManagedMcpProviderBackendFactory;
	readonly sessionKey: string;
	readonly toolPortalConfig:
		| GatewayRuntimeManagedToolPortalConfig
		| ManagedToolPortalConfig
		| StandaloneToolPortalConfig;
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

function operationIdFromStandaloneDispatchAuthority(props: {
	readonly authority: ToolPortalStandaloneMcpDispatchAuthority;
	readonly options: ToolPortalStandaloneMcpBackendInvocationOptions;
}): string {
	switch (props.authority.kind) {
		case 'without-approval':
			return props.authority.operationId;
		case 'standalone-hmac-batch': {
			const matchingOperationIds = props.authority.approval.operationIds.filter(
				(operationId) => operationId === props.authority.operationId,
			);
			if (
				matchingOperationIds.length !== 1 ||
				props.authority.approval.serviceGeneration !==
					props.options.origin.authenticatedEnvelope.serviceGeneration
			) {
				throw new Error(
					'Standalone MCP provider authority must contain the exact protected batch operation.',
				);
			}
			return props.authority.operationId;
		}
	}
	const unsupportedAuthority: never = props.authority;
	throw new Error(`Unsupported standalone MCP-provider authority: ${String(unsupportedAuthority)}`);
}

function createManagedMcpProviderBackendPort(
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

function createStandaloneMcpProviderBackendPort(
	props: CreateStandaloneV1ToolPortalMcpProviderBackendPortProps,
): ToolPortalStandaloneMcpBackendPort {
	const backendForInvocation = (
		options: ToolPortalStandaloneMcpBackendReadOptions,
	): McpProviderCapabilityBackend =>
		providerBackendForInvocation({
			agentId: options.origin.authenticatedEnvelope.principal.agentId,
			backendFactory: props.backendFactory,
			sessionKey: standaloneProviderPoolKey(options),
			toolPortalConfig: props.toolPortalConfig,
		});
	return {
		backendKind: 'mcp_provider',
		call: async (request, options) => {
			const suppliedOperationIdsByCallId = operationIdsByCallId({
				operationId: operationIdFromStandaloneDispatchAuthority({
					authority: options.dispatchAuthority,
					options,
				}),
				request,
			});
			return await backendForInvocation(options).call(request, {
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

export function createToolPortalMcpProviderBackendPort(
	props: CreateManagedToolPortalMcpProviderBackendPortProps,
): ToolPortalBackendPort<'mcp_provider'>;
export function createToolPortalMcpProviderBackendPort(
	props: CreateStandaloneV1ToolPortalMcpProviderBackendPortProps,
): ToolPortalStandaloneMcpBackendPort;
export function createToolPortalMcpProviderBackendPort(
	props: CreateToolPortalMcpProviderBackendPortProps,
): ToolPortalBackendPort<'mcp_provider'> | ToolPortalStandaloneMcpBackendPort {
	switch (props.mode) {
		case 'managed':
			return createManagedMcpProviderBackendPort(props);
		case 'standalone-v1':
			return createStandaloneMcpProviderBackendPort(props);
	}
	const unsupportedProps: never = props;
	throw new Error(`Unsupported Tool Portal MCP-provider mode: ${String(unsupportedProps)}`);
}
