import { describe, expect, it } from 'vitest';

import { createSecretResolver, type SecretResolverClient } from './secret-resolver.js';

describe('createSecretResolver', () => {
	it('resolves a single secret reference through the sdk client', async () => {
		const resolvedReferences: string[] = [];
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => {
					resolvedReferences.push(secretReference);
					return `resolved:${secretReference}`;
				},
				resolveAll: async () => ({
					individualResponses: {},
				}),
			},
		};

		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'op-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => fakeClient,
			},
		);

		await expect(
			secretResolver.resolve({
				source: '1password',
				ref: 'op://AI/anthropic/api-key',
			}),
		).resolves.toBe('resolved:op://AI/anthropic/api-key');
		expect(resolvedReferences).toEqual(['op://AI/anthropic/api-key']);
	});

	it('resolves a record of secret references and preserves keys', async () => {
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => `resolved:${secretReference}`,
				resolveAll: async () => ({
					individualResponses: {},
				}),
			},
		};

		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'op-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => fakeClient,
			},
		);

		await expect(
			secretResolver.resolveAll({
				ANTHROPIC_API_KEY: {
					source: '1password',
					ref: 'op://AI/anthropic/api-key',
				},
				GITHUB_PAT: {
					source: '1password',
					ref: 'op://AI/github/pat',
				},
			}),
		).resolves.toEqual({
			ANTHROPIC_API_KEY: 'resolved:op://AI/anthropic/api-key',
			GITHUB_PAT: 'resolved:op://AI/github/pat',
		});
	});
});
