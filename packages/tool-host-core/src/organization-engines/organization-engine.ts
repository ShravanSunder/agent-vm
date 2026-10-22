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
import type {
	ApprovalPort,
	BackendKind,
	ToolBackend,
	ResourceResult,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import {
	createMcpGateway,
	createOrganizationToolCatalog,
	proxyUpstreamFailureFromError,
	createAgentCatalogViewCache,
	portalToolRecordSchema,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import {
	createUpstreamMcpClientRuntime,
	type UpstreamMcpClientRuntime,
	type UpstreamMcpRuntimeOptions,
} from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import { z } from 'zod';

import { mcpConfigToResolvedProviders } from '#tool-host-core/hosted-configuration/mcp-configuration';
import type {
	OrganizationConfiguration,
	SecretSource,
} from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { formatSecretValue } from '#tool-host-core/hosted-configuration/secret-values';
import type { Clock } from '#tool-host-core/organization-authority/models/authority-clock';
import type { OrganizationEngine } from '#tool-host-core/organization-engines/models/organization-engine';
import {
	assessedProxyProfile,
	resolveHostedProxyProfile,
} from '#tool-host-core/organization-engines/proxy-profile-policy';
import { createRequestOperationEntries } from '#tool-host-core/organization-engines/request-operation-entries';
import type { HostedProxyLimits } from '#tool-host-core/request-limits/models/hosted-proxy-limits';

const unavailableApproval: ApprovalPort = {
	challenge: async () => ({ kind: 'unavailable' }),
	receipt: async () => ({ kind: 'unavailable' }),
	decision: async () => ({ kind: 'unavailable' }),
};

/** One instance owns one organization's configuration, key and plain-data catalog. */
export async function createOrganizationEngine(props: {
	readonly organizationId: string;
	readonly configuration: OrganizationConfiguration;
	readonly secrets: SecretSource;
	readonly clock: Clock;
	readonly limits: HostedProxyLimits;
	readonly createClient?: UpstreamMcpRuntimeOptions['createClient'];
	readonly createUpstreamMcpTransport: NonNullable<
		UpstreamMcpRuntimeOptions['createUpstreamMcpTransport']
	>;
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
			...(props.createClient === undefined ? {} : { createClient: props.createClient }),
			additionalRedactionValues: rawSecrets,
			createUpstreamMcpTransport: props.createUpstreamMcpTransport,
			maxResponseBytes: props.limits.upstreamResponseBytes,
		});
	}
	// A discovery refresh owns its runtime only until that refresh ends; cached state is plain data.
	const discoveryRuntimes = new Map<string, UpstreamMcpClientRuntime>();
	const catalogRuntime = {
		listTools: async (call: { readonly namespace: string; readonly agentScopeId: string }) => {
			let runtime = discoveryRuntimes.get(call.agentScopeId);
			if (runtime === undefined) {
				runtime = createRequestRuntime();
				discoveryRuntimes.set(call.agentScopeId, runtime);
			}
			return runtime.listTools(call);
		},
		closeAgentScope: async (scope: string): Promise<void> => {
			const runtime = discoveryRuntimes.get(scope);
			discoveryRuntimes.delete(scope);
			await runtime?.closeAgentScope(scope);
		},
	};
	const organizationCatalog = createOrganizationToolCatalog({
		namespaces: providers.map((provider) => provider.namespace),
		runtime: catalogRuntime,
		discoveryScope: '$organization-catalog',
		catalogTtlMs: 60_000,
		now: props.clock.nowMs,
	});
	let snapshot = await organizationCatalog.read();

	const revision = { owner: props.organizationId, revision: 'deployed-v1' };
	return {
		configuration,
		refresh: async () => {
			snapshot = await organizationCatalog.read();
		},
		gatewayFor: ({ agentClientId, consumeTokenId, invoke }) => {
			const assignment = configuration.portal.agents[agentClientId];
			const profile =
				assignment === undefined ? undefined : configuration.portal.profiles[assignment.profile];
			if (profile === undefined || assignment === undefined)
				throw new Error('Agent profile unavailable.');
			const resolvedProfile = resolveHostedProxyProfile(profile);
			const requestSnapshot = snapshot;
			const sessions = createAgentCatalogViewCache({
				runtime: catalogRuntime,
				catalogTtlMs: 60_000,
				organizationCatalog: { read: async () => requestSnapshot },
				upstreamNamespaces: providers.map((provider) => provider.namespace),
				accessPolicy: {
					enabledNamespaces: providers.map((provider) => provider.namespace),
					enabledNamespacesByAgent: {},
					hiddenToolsByAgent: {},
				},
			});
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
					const call = async (): Promise<ResourceResult> => {
						try {
							const result = await runtime.callTool({
								agentScopeId: scope,
								namespace: invocation.capability.namespace,
								toolName: invocation.capability.tool,
								arguments: invocation.arguments satisfies JsonObject,
								requestId: invocation.operationKey.item,
							});
							return { kind: 'completed', result: jsonValueSchema.parse(result) };
						} catch (error) {
							const failure = proxyUpstreamFailureFromError({
								namespace: invocation.capability.namespace,
								toolName: invocation.capability.tool,
								error,
							});
							if (failure === null) throw error;
							return failure;
						}
					};
					return invoke === undefined ? call() : invoke(invocation, call);
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
				operations: createRequestOperationEntries(props.clock),
				approvals: unavailableApproval,
				approvalTokens: { key: approvalKey, consumeTokenId },
				prepareCatalog: async (catalog) => catalog,
				backends: new Map([['mcp_provider', backend]]),
				now: props.clock.nowMs,
				resolveAccess: async ({ capability, call }) => {
					const descriptor = requestSnapshot.toolsByNamespace
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
			return {
				gateway,
				close: async () => runtime.closeAgentScope(scope),
				trustedTool: (namespace, toolName) =>
					requestSnapshot.toolsByNamespace
						.get(namespace)
						?.some((tool) => tool.name === toolName) === true,
				requiresApproval: (namespace, toolName) => {
					const tool = requestSnapshot.toolsByNamespace
						.get(namespace)
						?.find((entry) => entry.name === toolName);
					return (
						mcpPortalCallPolicyDecision(resolvedProfile, {
							namespace,
							toolName,
							...(tool?.annotations === undefined ? {} : { annotations: tool.annotations }),
						}).kind === 'requires_approval'
					);
				},
			};
		},
	};
}
