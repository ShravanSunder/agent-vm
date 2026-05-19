const portalAgentIdentityBrand = Symbol('PortalAgentIdentity');

export type PortalAgentIdentity = {
	readonly agentId: string;
	// `agentScopeId` is the upstream session/cache boundary. Most current adapters scope it
	// per agent, but the core keeps it separate so a future adapter can isolate per session
	// without changing the authorization identity.
	readonly agentScopeId: string;
	readonly authSubject?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly source: PortalAgentScopeSource;
	readonly [portalAgentIdentityBrand]: true;
};

export type PortalAgentScopeSource = 'cli-operator' | 'mcp-proxy-bearer' | 'openclaw-trusted';

export interface PortalToolSelector {
	readonly namespace: string;
	readonly toolName: string;
}

export type PortalDefaultPolicy = 'allow-all' | 'deny-all';

export interface PortalAccessPolicyConfig {
	readonly defaultPolicy?: PortalDefaultPolicy;
	readonly enabledNamespaces?: readonly string[];
	readonly enabledNamespacesByAgent: Readonly<Record<string, readonly string[]>>;
	readonly enabledToolsByAgent?: Readonly<Record<string, readonly PortalToolSelector[]>>;
	readonly hiddenToolsByAgent: Readonly<Record<string, readonly PortalToolSelector[]>>;
}

export interface ResolvedPortalAccessPolicy {
	readonly allowedNamespaces: readonly string[];
	readonly enabledTools: readonly PortalToolSelector[];
	readonly hiddenTools: readonly PortalToolSelector[];
}

export function createPortalAgentIdentity(input: {
	readonly agentId: string;
	readonly agentScopeId: string;
	readonly authSubject?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly source: PortalAgentScopeSource;
}): PortalAgentIdentity {
	validateIdentitySegment('agentId', input.agentId);
	validateIdentitySegment('agentScopeId', input.agentScopeId);
	if (input.sessionId !== undefined) {
		validateIdentitySegment('sessionId', input.sessionId);
	}
	if (input.sessionKey !== undefined) {
		validateIdentitySegment('sessionKey', input.sessionKey);
	}
	if (input.authSubject !== undefined) {
		validateIdentitySegment('authSubject', input.authSubject);
	}
	return {
		agentId: input.agentId,
		agentScopeId: input.agentScopeId,
		...(input.authSubject !== undefined ? { authSubject: input.authSubject } : {}),
		...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
		source: input.source,
		[portalAgentIdentityBrand]: true,
	};
}

function validateIdentitySegment(name: string, value: string): void {
	if (value.length === 0) {
		throw new Error(`MCP Portal ${name} must not be empty.`);
	}
	for (let index = 0; index < value.length; index += 1) {
		const codePoint = value.charCodeAt(index);
		if (codePoint < 32 || codePoint === 127) {
			throw new Error(`MCP Portal ${name} must not contain control characters.`);
		}
	}
}

export function portalAgentScopeKey(identity: PortalAgentIdentity): string {
	const sessionScope = identity.sessionId ?? identity.sessionKey;
	return sessionScope ? `${identity.agentScopeId}\n${sessionScope}` : identity.agentScopeId;
}

function sortToolSelectors(
	selectors: readonly PortalToolSelector[],
): readonly PortalToolSelector[] {
	return [...selectors].toSorted((left, right) => {
		const namespaceOrder = left.namespace.localeCompare(right.namespace);
		return namespaceOrder === 0 ? left.toolName.localeCompare(right.toolName) : namespaceOrder;
	});
}

export function resolvePortalAccessPolicy(props: {
	readonly config: PortalAccessPolicyConfig;
	readonly identity: PortalAgentIdentity;
	readonly upstreamNamespaces: readonly string[];
}): ResolvedPortalAccessPolicy {
	const agentNamespaces = props.config.enabledNamespacesByAgent[props.identity.agentId];
	const globalNamespaces = props.config.enabledNamespaces;
	const selectedNamespaces =
		agentNamespaces ??
		globalNamespaces ??
		(props.config.defaultPolicy === 'allow-all' ? props.upstreamNamespaces : []);
	const upstreamNamespaceSet = new Set(props.upstreamNamespaces);

	return {
		allowedNamespaces: selectedNamespaces
			.filter((namespace) => upstreamNamespaceSet.has(namespace))
			.toSorted(),
		enabledTools: sortToolSelectors(
			props.config.enabledToolsByAgent?.[props.identity.agentId] ?? [],
		),
		hiddenTools: sortToolSelectors(props.config.hiddenToolsByAgent[props.identity.agentId] ?? []),
	};
}
