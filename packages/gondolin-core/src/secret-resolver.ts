import { execFile } from 'node:child_process';

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

// --- Token source: how to obtain the 1Password service account token ---

export type TokenSource =
	| { readonly type: 'op-cli'; readonly ref: string }
	| { readonly type: 'env'; readonly envVar?: string | undefined }
	| { readonly type: 'keychain'; readonly service: string; readonly account: string };

export interface ExecFileOptions {
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ExecFileResult {
	readonly stdout: string;
	readonly stderr: string;
}

function execFileAsync(
	command: string,
	args: readonly string[],
	options?: ExecFileOptions,
): Promise<ExecFileResult> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{ env: options?.env, timeout: 30_000 },
			(error, stdout, stderr) => {
				if (error) {
					const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
					reject(new Error(`${command} failed: ${stderr.trim() || errorMessage}`));
					return;
				}

				resolve({ stdout, stderr });
			},
		);
	});
}

const SAFE_IDENTIFIER_PATTERN = /^[\w.@-]+$/u;

export async function resolveServiceAccountToken(
	source: TokenSource,
	dependencies?: {
		readonly execFileAsync?: (
			command: string,
			args: readonly string[],
			options?: ExecFileOptions,
		) => Promise<ExecFileResult>;
	},
): Promise<string> {
	const exec = dependencies?.execFileAsync ?? execFileAsync;

	switch (source.type) {
		case 'op-cli': {
			// Uses `op read` which triggers biometric auth (Touch ID) on macOS
			const result = await exec('op', ['read', source.ref]);
			const token = result.stdout.trim();
			if (token.length === 0) {
				throw new Error('op-cli token resolution returned empty value');
			}

			return token;
		}

		case 'env': {
			const envVar = source.envVar ?? 'OP_SERVICE_ACCOUNT_TOKEN';
			const token = process.env[envVar]?.trim();
			if (!token) {
				throw new Error(`Environment variable ${envVar} is not set`);
			}

			return token;
		}

		case 'keychain': {
			// Validate keychain identifiers to prevent argument injection
			if (!SAFE_IDENTIFIER_PATTERN.test(source.service)) {
				throw new Error('Keychain service name contains invalid characters');
			}

			if (!SAFE_IDENTIFIER_PATTERN.test(source.account)) {
				throw new Error('Keychain account name contains invalid characters');
			}

			// macOS Keychain via `security find-generic-password`
			const result = await exec('security', [
				'find-generic-password',
				'-s',
				source.service,
				'-a',
				source.account,
				'-w',
			]);
			const token = result.stdout.trim();
			if (token.length === 0) {
				throw new Error('Keychain token resolution returned empty value');
			}

			return token;
		}
		default:
			throw new Error(`Unsupported token source: ${JSON.stringify(source)}`);
	}
}

// --- Secret resolver: uses the token to resolve secrets via 1Password SDK ---

export interface CreateSecretResolverDependencies {
	readonly createClient?: (config: {
		auth: string;
		integrationName: string;
		integrationVersion: string;
	}) => Promise<SecretResolverClient>;
	readonly execFileAsync?: (
		command: string,
		args: readonly string[],
		options?: ExecFileOptions,
	) => Promise<ExecFileResult>;
	readonly integrationName?: string;
	readonly integrationVersion?: string;
}

async function resolveSecretWithOpCli(
	serviceAccountToken: string,
	secretReference: string,
	exec: (
		command: string,
		args: readonly string[],
		options?: ExecFileOptions,
	) => Promise<ExecFileResult>,
): Promise<string> {
	const result = await exec('op', ['read', secretReference], {
		env: {
			...process.env,
			OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken,
		},
	});
	return result.stdout.trim();
}

export async function createSecretResolver(
	options: {
		readonly serviceAccountToken: string;
	},
	dependencies: CreateSecretResolverDependencies = {},
): Promise<SecretResolver> {
	try {
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
	} catch {
		const exec = dependencies.execFileAsync ?? execFileAsync;

		return {
			resolve: async (ref: SecretRef): Promise<string> =>
				await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec),
			resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> => {
				const resolvedEntries = await Promise.all(
					Object.entries(refs).map(
						async ([secretName, secretRef]) =>
							[
								secretName,
								await resolveSecretWithOpCli(options.serviceAccountToken, secretRef.ref, exec),
							] as const,
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
}
