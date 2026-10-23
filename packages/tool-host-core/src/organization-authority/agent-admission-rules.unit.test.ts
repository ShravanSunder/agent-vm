import { expect, it } from 'vitest';

import {
	agentAdmissionRow,
	isStoredAgentListed,
} from '#tool-host-core/organization-authority/agent-admission-rules';

it('admits only an existing listed row and preserves admission row bytes', () => {
	expect(isStoredAgentListed(undefined)).toBe(false);
	expect(isStoredAgentListed({ state: 'removed' })).toBe(false);
	expect(isStoredAgentListed({ state: 'listed' })).toBe(true);
	const row = agentAdmissionRow({ agentClientId: 'sender', state: 'listed' });
	expect(row.key).toBe('agent:sender');
	expect(JSON.stringify(row.value)).toBe('{"state":"listed"}');
	expect(agentAdmissionRow({ agentClientId: 'sender', state: 'removed' })).toEqual({
		key: 'agent:sender',
		value: { state: 'removed' },
	});
});

it('rejects corrupt admission rows and empty agent identities', () => {
	expect(() => isStoredAgentListed({ state: 'listed', extra: true })).toThrow();
	expect(() => isStoredAgentListed({ state: 'unknown' })).toThrow();
	expect(() => agentAdmissionRow({ agentClientId: '', state: 'listed' })).toThrow();
});
