export function parseAgentIdFromScopeKey(scopeKey: string): string | null {
	const [scopeKind, agentId, ...extraParts] = scopeKey.split(':');
	if (scopeKind !== 'agent' || !agentId || extraParts.length > 0) {
		return null;
	}
	return agentId;
}
