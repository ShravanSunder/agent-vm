import { createClient } from '@1password/sdk';

import type { SecretRef } from './types.js';

export interface SecretResolverClient {
	readonly secrets: {
		resolve(secretReference: string): Promise<string>;
		resolveAll(secretReferences: readonly string[]): Promise<unknown>;
	};
}

export interface SecretResolver {
	resolve(ref: SecretRef): Promise<string>;
	resolveAll(refs: Record<string, SecretRef>): Promise<Record<string, string>>;
}

export interface CreateSecretResolverDependencies {
	readonly createClient?: (config: {
		auth: string;
		integrationName: string;
		integrationVersion: string;
	}) => Promise<SecretResolverClient>;
	readonly integrationName?: string;
	readonly integrationVersion?: string;
}

export async function createSecretResolver(
	options: {
		readonly serviceAccountToken: string;
	},
	dependencies: CreateSecretResolverDependencies = {},
): Promise<SecretResolver> {
	const client = await (dependencies.createClient ?? createClient)({
		auth: options.serviceAccountToken,
		integrationName: dependencies.integrationName ?? 'agent-vm',
		integrationVersion: dependencies.integrationVersion ?? '0.1.0',
	});

	return {
		resolve: async (ref: SecretRef): Promise<string> => client.secrets.resolve(ref.ref),
		resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> => {
			const resolvedEntries = await Promise.all(
				Object.entries(refs).map(
					async ([secretName, secretRef]) =>
						[secretName, await client.secrets.resolve(secretRef.ref)] as const,
				),
			);

			return resolvedEntries.reduce<Record<string, string>>(
				(resolvedSecrets, [secretName, value]) => {
					resolvedSecrets[secretName] = value;
					return resolvedSecrets;
				},
				{},
			);
		},
	};
}
