import { expect, it } from 'vitest';

import {
	workspaceMembershipRow,
	storedWorkspaceMembership,
} from '#tool-host-core/workspace-authority/agent-admission-rules';

it('admits only an existing member row and preserves its persona', () => {
	expect(storedWorkspaceMembership(undefined)).toBeNull();
	expect(storedWorkspaceMembership({ state: 'removed', persona: 'reader' })).toBeNull();
	expect(storedWorkspaceMembership({ state: 'member', persona: 'reader' })).toEqual({
		persona: 'reader',
	});
	expect(
		workspaceMembershipRow({ agentClientId: 'sender', state: 'member', persona: 'reader' }),
	).toEqual({ key: 'member:sender', value: { state: 'member', persona: 'reader' } });
	expect(
		workspaceMembershipRow({ agentClientId: 'sender', state: 'removed', persona: 'reader' }),
	).toEqual({ key: 'member:sender', value: { state: 'removed', persona: 'reader' } });
});
it('rejects corrupt rows, legacy admission bytes and empty identities', () => {
	expect(() => storedWorkspaceMembership({ state: 'listed' })).toThrow();
	expect(() =>
		storedWorkspaceMembership({ state: 'member', persona: 'reader', extra: true }),
	).toThrow();
	expect(() => storedWorkspaceMembership({ state: 'unknown' })).toThrow();
	expect(() =>
		workspaceMembershipRow({ agentClientId: '', state: 'member', persona: 'reader' }),
	).toThrow();
});
