import { randomUUID } from 'node:crypto';

import {
	createPortalAgentIdentity,
	portalAgentScopeKey,
	type PortalAgentScopeSource,
} from '@agent-collaboration/tool-access/authorization';
import {
	mcpConfigSchema,
	type FormattedSecretValue,
	type McpConfig,
} from '@agent-collaboration/tool-access/contracts';
import { createAgentCatalogViewCache } from '@agent-collaboration/tool-engine/mcp-gateway';
import {
	createNodeProviderRuntime,
	createStandaloneMcpProviderBackend,
	loadMcpConfig,
	resolveUpstreamServers,
} from '@agent-collaboration/tool-host-node';
import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
	type PortalBackendDescribeResult,
	type PortalBackendListResult,
	type PortalBackendSearchResult,
	type PortalCallResult,
} from '@agent-vm/agent-portal-sdk';
import {
	ToolPortalMcpProjectionSchema,
	type ToolPortalMcpProjection,
} from '@agent-vm/config-contracts';
import type { GatewayRuntimeToolPortalDispatchAuthorityForBackendKind } from '@agent-vm/gateway-control-contracts';
import { z } from 'zod';
export interface McpProviderCapabilityBackendCallOptions {
	/** Trusted S2 handoff only; public call data never supplies dispatch authority. */
	readonly managedDispatchAuthority?: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'mcp_provider'>;
	readonly operationIdsByCallId?: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
}
export interface McpProviderCapabilityBackend {
	readonly call: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalCallResult>;
	readonly describe: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalBackendDescribeResult>;
	readonly list: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalBackendListResult>;
	readonly search: (
		request: unknown,
		options?: McpProviderCapabilityBackendCallOptions,
	) => Promise<PortalBackendSearchResult>;
}
export interface McpProviderBackendSessionOptions {
	readonly portalAgentScopeSource?: PortalAgentScopeSource;
	readonly sessionKey?: string;
}
export interface ManagedMcpProviderBackendFactory {
	readonly close: () => Promise<void>;
	readonly createBackend: (
		projection: ToolPortalMcpProjection,
		options?: McpProviderBackendSessionOptions,
	) => McpProviderCapabilityBackend;
	readonly retireSession: (sessionKey: string) => Promise<void>;
}
export interface CreateManagedMcpProviderBackendFactoryFromConfigProps {
	readonly mcpConfig: McpConfig;
	readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
}
export async function createManagedMcpProviderBackendFactory(props: {
	readonly mcpConfigPath: string;
	readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
}): Promise<ManagedMcpProviderBackendFactory> {
	return await createManagedMcpProviderBackendFactoryFromConfig({
		mcpConfig: await loadMcpConfig(props.mcpConfigPath),
		resolveSecret: props.resolveSecret,
	});
}
/** Managed session and policy projection; outbound MCP remains the existing Node connector. */
export async function createManagedMcpProviderBackendFactoryFromConfig(
	props: CreateManagedMcpProviderBackendFactoryFromConfigProps,
): Promise<ManagedMcpProviderBackendFactory> {
	const servers = await resolveUpstreamServers({
		config: mcpConfigSchema.parse(props.mcpConfig),
		resolveSecret: props.resolveSecret,
	});
	const runtime = createNodeProviderRuntime({ servers });
	const backends = new Map<string, McpProviderCapabilityBackend>();
	const retirements = new Map<string, Map<string, () => Promise<void>>>();
	const allRetirements = new Set<() => Promise<void>>();
	return {
		close: async () => {
			await Promise.all([...allRetirements].map(async (retire) => await retire()));
			allRetirements.clear();
			retirements.clear();
		},
		retireSession: async (sessionKey) => {
			const selected = retirements.get(sessionKey);
			retirements.delete(sessionKey);
			await Promise.all(
				[...(selected?.values() ?? [])].map(async (retire) => {
					allRetirements.delete(retire);
					await retire();
				}),
			);
		},
		createBackend: (input, options = {}) => {
			const projection = ToolPortalMcpProjectionSchema.parse(input);
			const backendKey = JSON.stringify([projection, options]);
			const retained = backends.get(backendKey);
			if (retained !== undefined) return retained;
			const identity = createPortalAgentIdentity({
				agentId: projection.agentId,
				agentScopeId: `mcp-provider:${projection.agentId}`,
				source: options.portalAgentScopeSource ?? 'managed-gateway-trusted',
				...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
			});
			const views = createAgentCatalogViewCache({
				accessPolicy: {
					enabledNamespaces: Object.keys(projection.namespaces),
					enabledNamespacesByAgent: {},
					enabledToolsByNamespaceByAgent: {
						[projection.agentId]: Object.fromEntries(
							Object.entries(projection.namespaces).flatMap(([namespace, policy]) =>
								policy.tools.allow === '*' ? [] : [[namespace, policy.tools.allow]],
							),
						),
					},
					hiddenToolsByAgent: {
						[projection.agentId]: Object.entries(projection.namespaces).flatMap(
							([namespace, policy]) =>
								policy.tools.deny.map((toolName) => ({ namespace, toolName })),
						),
					},
				},
				catalogTtlMs: 60000,
				upstreamNamespaces: servers.map((server) => server.namespace),
				runtime,
			});
			const retire = async (): Promise<void> => {
				backends.delete(backendKey);
				await views.invalidateView(identity);
			};
			allRetirements.add(retire);
			if (options.sessionKey !== undefined) {
				const session =
					retirements.get(options.sessionKey) ?? new Map<string, () => Promise<void>>();
				session.set(portalAgentScopeKey(identity), retire);
				retirements.set(options.sessionKey, session);
			}
			const backend = createStandaloneMcpProviderBackend<McpProviderCapabilityBackendCallOptions>({
				identity,
				getView: async () => await views.getView(identity),
				runtime,
				owningGeneration: options.sessionKey ?? `mcp-provider:${projection.agentId}`,
			});
			const managedBackend: McpProviderCapabilityBackend = {
				describe: async (request, readOptions = {}) =>
					await backend.discovery.describe(PortalDescribeRequestSchema.parse(request), readOptions),
				list: async (request, readOptions = {}) =>
					await backend.discovery.list(PortalListRequestSchema.parse(request), readOptions),
				search: async (request, readOptions = {}) =>
					await backend.discovery.search(PortalSearchRequestSchema.parse(request), readOptions),
				call: async (request, callOptions = {}) => {
					const parsed = PortalCallRequestSchema.parse(request);
					const supplied = callOptions.operationIdsByCallId;
					if (
						supplied !== undefined &&
						(Object.keys(supplied).length !== parsed.calls.length ||
							parsed.calls.some((call) => !z.uuid().safeParse(supplied[call.id]).success))
					)
						throw new Error(
							'MCP provider operation identity map must match request call ids exactly.',
						);
					const items = await Promise.all(
						parsed.calls.map(async (call) => {
							const operationId = supplied?.[call.id] ?? randomUUID();
							// S2/controller own approval binding and consumption. Carry their exact
							// single-call authority without widening the retained profile policy.
							const authority = callOptions.managedDispatchAuthority;
							const approvedDispatch =
								parsed.calls.length === 1 &&
								authority?.kind === 'approval-grant' &&
								authority.grant.operationId === operationId;
							const policy = projection.namespaces[call.namespace];
							const includes = (selector: {
								readonly allow: '*' | readonly string[];
								readonly deny: readonly string[];
							}): boolean =>
								!selector.deny.includes(call.name) &&
								(selector.allow === '*' || selector.allow.includes(call.name));
							if (
								policy === undefined ||
								!includes(policy.tools) ||
								(!includes(policy.calls.withoutApproval) &&
									!(includes(policy.calls.requiresApproval) && approvedDispatch))
							) {
								const code =
									policy !== undefined &&
									includes(policy.tools) &&
									includes(policy.calls.requiresApproval)
										? 'approval_required'
										: 'capability_denied';
								return {
									id: call.id,
									operationId,
									owningGeneration: options.sessionKey ?? `mcp-provider:${projection.agentId}`,
									status: 'error' as const,
									error: {
										code,
										message:
											code === 'approval_required'
												? `Ask operator to approve ${call.namespace}.${call.name}.`
												: `Capability ${call.namespace}.${call.name} is not allowed.`,
										safeDiagnostic: {
											code,
											level: code === 'approval_required' ? ('warn' as const) : ('error' as const),
											safeMessage:
												code === 'approval_required'
													? 'Operator approval is required.'
													: 'Requested capability is not allowed.',
										},
									},
									outcome: {
										kind: 'not-dispatched' as const,
										certainty: 'proven' as const,
										retryClass: 'safe-before-dispatch' as const,
									},
								};
							}
							return await backend.invoke(call, operationId, callOptions);
						}),
					);
					return PortalCallResultSchema.parse({
						items,
						ok: items.every((item) => item.status === 'ok'),
					});
				},
			};
			backends.set(backendKey, managedBackend);
			return managedBackend;
		},
	};
}
