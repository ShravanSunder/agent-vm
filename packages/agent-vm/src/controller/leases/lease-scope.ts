const agentIdPattern = /^[a-z0-9][a-z0-9._-]*$/u;

export type AgentScopeParseResult =
	| {
			readonly agentId: string;
			readonly kind: 'agent';
	  }
	| {
			readonly kind: 'malformed-agent-scope';
			readonly reason: string;
	  }
	| {
			readonly kind: 'non-agent-scope';
	  };

export function parseAgentScopeKey(scopeKey: string): AgentScopeParseResult {
	const [scopeKind, agentId] = scopeKey.split(':');
	if (scopeKind !== 'agent') {
		return { kind: 'non-agent-scope' };
	}
	if (!agentId) {
		return { kind: 'malformed-agent-scope', reason: 'missing agent id' };
	}
	if (!agentIdPattern.test(agentId)) {
		return { kind: 'malformed-agent-scope', reason: `invalid agent id '${agentId}'` };
	}
	return { agentId, kind: 'agent' };
}

export function parseAgentIdFromScopeKey(scopeKey: string): string | null {
	const parsedScope = parseAgentScopeKey(scopeKey);
	return parsedScope.kind === 'agent' ? parsedScope.agentId : null;
}
