import { describe, expect, it } from 'vitest';

import {
	normalizeOpenClawAgentId,
	resolveOpenClawAgentIdFromSessionKey,
} from './openclaw-agent-vm-contract.js';

describe('OpenClaw Gondolin agent identity contract', () => {
	it('resolves agent id from agent-shaped session keys', () => {
		expect(resolveOpenClawAgentIdFromSessionKey('agent:Beta:discord:channel:123')).toBe('beta');
	});

	it.each(['session-abc', 'subagent:beta', 'agent:', 'agent:Beta!'])(
		'rejects malformed session key %s instead of defaulting to main',
		(sessionKey) => {
			expect(() => resolveOpenClawAgentIdFromSessionKey(sessionKey)).toThrow(
				/sessionKey.*agentId/u,
			);
		},
	);

	it('rejects invalid explicit agent ids instead of defaulting to main', () => {
		expect(() => normalizeOpenClawAgentId('Bad Name')).toThrow(/Invalid OpenClaw agentId/u);
	});

	it('keeps the implicit default only for absent agent ids', () => {
		expect(normalizeOpenClawAgentId(undefined)).toBe('main');
		expect(normalizeOpenClawAgentId(null)).toBe('main');
	});
});
