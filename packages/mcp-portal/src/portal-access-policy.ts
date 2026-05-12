export interface PortalBindingIdentity {
	readonly agentId: string;
	readonly bindingId: string;
	readonly sessionId?: string;
}

export interface PortalToolSelector {
	readonly namespace: string;
	readonly toolName: string;
}

export interface PortalAccessPolicyConfig {
	readonly enabledNamespaces?: readonly string[];
	readonly enabledNamespacesByAgent: Readonly<Record<string, readonly string[]>>;
	readonly hiddenToolsByAgent: Readonly<Record<string, readonly PortalToolSelector[]>>;
}

export interface ResolvedPortalAccessPolicy {
	readonly allowedNamespaces: readonly string[];
	readonly hiddenTools: readonly PortalToolSelector[];
}

export function portalBindingScopeKey(identity: PortalBindingIdentity): string {
	return identity.sessionId ? `${identity.bindingId}\n${identity.sessionId}` : identity.bindingId;
}

export function resolvePortalAccessPolicy(props: {
	readonly config: PortalAccessPolicyConfig;
	readonly identity: PortalBindingIdentity;
	readonly upstreamNamespaces: readonly string[];
}): ResolvedPortalAccessPolicy {
	const agentNamespaces = props.config.enabledNamespacesByAgent[props.identity.agentId];
	const globalNamespaces = props.config.enabledNamespaces ?? [];
	const selectedNamespaces =
		agentNamespaces ?? (globalNamespaces.length > 0 ? globalNamespaces : props.upstreamNamespaces);
	const upstreamNamespaceSet = new Set(props.upstreamNamespaces);

	return {
		allowedNamespaces: selectedNamespaces
			.filter((namespace) => upstreamNamespaceSet.has(namespace))
			.toSorted(),
		hiddenTools: [...(props.config.hiddenToolsByAgent[props.identity.agentId] ?? [])].toSorted(
			(left, right) => {
				const namespaceOrder = left.namespace.localeCompare(right.namespace);
				return namespaceOrder === 0 ? left.toolName.localeCompare(right.toolName) : namespaceOrder;
			},
		),
	};
}
