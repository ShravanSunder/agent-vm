import { describe, expect, it } from 'vitest';

import { createPortalAgentIdentity } from './portal-access-policy.js';

describe('createPortalAgentIdentity', () => {
	it('rejects empty and control-character identity segments', () => {
		expect(() => createPortalAgentIdentity({ agentId: '', agentScopeId: 'agent-a' })).toThrow(
			/agentId/u,
		);
		expect(() =>
			createPortalAgentIdentity({ agentId: 'agent-a', agentScopeId: 'agent-a\nsession-b' }),
		).toThrow(/agentScopeId/u);
		expect(() =>
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-a',
				sessionId: 'session-a\nsession-b',
			}),
		).toThrow(/sessionId/u);
	});
});
