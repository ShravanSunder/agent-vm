import {
	createWorkspacePrincipalIdentity,
	workspacePrincipalKey,
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
	createWorkspaceToolCatalog,
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
	WorkspaceConfiguration,
	SecretSource,
} from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { formatSecretValue } from '#tool-host-core/hosted-configuration/secret-values';
import type { HostedProxyLimits } from '#tool-host-core/request-limits/models/hosted-proxy-limits';
import type { Clock } from '#tool-host-core/workspace-authority/models/authority-clock';
import type {
	WorkspaceEngine,
	SettledWorkspaceCatalog,
} from '#tool-host-core/workspace-engines/models/workspace-engine';
import {
	assessedProxyProfile,
	resolveHostedProxyProfile,
} from '#tool-host-core/workspace-engines/proxy-profile-policy';
import { createRequestOperationEntries } from '#tool-host-core/workspace-engines/request-operation-entries';

const unavailableApproval: ApprovalPort = {
	challenge: async () => ({ kind: 'unavailable' }),
	receipt: async () => ({ kind: 'unavailable' }),
	decision: async () => ({ kind: 'unavailable' }),
};

/** One request owns its engine and all discovery I/O; only settled catalog data is reusable. */
export async function createWorkspaceEngine(props: {
	readonly workspaceId: string;
	readonly configuration: WorkspaceConfiguration;
	readonly secrets: SecretSource;
	readonly clock: Clock;
	readonly limits: HostedProxyLimits;
	readonly cachedCatalog?: SettledWorkspaceCatalog;
	readonly createClient?: UpstreamMcpRuntimeOptions['createClient'];
	readonly createUpstreamMcpTransport: NonNullable<
		UpstreamMcpRuntimeOptions['createUpstreamMcpTransport']
	>;
}): Promise<WorkspaceEngine> {
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
	// This engine is request-owned. No runtime or in-flight catalog survives into another request.
	const discoveryRuntime = createRequestRuntime();
	const catalogRuntime = {
		listTools: discoveryRuntime.listTools,
		closeAgentScope: discoveryRuntime.closeAgentScope,
	};
	const workspaceCatalog = createWorkspaceToolCatalog({
		namespaces: providers.map((provider) => provider.namespace),
		runtime: catalogRuntime,
		discoveryScope: '$workspace-catalog',
		catalogTtlMs: 60_000,
		now: props.clock.nowMs,
	});
	let settledCatalog = props.cachedCatalog;
	let snapshot = settledCatalog?.snapshot;
	async function refresh(): Promise<void> {
		if (
			settledCatalog !== undefined &&
			props.clock.nowMs() < settledCatalog.discoveryStartedAt + 60_000
		)
			return;
		const discoveryStartedAt = props.clock.nowMs();
		const candidate = await workspaceCatalog.read();
		if (candidate.discoveryFailures.length === 0) {
			settledCatalog = { snapshot: candidate, discoveryStartedAt };
			snapshot = candidate;
		} else {
			// A failed refresh may serve the previous complete generation, but publishes no new cache entry.
			snapshot =
				settledCatalog === undefined
					? candidate
					: {
							...settledCatalog.snapshot,
							discoveryFailures: candidate.discoveryFailures,
						};
		}
	}
	await refresh();

	const revision = { owner: props.workspaceId, revision: 'deployed-v1' };
	return {
		configuration,
		refresh,
		settledCatalog: () => settledCatalog,
		gatewayFor: ({ principal, persona, consumeTokenId, invoke }) => {
			const profile = configuration.portal.profiles[persona];
			if (profile === undefined) throw new Error('Agent profile unavailable.');
			const resolvedProfile = resolveHostedProxyProfile(profile);
			const requestSnapshot = snapshot;
			if (requestSnapshot === undefined) throw new Error('Request catalog was not prepared.');
			const sessions = createAgentCatalogViewCache({
				runtime: catalogRuntime,
				catalogTtlMs: 60_000,
				workspaceCatalog: { read: async () => requestSnapshot },
				upstreamNamespaces: providers.map((provider) => provider.namespace),
				accessPolicy: {
					enabledNamespaces: providers.map((provider) => provider.namespace),
					enabledNamespacesByAgent: {},
					hiddenToolsByAgent: {},
				},
			});
			const identity = createWorkspacePrincipalIdentity(principal);
			const principalKey = workspacePrincipalKey(principal);
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
					authority: props.workspaceId,
					principal: principalKey,
					verifiedContextRef: principalKey,
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
									profileId: persona,
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
