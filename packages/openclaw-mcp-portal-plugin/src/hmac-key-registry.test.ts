import { describe, expect, it } from 'vitest';

import { createHmacKeyRegistry } from './hmac-key-registry.js';

describe('createHmacKeyRegistry', () => {
	it('generates one 32-byte key per agent', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['shravan', 'alevtina'] });

		expect(registry.agentIds).toEqual(['shravan', 'alevtina']);
		expect(registry.getKey('shravan')).toHaveLength(32);
		expect(registry.getKey('alevtina')).toHaveLength(32);
		expect(registry.getKey('shravan').equals(registry.getKey('alevtina'))).toBe(false);
	});

	it('throws when asking for an unknown agent', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['shravan'] });

		expect(() => registry.getKey('alevtina')).toThrow(/unknown agent/u);
	});

	it('serializes keys for portal subprocess env', () => {
		const registry = createHmacKeyRegistry({ agentIds: ['agent-a'] });

		expect(registry.serializeForEnv()).toEqual({
			'PORTAL_HMAC_KEY__agent-a': expect.stringMatching(/^[0-9a-f]{64}$/u),
		});
	});
});
