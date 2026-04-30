import { describe, expect, it } from 'vitest';

import { parseAgentIdFromScopeKey } from './lease-scope.js';

describe('parseAgentIdFromScopeKey', () => {
	it('returns the agent id for agent-scoped leases', () => {
		expect(parseAgentIdFromScopeKey('agent:shravan')).toBe('shravan');
	});

	it('rejects non-agent and ambiguous scope keys', () => {
		expect(parseAgentIdFromScopeKey('session:shravan')).toBeNull();
		expect(parseAgentIdFromScopeKey('agent:')).toBeNull();
		expect(parseAgentIdFromScopeKey('agent:shravan:thread')).toBeNull();
	});
});
