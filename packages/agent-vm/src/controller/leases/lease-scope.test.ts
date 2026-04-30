import { describe, expect, it } from 'vitest';

import { parseAgentIdFromScopeKey, parseAgentScopeKey } from './lease-scope.js';

describe('parseAgentIdFromScopeKey', () => {
	it('returns the agent id for agent-scoped leases with optional sub-scope parts', () => {
		expect(parseAgentIdFromScopeKey('agent:shravan')).toBe('shravan');
		expect(parseAgentIdFromScopeKey('agent:shravan:session-abc')).toBe('shravan');
		expect(parseAgentIdFromScopeKey('agent:main:discord:direct:userA')).toBe('main');
		expect(parseAgentIdFromScopeKey('agent:main:discord:channel:123')).toBe('main');
		expect(parseAgentIdFromScopeKey('agent:main:discord:channel:123:thread:456')).toBe('main');
	});

	it('rejects non-agent and malformed scope keys', () => {
		expect(parseAgentIdFromScopeKey('session:shravan')).toBeNull();
		expect(parseAgentIdFromScopeKey('agent:')).toBeNull();
		expect(parseAgentIdFromScopeKey('agent:../shravan')).toBeNull();
		expect(parseAgentIdFromScopeKey('')).toBeNull();
	});

	it('returns structured parse failures for callers that need logs', () => {
		expect(parseAgentScopeKey('session:shravan')).toEqual({ kind: 'non-agent-scope' });
		expect(parseAgentScopeKey('agent:')).toEqual({
			kind: 'malformed-agent-scope',
			reason: 'missing agent id',
		});
		expect(parseAgentScopeKey('agent:../shravan')).toEqual({
			kind: 'malformed-agent-scope',
			reason: "invalid agent id '../shravan'",
		});
	});
});
