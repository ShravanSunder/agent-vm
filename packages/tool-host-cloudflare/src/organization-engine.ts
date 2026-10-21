import {
	createPortalAgentIdentity,
	portalAgentScopeKey,
	mcpPortalCallPolicyDecision,
} from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	jsonValueSchema,
	type JsonObject,
} from '@agent-collaboration/tool-access/contracts';
import {
	createUpstreamMcpClientRuntime,
	type UpstreamMcpClientRuntime,
} from '@agent-collaboration/tool-engine/connectors';
import type {
	ApprovalPort,
	BackendKind,
	ToolBackend,
	DispatchInvocation,
	ResourceResult,
} from '@agent-collaboration/tool-engine/dispatch';
import {
	createMcpGateway,
	createPortalSessionManager,
	portalToolRecordSchema,
	type ConsumeApprovalTokenId,
	type McpGateway,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { z } from 'zod';

import { assessedProxyProfile, resolveWorkerProxyProfile } from '#worker-host/proxy-profile-policy';
import { createRequestOperationEntries } from '#worker-host/request-operation-entries';
import type {
	OrganizationConfiguration,
	WorkerSecretBindings,
} from '#worker-host/worker-configuration';
import { mcpConfigToResolvedProviders } from '#worker-host/worker-mcp-configuration';
import { formatSecretValue } from '#worker-host/worker-secret-values';
import { createWorkerUpstreamTransport } from '#worker-host/worker-upstream-transports';

export interface OrganizationEngine {
	readonly configuration: OrganizationConfiguration;
	readonly trustedTool: (namespace: string, toolName: string) => boolean;
	readonly requiresApproval: (agentId: string, namespace: string, toolName: string) => boolean;
	readonly gatewayFor: (props: {
		readonly agentClientId: string;
		readonly consumeTokenId: ConsumeApprovalTokenId;
		readonly invoke?: (
			invocation: DispatchInvocation,
			call: () => Promise<unknown>,
		) => Promise<ResourceResult>;
	}) => { readonly gateway: McpGateway; readonly close: () => Promise<void> };
}
const unavailableApproval: ApprovalPort = {
	challenge: async () => ({ kind: 'unavailable' }),
	receipt: async () => ({ kind: 'unavailable' }),
	decision: async () => ({ kind: 'unavailable' }),
};

/** One instance owns one organization's configuration, key and plain-data catalog. */
export async function createOrganizationEngine(props: {
	readonly organizationId: string;
	readonly configuration: OrganizationConfiguration;
	readonly secrets: WorkerSecretBindings;
}): Promise<OrganizationEngine> {
	const { configuration } = props;
	const rawSecrets: string[] = [];
	const providers = mcpConfigToResolvedProviders(configuration.mcp).map((provider) => {
		if (provider.transport === 'stdio') throw new Error('Worker tool servers require HTTP.');
		const headers = Object.fromEntries(
			Object.entries(provider.headers).map(([headerName, secret]) => {
				if (secret.source !== 'environment')
					throw new Error('Worker secrets require a Worker binding.');
				const value = props.secrets.read(secret.name);
				rawSecrets.push(value);
				return [headerName, formatSecretValue(secret, value)];
			}),
		);
		return {
			namespace: provider.namespace,
			transport: provider.transport,
			url: provider.url,
			headers,
			...(provider.connectionTimeoutMs === undefined
				? {}
				: { connectionTimeoutMs: provider.connectionTimeoutMs }),
		};
	});
	const approvalKeyHex = z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.parse(props.secrets.read(configuration.approvalKeyBinding));
	const approvalKey = Uint8Array.from(approvalKeyHex.match(/../gu) ?? [], (pair) =>
		Number.parseInt(pair, 16),
	);
	function createRequestRuntime(): UpstreamMcpClientRuntime {
		return createUpstreamMcpClientRuntime({
			servers: providers,
			additionalRedactionValues: rawSecrets,
			createUpstreamMcpTransport: createWorkerUpstreamTransport,
			maxResponseBytes: 4 * 1024 * 1024,
		});
	}
	// Discovery is request-local I/O; only its plain catalog survives the request.
	const discoveryRuntime = createRequestRuntime();
	const catalogByNamespace = await (async () => {
		try {
			return new Map(
				await Promise.all(
					providers.map(
						async (provider) =>
							[
								provider.namespace,
								await discoveryRuntime.listTools({
									namespace: provider.namespace,
									agentScopeId: '$organization-catalog',
								}),
							] as const,
					),
				),
			);
		} finally {
			await discoveryRuntime.closeAgentScope('$organization-catalog');
		}
	})();
	const catalogRuntime = {
		listTools: async ({ namespace }: { readonly namespace: string }) =>
			catalogByNamespace.get(namespace) ?? [],
		closeAgentScope: async (): Promise<void> => {},
	};
	const sessions = createPortalSessionManager({
		runtime: catalogRuntime,
		catalogTtlMs: Number.MAX_SAFE_INTEGER,
		upstreamNamespaces: providers.map((provider) => provider.namespace),
		accessPolicy: {
			enabledNamespaces: providers.map((provider) => provider.namespace),
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
	});
	const revision = { owner: props.organizationId, revision: 'deployed-v1' };
	return {
		configuration,
		trustedTool: (namespace, toolName) =>
			catalogByNamespace.get(namespace)?.some((tool) => tool.name === toolName) === true,
		requiresApproval: (agentId, namespace, toolName) => {
			const assignment = configuration.portal.agents[agentId];
			const profile =
				assignment === undefined ? undefined : configuration.portal.profiles[assignment.profile];
			const tool = catalogByNamespace.get(namespace)?.find((entry) => entry.name === toolName);
			return (
				profile !== undefined &&
				mcpPortalCallPolicyDecision(resolveWorkerProxyProfile(profile), {
					namespace,
					toolName,
					...(tool?.annotations === undefined ? {} : { annotations: tool.annotations }),
				}).kind === 'requires_approval'
			);
		},
		gatewayFor: ({ agentClientId, consumeTokenId, invoke }) => {
			const assignment = configuration.portal.agents[agentClientId];
			const profile =
				assignment === undefined ? undefined : configuration.portal.profiles[assignment.profile];
			if (profile === undefined || assignment === undefined)
				throw new Error('Agent profile unavailable.');
			const resolvedProfile = resolveWorkerProxyProfile(profile);
			const identity = createPortalAgentIdentity({
				agentId: agentClientId,
				agentScopeId: agentClientId,
				source: 'mcp-proxy-bearer',
			});
			const scope = portalAgentScopeKey(identity);
			const runtime = createRequestRuntime();
			const backend: ToolBackend<BackendKind> = {
				backendKind: 'mcp_provider',
				list: async () => ({}),
				search: async () => ({}),
				describe: async () => ({}),
				invoke: async (invocation) => {
					const call = async (): Promise<unknown> =>
						runtime.callTool({
							agentScopeId: scope,
							namespace: invocation.capability.namespace,
							toolName: invocation.capability.tool,
							arguments: invocation.arguments satisfies JsonObject,
							requestId: invocation.operationKey.item,
						});
					return invoke === undefined
						? { kind: 'completed', result: jsonValueSchema.parse(await call()) }
						: invoke(invocation, call);
				},
			};
			const gateway = createMcpGateway({
				caller: {
					identity,
					authority: props.organizationId,
					principal: agentClientId,
					verifiedContextRef: agentClientId,
				},
				hostBinding: { workspaceLayer: 'not-configured', config: revision },
				sessions,
				operations: createRequestOperationEntries(),
				approvals: unavailableApproval,
				approvalTokens: { key: approvalKey, consumeTokenId },
				prepareCatalog: async (catalog) => catalog,
				backends: new Map([['mcp_provider', backend]]),
				now: Date.now,
				resolveAccess: async ({ capability, call }) => {
					const descriptor = catalogByNamespace
						.get(capability.namespace)
						?.find((tool) => tool.name === capability.tool);
					return assessAccessInput.parse({
						capability,
						call,
						surface: 'mcp',
						facts: {
							workspace: { kind: 'not-configured' },
							assignment: {
								revision,
								profileRevision: revision,
								profile: assessedProxyProfile({
									profileId: assignment.profile,
									profile,
									resolved: resolvedProfile,
									capability,
									tool:
										descriptor === undefined
											? undefined
											: portalToolRecordSchema.parse({
													inputSchema: descriptor.inputSchema,
													...(descriptor.annotations === undefined
														? {}
														: { annotations: descriptor.annotations }),
													namespace: capability.namespace,
													toolName: descriptor.name,
												}),
								}),
							},
							surface: { eligible: ['mcp'], snapshot: revision },
							accounts: [],
							upstream: { status: 'available', credentialNeed: 'none', binding: revision },
						},
					});
				},
			});
			return { gateway, close: async () => runtime.closeAgentScope(scope) };
		},
	};
}
