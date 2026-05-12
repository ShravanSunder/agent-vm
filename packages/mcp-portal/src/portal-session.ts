import { createHash } from 'node:crypto';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { portalToolRecordSchema, type PortalToolRecord } from './catalog-types.js';
import {
	resolvePortalAccessPolicy,
	portalBindingScopeKey,
	type PortalAccessPolicyConfig,
	type PortalBindingIdentity,
	type PortalToolSelector,
} from './portal-access-policy.js';
import { createSearchIndex, type SearchIndex } from './search-index.js';
import { buildToolGraph, type SkillGraphInput, type ToolGraph } from './tool-graph.js';

export interface PortalCatalogSnapshot {
	readonly bindingId: string;
	readonly discoveryFailures: readonly PortalDiscoveryFailure[];
	readonly generatedAt: string;
	readonly sourceHash: string;
	readonly tools: readonly PortalToolRecord[];
}

export interface PortalDiscoveryFailure {
	readonly message: string;
	readonly namespace: string;
}

export interface PortalSession {
	readonly catalog: PortalCatalogSnapshot;
	readonly graph: ToolGraph;
	readonly identity: PortalBindingIdentity;
	readonly searchIndex: SearchIndex;
}

export interface PortalSessionRuntime {
	readonly closeBinding: (bindingId: string) => Promise<void> | void;
	readonly closeSession?: (scopeKey: string) => Promise<void> | void;
	readonly listTools: (call: {
		readonly bindingId: string;
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
	readonly getSession: (identity: PortalBindingIdentity) => Promise<PortalSession>;
	readonly invalidateBinding: (bindingId: string) => Promise<void>;
	readonly invalidateSession: (identity: PortalBindingIdentity) => Promise<void>;
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

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createPortalSessionManager(
	options: PortalSessionManagerOptions,
): PortalSessionManager {
	const sessions = new Map<string, CachedPortalSession>();
	const bindingGenerations = new Map<string, number>();
	const getNow = options.now ?? (() => Date.now());

	function generationForBinding(bindingId: string): number {
		return bindingGenerations.get(bindingId) ?? 0;
	}

	function incrementBindingGeneration(bindingId: string): void {
		bindingGenerations.set(bindingId, generationForBinding(bindingId) + 1);
	}

	function generationForScope(scopeKey: string): number {
		return (
			bindingGenerations.get(scopeKey) ??
			generationForBinding(scopeKey.split('\n', 1)[0] ?? scopeKey)
		);
	}

	function incrementScopeGeneration(scopeKey: string): void {
		bindingGenerations.set(scopeKey, generationForScope(scopeKey) + 1);
	}

	async function buildSession(identity: PortalBindingIdentity): Promise<PortalSession> {
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
					bindingId: portalBindingScopeKey(identity),
					namespace,
				}),
				namespace,
			})),
		);
		for (const [index, namespaceToolGroup] of namespaceToolGroups.entries()) {
			if (namespaceToolGroup.status === 'rejected') {
				const namespace = allowedNamespaces[index] ?? 'unknown';
				discoveryFailures.push({ message: messageFromError(namespaceToolGroup.reason), namespace });
				continue;
			}
			const { mcpTools, namespace } = namespaceToolGroup.value;
			for (const mcpTool of mcpTools) {
				const portalTool = portalToolFromMcpTool(namespace, mcpTool);
				if (!isHiddenTool(portalTool, policy.hiddenTools)) {
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
			bindingId: identity.bindingId,
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
		async getSession(identity: PortalBindingIdentity): Promise<PortalSession> {
			const key = portalBindingScopeKey(identity);
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
		async invalidateBinding(bindingId: string): Promise<void> {
			incrementBindingGeneration(bindingId);
			for (const key of sessions.keys()) {
				if (key === bindingId || key.startsWith(`${bindingId}\n`)) {
					sessions.delete(key);
				}
			}
			await options.runtime.closeBinding(bindingId);
		},
		async invalidateSession(identity: PortalBindingIdentity): Promise<void> {
			const scopeKey = portalBindingScopeKey(identity);
			incrementScopeGeneration(scopeKey);
			sessions.delete(scopeKey);
			if (options.runtime.closeSession) {
				await options.runtime.closeSession(scopeKey);
				return;
			}
			await options.runtime.closeBinding(scopeKey);
		},
	};
}
