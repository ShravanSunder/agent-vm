import { describe, expect, it } from 'vitest';

import { parseHmacKeysFromEnv, portalHmacKeyEnvName } from './hmac-env.js';

describe('portal HMAC key env helpers', () => {
	it('round-trips agent ids through the env var name convention', () => {
		expect(portalHmacKeyEnvName('agent-a')).toBe('PORTAL_HMAC_KEY__agent-a');
	});

	it('parses valid hex keys and ignores unrelated env vars', () => {
		const keyHex = '00'.repeat(32);

		const keys = parseHmacKeysFromEnv({
			NODE_ENV: 'test',
			[portalHmacKeyEnvName('agent-a')]: keyHex,
		});

		expect(keys.get('agent-a')?.equals(Buffer.from(keyHex, 'hex'))).toBe(true);
		expect(keys.size).toBe(1);
	});

	it('rejects malformed key material', () => {
		expect(() => parseHmacKeysFromEnv({ [portalHmacKeyEnvName('agent-a')]: 'not-hex' })).toThrow(
			/PORTAL_HMAC_KEY__agent-a/u,
		);
	});
});
