import { describe, expect, it } from 'vitest';

import { createPortalAgentIdentity } from './portal-access-policy.js';

describe('createPortalAgentIdentity', () => {
	it('accepts Tool Portal service as a distinct upstream scope source', () => {
		expect(
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'mcp-provider:agent-a',
				source: 'tool-portal-service',
			}),
		).toMatchObject({ source: 'tool-portal-service' });
	});

	it('rejects empty and control-character identity segments', () => {
		expect(() =>
			createPortalAgentIdentity({
				agentId: '',
				agentScopeId: 'agent-a',
				source: 'cli-operator',
			}),
		).toThrow(/agentId/u);
		expect(() =>
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-a\nsession-b',
				source: 'cli-operator',
			}),
		).toThrow(/agentScopeId/u);
		expect(() =>
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent-a',
				sessionId: 'session-a\nsession-b',
				source: 'cli-operator',
			}),
		).toThrow(/sessionId/u);
	});

	it('rejects unicode line-separator identity segments', () => {
		expect(() =>
			createPortalAgentIdentity({
				agentId: 'agent\u2028a',
				agentScopeId: 'agent-a',
				source: 'cli-operator',
			}),
		).toThrow(/agentId/u);
		expect(() =>
			createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'agent\u2029a',
				source: 'cli-operator',
			}),
		).toThrow(/agentScopeId/u);
	});
});
