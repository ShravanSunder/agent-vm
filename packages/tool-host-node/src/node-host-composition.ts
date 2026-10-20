import {
	createPortalAgentIdentity,
	portalAgentScopeKey,
	type PortalAgentIdentity,
} from '@agent-collaboration/tool-access/authorization';
import {
	assessAccessInput,
	jsonValueSchema,
	jsonObjectSchema,
} from '@agent-collaboration/tool-access/contracts';
import {
	createUpstreamMcpClientRuntime,
	type UpstreamMcpClientRuntime,
} from '@agent-collaboration/tool-engine/connectors';
import {
	type ApprovalPort,
	type ToolBackend,
	type BackendKind,
	type OperationPort,
} from '@agent-collaboration/tool-engine/dispatch';
import {
	createMcpGateway,
	createPortalSessionManager,
	encodeToolRef,
	type McpGateway,
	type PreparedGatewayCatalog,
} from '@agent-collaboration/tool-engine/mcp-gateway';

import { compileCatalogTypescriptModules } from '#node-host/catalog-typescript/catalog-typescript-compiler';
import { mcpConfigToResolvedProviders } from '#node-host/configuration/mcp-config';
import {
	nodeHostConfigSchema,
	type NodeHostConfig,
} from '#node-host/configuration/node-host-config';
import {
	formatSecretValue,
	type SecretValue,
	type FormattedSecretValue,
} from '#node-host/configuration/secret-value';
import {
	compileNodeHostCredentialSet,
	type NodeHostBearerCredentialSet,
	type CompiledNodeHostCredential,
} from '#node-host/ingress/bearer-credentials';
import { openNodeOperationStore } from '#node-host/operations/node-operation-store';
import {
	createNodeHttpUpstreamTransport,
	createNodeStdioUpstreamTransport,
} from '#node-host/upstream/node-upstream-transports';
import { createNodeStdioUpstreamRuntime } from '#node-host/upstream/stdio-upstream-runtime';

export interface NodeHostSecretResolutionPort {
	readonly resolve: (secret: SecretValue) => Promise<string>;
}

export interface NodeHostComposition {
	readonly config: NodeHostConfig;
	readonly operations: OperationPort;
	readonly activateCredentials: (credentials: NodeHostBearerCredentialSet) => void;
	readonly gatewayFor: (credential: CompiledNodeHostCredential, sessionId?: string) => McpGateway;
	readonly closeSession: (identity: PortalAgentIdentity) => Promise<void>;
	readonly close: () => Promise<void>;
}

async function unavailableApproval(): Promise<{ kind: 'unavailable' }> {
	return { kind: 'unavailable' };
}

export async function createNodeHostComposition(props: {
	readonly config: NodeHostConfig;
	readonly secrets: NodeHostSecretResolutionPort;
	readonly approvals?: ApprovalPort;
	readonly onDiagnostic?: (event: 'upstream-close-failed' | 'upstream-stderr') => void;
}): Promise<NodeHostComposition> {
	const config = nodeHostConfigSchema.parse(structuredClone(props.config));
	const credentials = compileNodeHostCredentialSet(config.auth);
	const runtimeByNamespace = new Map<string, UpstreamMcpClientRuntime>();
	const allScopes = new Set<string>();
	const allowedContext = new Map(
		credentials.credentials.map((credential) => [
			credential.credentialId,
			credential.principal.agentId,
		]),
	);
	const operations = await openNodeOperationStore({
		directory: config.storeDirectory,
		authority: config.authority,
		authorize: (key, contextRef) => allowedContext.get(contextRef) === key.principal,
	});
	try {
		await Promise.all(
			mcpConfigToResolvedProviders(config.mcp).map(async (provider) => {
				const rawSecrets: string[] = [];
				async function resolveValues(
					values: Readonly<Record<string, FormattedSecretValue>>,
				): Promise<Record<string, string>> {
					return Object.fromEntries(
						await Promise.all(
							Object.entries(values).map(async ([name, secret]) => {
								const rawValue = await props.secrets.resolve(secret);
								if (rawValue.length === 0)
									throw new Error('Configured provider credential did not resolve.');
								rawSecrets.push(rawValue);
								return [name, formatSecretValue(secret, rawValue)];
							}),
						),
					);
				}
				const onCloseError = (): void => props.onDiagnostic?.('upstream-close-failed');
				const timeout =
					provider.connectionTimeoutMs === undefined
						? {}
						: { connectionTimeoutMs: provider.connectionTimeoutMs };
				let runtime: UpstreamMcpClientRuntime;
				if (provider.transport === 'stdio') {
					const env = await resolveValues(provider.env);
					runtime = createNodeStdioUpstreamRuntime({
						servers: [
							{
								namespace: provider.namespace,
								transport: 'stdio',
								command: provider.command,
								args: provider.args,
								env,
								...timeout,
								...(provider.cwd === undefined ? {} : { cwd: provider.cwd }),
							},
						],
						additionalRedactionValues: rawSecrets,
						onCloseError,
						createUpstreamMcpTransport: createNodeStdioUpstreamTransport({
							stderr: () => props.onDiagnostic?.('upstream-stderr'),
						}),
					});
				} else {
					const headers = await resolveValues(provider.headers);
					runtime = createUpstreamMcpClientRuntime({
						servers: [
							{
								namespace: provider.namespace,
								transport: provider.transport,
								url: provider.url,
								headers,
								...timeout,
							},
						],
						additionalRedactionValues: rawSecrets,
						onCloseError,
						createUpstreamMcpTransport: createNodeHttpUpstreamTransport,
					});
				}
				runtimeByNamespace.set(provider.namespace, runtime);
			}),
		);
	} catch (error) {
		await operations.close();
		throw error;
	}
	function runtimeFor(namespace: string): UpstreamMcpClientRuntime {
		const runtime = runtimeByNamespace.get(namespace);
		if (runtime === undefined) throw new Error('Unknown configured provider.');
		return runtime;
	}
	const runtime: UpstreamMcpClientRuntime = {
		listTools: async (call) => runtimeFor(call.namespace).listTools(call),
		callTool: async (call) => runtimeFor(call.namespace).callTool(call),
		closeAgentScope: async (scope) => {
			await Promise.all(
				[...runtimeByNamespace.values()].map(async (upstream) => upstream.closeAgentScope(scope)),
			);
		},
		closeSession: async (scope) => {
			await Promise.all(
				[...runtimeByNamespace.values()].map(async (upstream) => upstream.closeSession(scope)),
			);
		},
	};
	const sessions = createPortalSessionManager({
		accessPolicy: {
			enabledNamespaces: [...runtimeByNamespace.keys()],
			enabledNamespacesByAgent: {},
			hiddenToolsByAgent: {},
		},
		upstreamNamespaces: [...runtimeByNamespace.keys()],
		catalogTtlMs: 60_000,
		runtime,
	});
	let closed = false;
	async function prepareCatalog(catalog: PreparedGatewayCatalog): Promise<PreparedGatewayCatalog> {
		const bundle = await compileCatalogTypescriptModules({
			tools: catalog.tools.map((tool) => ({
				namespace: tool.namespace,
				name: tool.toolName,
				inputSchema: jsonObjectSchema.parse(tool.descriptor.inputSchema),
				...(tool.descriptor.description === undefined
					? {}
					: { description: tool.descriptor.description }),
			})),
		});
		return {
			...catalog,
			typescriptHelpersByToolRef: Object.fromEntries(
				bundle.manifest.tools.flatMap((tool) => {
					const source = bundle.files.find((file) => file.path === tool.modulePath)?.source;
					return source === undefined
						? []
						: [[encodeToolRef({ namespace: tool.namespace, toolName: tool.name }), source]];
				}),
			),
		};
	}
	return {
		config,
		operations,
		activateCredentials: (next) => {
			const updated = compileNodeHostCredentialSet(next);
			allowedContext.clear();
			for (const credential of updated.credentials)
				allowedContext.set(credential.credentialId, credential.principal.agentId);
		},
		gatewayFor: (credential, sessionId) => {
			if (closed || !allowedContext.has(credential.credentialId))
				throw new Error('Host is unavailable.');
			const principal = credential.principal;
			const profile = config.profiles[principal.toolPortalProfileId];
			if (profile === undefined) throw new Error('Missing configured assignment.');
			const identity = createPortalAgentIdentity({
				agentId: principal.agentId,
				agentScopeId: principal.agentId,
				source: 'mcp-proxy-bearer',
				...(sessionId === undefined ? {} : { sessionId }),
			});
			const scope = portalAgentScopeKey(identity);
			allScopes.add(scope);
			const backend: ToolBackend<BackendKind> = {
				backendKind: 'mcp_provider',
				list: async () => ({}),
				describe: async () => ({}),
				search: async () => ({}),
				invoke: async (invocation) => {
					if (
						closed ||
						allowedContext.get(credential.credentialId) !== principal.agentId ||
						invocation.operationKey.principal !== principal.agentId ||
						invocation.verifiedContextRef !== credential.credentialId
					)
						return { kind: 'not-dispatched', reason: 'caller-unavailable' };
					const result = await runtime.callTool({
						agentScopeId: scope,
						namespace: invocation.capability.namespace,
						toolName: invocation.capability.tool,
						arguments: invocation.arguments,
						requestId: invocation.operationKey.item,
					});
					return { kind: 'completed', result: jsonValueSchema.parse(result) };
				},
			};
			return createMcpGateway({
				caller: {
					identity,
					authority: config.authority,
					principal: principal.agentId,
					verifiedContextRef: credential.credentialId,
				},
				hostBinding: { workspaceLayer: config.workspaceLayer, config: config.revision },
				sessions,
				prepareCatalog,
				operations,
				approvals: props.approvals ?? {
					challenge: unavailableApproval,
					receipt: unavailableApproval,
					decision: unavailableApproval,
				},
				backends: new Map([['mcp_provider', backend]]),
				now: Date.now,
				resolveAccess: async ({ capability, call }) =>
					assessAccessInput.parse({
						capability,
						call,
						surface: 'mcp',
						facts: {
							workspace: { kind: 'not-configured' },
							assignment: {
								profile: profile.profile,
								profileRevision: profile.revision,
								revision: {
									owner: config.authority,
									revision: principal.profileAssignmentRevision,
								},
							},
							surface: {
								eligible:
									closed || allowedContext.get(credential.credentialId) !== principal.agentId
										? []
										: ['mcp'],
								snapshot: config.revision,
							},
							accounts: [],
							upstream: {
								status: closed ? 'unavailable' : 'available',
								credentialNeed: 'none',
								binding: config.revision,
							},
						},
					}),
			});
		},
		closeSession: async (identity) => {
			allScopes.delete(portalAgentScopeKey(identity));
			await sessions.invalidateSession(identity);
		},
		close: async () => {
			if (closed) return;
			closed = true;
			try {
				await Promise.all([...allScopes].map(async (scope) => runtime.closeSession(scope)));
			} finally {
				await operations.close();
			}
		},
	};
}
