import { describe, expect, it } from 'vitest';

import { ZoneGitCapabilityStore } from './zone-git-capability-store.js';

describe('ZoneGitCapabilityStore', () => {
	it('issues one stable token per zone', () => {
		const generatedTokens = ['token-a', 'token-b'];
		const store = new ZoneGitCapabilityStore({
			generateToken: () => {
				const nextToken = generatedTokens.shift();
				if (!nextToken) {
					throw new Error('Unexpected token generation.');
				}
				return nextToken;
			},
		});

		expect(store.issueTokenForZone('sunfam')).toBe('token-a');
		expect(store.issueTokenForZone('sunfam')).toBe('token-a');
		expect(store.issueTokenForZone('work')).toBe('token-b');
	});

	it('builds the runtime plugin config and verifies tokens by zone', () => {
		const store = new ZoneGitCapabilityStore({ generateToken: () => 'zone-token' });

		expect(store.buildRuntimePluginConfig('sunfam')).toEqual({
			gondolin: { zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN' },
		});
		expect(store.buildRuntimeEnvironment('sunfam')).toEqual({
			AGENT_VM_ZONE_GIT_TOKEN: 'zone-token',
		});
		expect(store.verifyTokenForZone('sunfam', 'zone-token')).toBe(true);
		expect(store.verifyTokenForZone('sunfam', undefined)).toBe(false);
		expect(store.verifyTokenForZone('sunfam', 'wrong-token')).toBe(false);
		expect(store.verifyTokenForZone('work', 'zone-token')).toBe(false);
	});
});
