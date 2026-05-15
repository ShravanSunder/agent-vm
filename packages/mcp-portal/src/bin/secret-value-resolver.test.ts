import { describe, expect, it, vi } from 'vitest';

import { resolveSecretValue } from './secret-value-resolver.js';

describe('resolveSecretValue', () => {
	it('reads environment secrets', async () => {
		await expect(
			resolveSecretValue(
				{ name: 'MCP_PORTAL_SECRET', source: 'environment' },
				{ env: { MCP_PORTAL_SECRET: 'secret-value' } },
			),
		).resolves.toBe('secret-value');
	});

	it('rejects missing environment secrets', async () => {
		await expect(
			resolveSecretValue({ name: 'MCP_PORTAL_SECRET', source: 'environment' }, { env: {} }),
		).rejects.toThrow(/MCP_PORTAL_SECRET/u);
	});

	it('uses injected 1Password reader for op refs', async () => {
		const readOnePasswordSecret = vi.fn(async () => 'op-secret');

		await expect(
			resolveSecretValue(
				{ ref: 'op://vault/item/field', source: '1password' },
				{ env: {}, readOnePasswordSecret },
			),
		).resolves.toBe('op-secret');
		expect(readOnePasswordSecret).toHaveBeenCalledWith('op://vault/item/field');
	});
});
