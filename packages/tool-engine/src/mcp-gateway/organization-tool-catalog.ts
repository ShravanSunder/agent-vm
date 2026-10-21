import type { Tool } from '@modelcontextprotocol/server';

import {
	discoveryFailureFromError,
	type PortalDiscoveryFailure,
	type PortalSessionRuntime,
} from '#mcp-gateway/portal-session';

export interface OrganizationToolCatalogSnapshot {
	readonly kind: 'complete' | 'incomplete';
	readonly toolsByNamespace: ReadonlyMap<string, readonly Tool[]>;
	readonly discoveryFailures: readonly PortalDiscoveryFailure[];
}
export interface OrganizationToolCatalog {
	readonly read: () => Promise<OrganizationToolCatalogSnapshot>;
}

type NamespaceTools = ReadonlyMap<string, readonly Tool[]>;
type DiscoveryFailures = ReadonlyMap<string, PortalDiscoveryFailure>;
type CatalogState =
	| { readonly kind: 'unlisted' }
	| { readonly kind: 'complete'; readonly tools: NamespaceTools; readonly expiresAt: number }
	| {
			readonly kind: 'incomplete';
			readonly candidate: NamespaceTools;
			readonly failures: DiscoveryFailures;
	  }
	| {
			readonly kind: 'refresh-failed';
			readonly candidate: NamespaceTools;
			readonly failures: DiscoveryFailures;
			readonly complete: NamespaceTools;
	  };

/** One organization's discovery; caller views never own upstream listing or retry state. */
export function createOrganizationToolCatalog(props: {
	readonly namespaces: readonly string[];
	readonly runtime: PortalSessionRuntime;
	readonly discoveryScope: string;
	readonly catalogTtlMs: number;
	readonly now: () => number;
}): OrganizationToolCatalog {
	let state: CatalogState = { kind: 'unlisted' };
	let inFlight: Promise<OrganizationToolCatalogSnapshot> | undefined;
	function snapshot(): OrganizationToolCatalogSnapshot {
		switch (state.kind) {
			case 'unlisted':
				return { kind: 'complete', toolsByNamespace: new Map(), discoveryFailures: [] };
			case 'complete':
				return { kind: 'complete', toolsByNamespace: state.tools, discoveryFailures: [] };
			case 'incomplete':
				return {
					kind: 'incomplete',
					toolsByNamespace: state.candidate,
					discoveryFailures: [...state.failures.values()],
				};
			case 'refresh-failed':
				return {
					kind: 'complete',
					toolsByNamespace: state.complete,
					discoveryFailures: [...state.failures.values()],
				};
		}
		throw new Error('Unreachable organization catalog state');
	}
	async function refresh(namespaces: readonly string[]): Promise<OrganizationToolCatalogSnapshot> {
		const previous = state;
		const candidate = new Map(
			previous.kind === 'unlisted'
				? []
				: previous.kind === 'complete'
					? previous.tools
					: previous.candidate,
		);
		const failures = new Map(
			previous.kind === 'incomplete' || previous.kind === 'refresh-failed' ? previous.failures : [],
		);
		const complete =
			previous.kind === 'complete'
				? previous.tools
				: previous.kind === 'refresh-failed'
					? previous.complete
					: undefined;
		try {
			const results = await Promise.allSettled(
				namespaces.map(async (namespace) => ({
					namespace,
					tools: await props.runtime.listTools({ agentScopeId: props.discoveryScope, namespace }),
				})),
			);
			for (const [index, result] of results.entries()) {
				const namespace = namespaces[index];
				if (namespace === undefined) throw new Error('Missing catalog namespace');
				if (result.status === 'fulfilled') {
					candidate.set(namespace, result.value.tools);
					failures.delete(namespace);
				} else failures.set(namespace, discoveryFailureFromError(namespace, result.reason));
			}
		} finally {
			await props.runtime.closeAgentScope(props.discoveryScope);
		}
		state =
			failures.size === 0
				? { kind: 'complete', tools: candidate, expiresAt: props.now() + props.catalogTtlMs }
				: complete === undefined
					? { kind: 'incomplete', candidate, failures }
					: { kind: 'refresh-failed', candidate, failures, complete };
		return snapshot();
	}
	return {
		read: async () => {
			if (inFlight !== undefined) return inFlight;
			const targets =
				state.kind === 'unlisted'
					? props.namespaces
					: state.kind === 'incomplete' || state.kind === 'refresh-failed'
						? [...state.failures.keys()]
						: props.now() >= state.expiresAt
							? props.namespaces
							: [];
			if (targets.length === 0) return snapshot();
			inFlight = refresh(targets);
			try {
				return await inFlight;
			} finally {
				inFlight = undefined;
			}
		},
	};
}
