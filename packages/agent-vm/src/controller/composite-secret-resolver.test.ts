import type { SecretResolver } from '@shravansunder/gondolin-core';
import { describe, expect, it, vi } from 'vitest';

import { createCompositeSecretResolver } from './composite-secret-resolver.js';

describe('createCompositeSecretResolver', () => {
	it('resolves environment secrets from process env', async () => {
		const resolver = createCompositeSecretResolver(null, {
			OPENAI_API_KEY: 'sk-test',
		});

		await expect(resolver.resolve({ source: 'environment', ref: 'OPENAI_API_KEY' })).resolves.toBe(
			'sk-test',
		);
	});

	it('routes onepassword secrets to the wrapped resolver', async () => {
		const resolveOnePasswordSecret = vi.fn(async (ref) => `resolved:${ref.ref}`);
		const onePasswordResolver: SecretResolver = {
			resolve: resolveOnePasswordSecret,
			resolveAll: vi.fn(async () => ({})),
		};
		const resolver = createCompositeSecretResolver(onePasswordResolver, {});

		await expect(
			resolver.resolve({ source: '1password', ref: 'op://vault/item/field' }),
		).resolves.toBe('resolved:op://vault/item/field');
		expect(resolveOnePasswordSecret).toHaveBeenCalledWith({
			source: '1password',
			ref: 'op://vault/item/field',
		});
	});

	it('throws when environment variable is unset', async () => {
		const resolver = createCompositeSecretResolver(null, {});

		await expect(
			resolver.resolve({ source: 'environment', ref: 'OPENAI_API_KEY' }),
		).rejects.toThrow("Environment variable 'OPENAI_API_KEY' is not set.");
	});

	it('throws when onepassword secret is requested without a configured provider', async () => {
		const resolver = createCompositeSecretResolver(null, {});

		await expect(
			resolver.resolve({ source: '1password', ref: 'op://vault/item/field' }),
		).rejects.toThrow(
			"Secret with source '1password' requires host.secretsProvider to be configured.",
		);
	});

	it('resolveAll handles mixed secret sources', async () => {
		const onePasswordResolver: SecretResolver = {
			resolve: vi.fn(async (ref) => `resolved:${ref.ref}`),
			resolveAll: vi.fn(async () => ({})),
		};
		const resolver = createCompositeSecretResolver(onePasswordResolver, {
			GITHUB_TOKEN: 'gh-token',
		});

		await expect(
			resolver.resolveAll({
				OPENAI_API_KEY: { source: '1password', ref: 'op://vault/openai/token' },
				GITHUB_TOKEN: { source: 'environment', ref: 'GITHUB_TOKEN' },
			}),
		).resolves.toEqual({
			OPENAI_API_KEY: 'resolved:op://vault/openai/token',
			GITHUB_TOKEN: 'gh-token',
		});
	});
});
