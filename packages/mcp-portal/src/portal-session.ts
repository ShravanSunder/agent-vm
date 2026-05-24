import { createHash } from 'node:crypto';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { portalToolRecordSchema, type PortalToolRecord } from './catalog-types.js';
import {
	resolvePortalAccessPolicy,
	portalAgentScopeKey,
	type PortalAccessPolicyConfig,
	type PortalAgentIdentity,
	type PortalToolSelector,
} from './portal-access-policy.js';
import { createSearchIndex, type SearchIndex } from './search-index.js';
import { buildToolGraph, type SkillGraphInput, type ToolGraph } from './tool-graph.js';
import {
	formatUpstreamMcpFailureMessage,
	messageFromUnknownError,
	upstreamMcpFailureDetailsFromUnknown,
} from './upstream-mcp-errors.js';

export interface PortalCatalogSnapshot {
	readonly agentScopeId: string;
	readonly discoveryFailures: readonly PortalDiscoveryFailure[];
	readonly generatedAt: string;
	readonly sourceHash: string;
	readonly tools: readonly PortalToolRecord[];
}

export interface PortalDiscoveryFailure {
	readonly causeMessage?: string;
	readonly elapsedMs?: number;
	readonly hint?: string;
	readonly kind: string;
	readonly message: string;
	readonly namespace: string;
	readonly operation?: string;
	readonly phase?: string;
	readonly timeoutMs?: number;
	readonly toolName?: string;
	readonly transport?: unknown;
}

export interface PortalSession {
	readonly catalog: PortalCatalogSnapshot;
	readonly graph: ToolGraph;
	readonly identity: PortalAgentIdentity;
	readonly searchIndex: SearchIndex;
}

export interface PortalSessionRuntime {
	readonly closeAgentScope: (agentScopeId: string) => Promise<void> | void;
	readonly closeSession?: (scopeKey: string) => Promise<void> | void;
	readonly listTools: (call: {
		readonly agentScopeId: string;
		readonly namespace: string;
	}) => Promise<readonly Tool[]>;
}

export interface PortalSessionManagerOptions {
	readonly accessPolicy: PortalAccessPolicyConfig;
	readonly catalogTtlMs: number;
	readonly discoveryFailures?: readonly PortalDiscoveryFailure[];
	readonly now?: () => number;
	readonly runtime: PortalSessionRuntime;
	readonly skills?: readonly SkillGraphInput[];
	readonly upstreamNamespaces: readonly string[];
}

export interface PortalSessionManager {
	readonly getSession: (identity: PortalAgentIdentity) => Promise<PortalSession>;
	readonly invalidateAgentScope: (agentScopeId: string) => Promise<void>;
	readonly invalidateSession: (identity: PortalAgentIdentity) => Promise<void>;
}

interface CachedPortalSession {
	readonly expiresAt: number;
	readonly session: PortalSession;
}

function isHiddenTool(tool: PortalToolRecord, hiddenTools: readonly PortalToolSelector[]): boolean {
	return hiddenTools.some(
		(hiddenTool) =>
			hiddenTool.namespace === tool.namespace && hiddenTool.toolName === tool.toolName,
	);
}

function isEnabledTool(
	tool: PortalToolRecord,
	enabledToolsByNamespace: Readonly<Record<string, readonly string[]>>,
): boolean {
	const enabledTools = enabledToolsByNamespace[tool.namespace];
	if (enabledTools === undefined) {
		return true;
	}
	return enabledTools.includes(tool.toolName);
}

function portalToolFromMcpTool(namespace: string, tool: Tool): PortalToolRecord {
	return portalToolRecordSchema.parse({
		...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
		...(tool.description !== undefined ? { description: tool.description } : {}),
		inputSchema: tool.inputSchema,
		namespace,
		...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
		...(tool.title !== undefined ? { title: tool.title } : {}),
		toolName: tool.name,
	});
}

function createSourceHash(tools: readonly PortalToolRecord[]): string {
	return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

function discoveryFailureFromError(namespace: string, error: unknown): PortalDiscoveryFailure {
	const upstreamDetails = upstreamMcpFailureDetailsFromUnknown(error);
	if (upstreamDetails !== null) {
		return {
			...upstreamDetails,
			message: formatUpstreamMcpFailureMessage(upstreamDetails),
			namespace,
		};
	}
	return {
		kind: 'upstream_discovery_failed',
		message: messageFromUnknownError(error),
		namespace,
	};
}

export function createPortalSessionManager(
	options: PortalSessionManagerOptions,
): PortalSessionManager {
	const sessions = new Map<string, CachedPortalSession>();
	const agentScopeGenerations = new Map<string, number>();
	const getNow = options.now ?? (() => Date.now());

	function generationForAgentScope(agentScopeId: string): number {
		return agentScopeGenerations.get(agentScopeId) ?? 0;
	}

	function incrementAgentScopeGeneration(agentScopeId: string): void {
		agentScopeGenerations.set(agentScopeId, generationForAgentScope(agentScopeId) + 1);
	}

	function generationForScope(scopeKey: string): number {
		const agentScopeId = scopeKey.split('\n', 1)[0] ?? scopeKey;
		return (agentScopeGenerations.get(scopeKey) ?? 0) + generationForAgentScope(agentScopeId);
	}

	function incrementScopeGeneration(scopeKey: string): void {
		agentScopeGenerations.set(scopeKey, generationForScope(scopeKey) + 1);
	}

	async function buildSession(identity: PortalAgentIdentity): Promise<PortalSession> {
		const policy = resolvePortalAccessPolicy({
			config: options.accessPolicy,
			identity,
			upstreamNamespaces: options.upstreamNamespaces,
		});
		const tools: PortalToolRecord[] = [];
		const discoveryFailures: PortalDiscoveryFailure[] = [...(options.discoveryFailures ?? [])];
		const allowedNamespaces = policy.allowedNamespaces;

		const namespaceToolGroups = await Promise.allSettled(
			allowedNamespaces.map(async (namespace) => ({
				mcpTools: await options.runtime.listTools({
					agentScopeId: portalAgentScopeKey(identity),
					namespace,
				}),
				namespace,
			})),
		);
		for (const [index, namespaceToolGroup] of namespaceToolGroups.entries()) {
			if (namespaceToolGroup.status === 'rejected') {
				const namespace = allowedNamespaces[index] ?? 'unknown';
				discoveryFailures.push(discoveryFailureFromError(namespace, namespaceToolGroup.reason));
				continue;
			}
			const { mcpTools, namespace } = namespaceToolGroup.value;
			for (const mcpTool of mcpTools) {
				const portalTool = portalToolFromMcpTool(namespace, mcpTool);
				if (
					isEnabledTool(portalTool, policy.enabledToolsByNamespace) &&
					!isHiddenTool(portalTool, policy.hiddenTools)
				) {
					tools.push(portalTool);
				}
			}
		}

		const sortedTools = tools.toSorted((left, right) => {
			const namespaceOrder = left.namespace.localeCompare(right.namespace);
			return namespaceOrder === 0 ? left.toolName.localeCompare(right.toolName) : namespaceOrder;
		});
		const graph = buildToolGraph({ skills: options.skills ?? [], tools: sortedTools });
		const catalog = {
			agentScopeId: identity.agentScopeId,
			discoveryFailures,
			generatedAt: new Date(getNow()).toISOString(),
			sourceHash: createSourceHash(sortedTools),
			tools: sortedTools,
		};

		return {
			catalog,
			graph,
			identity,
			searchIndex: createSearchIndex(sortedTools, graph),
		};
	}

	return {
		async getSession(identity: PortalAgentIdentity): Promise<PortalSession> {
			const key = portalAgentScopeKey(identity);
			const now = getNow();
			const cached = sessions.get(key);
			if (cached && cached.expiresAt > now) {
				return cached.session;
			}

			const generation = generationForScope(key);
			const session = await buildSession(identity);
			if (
				generationForScope(key) === generation &&
				session.catalog.discoveryFailures.length === 0
			) {
				sessions.set(key, { expiresAt: now + options.catalogTtlMs, session });
			}
			return session;
		},
		async invalidateAgentScope(agentScopeId: string): Promise<void> {
			incrementAgentScopeGeneration(agentScopeId);
			for (const key of sessions.keys()) {
				if (key === agentScopeId || key.startsWith(`${agentScopeId}\n`)) {
					sessions.delete(key);
				}
			}
			await options.runtime.closeAgentScope(agentScopeId);
		},
		async invalidateSession(identity: PortalAgentIdentity): Promise<void> {
			const scopeKey = portalAgentScopeKey(identity);
			incrementScopeGeneration(scopeKey);
			sessions.delete(scopeKey);
			if (options.runtime.closeSession) {
				await options.runtime.closeSession(scopeKey);
				return;
			}
			await options.runtime.closeAgentScope(scopeKey);
		},
	};
}
