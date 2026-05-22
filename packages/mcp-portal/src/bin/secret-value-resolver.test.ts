import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { resolveSecretValue } from './secret-value-resolver.js';

describe('resolveSecretValue', () => {
	it('does not shell out to op directly', async () => {
		const source = await readFile(new URL('./secret-value-resolver.ts', import.meta.url), 'utf8');

		expect(source).not.toContain('node:child_process');
		expect(source).not.toContain("execFileAsync('op'");
	});

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

	it('uses injected shared resolver for 1Password refs', async () => {
		const secretResolver = {
			resolve: vi.fn(async () => 'op-secret'),
			resolveAll: vi.fn(),
		};

		await expect(
			resolveSecretValue(
				{ ref: 'op://vault/item/field', source: '1password' },
				{ env: {}, secretResolver },
			),
		).resolves.toBe('op-secret');
		expect(secretResolver.resolve).toHaveBeenCalledWith({
			ref: 'op://vault/item/field',
			source: '1password',
		});
	});
});
