import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createClient, type ResolveAllResponse, type ResolveReferenceError } from '@1password/sdk';

import type { SecretRef } from './types.js';

export interface SecretResolverClient {
	readonly secrets: {
		resolve(secretReference: string): Promise<string>;
		resolveAll(secretReferences: readonly string[]): Promise<ResolveAllResponse>;
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
	readonly input?: string | undefined;
	readonly redactErrorOutput?: boolean | undefined;
}

export interface ExecFileResult {
	readonly stdout: string;
	readonly stderr: string;
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureMacOsForKeychain(): void {
	if (process.platform !== 'darwin') {
		throw new Error(
			'Keychain token source is only supported on macOS. Use an env or op-cli token source on this platform so cmd-ts can surface a clear startup error.',
		);
	}
}

function execFileAsync(
	command: string,
	args: readonly string[],
	options?: ExecFileOptions,
): Promise<ExecFileResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			[...args],
			{ env: options?.env, timeout: 30_000 },
			(error, stdout, stderr) => {
				if (error) {
					const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
					const errorDetail = options?.redactErrorOutput
						? errorMessage
						: stderr.trim() || errorMessage;
					reject(new Error(`${command} failed: ${errorDetail}`));
					return;
				}

				resolve({ stdout, stderr });
			},
		);
		if (options?.input !== undefined) {
			if (!child.stdin) {
				child.kill();
				reject(new Error(`${command} did not expose stdin for input`));
				return;
			}
			child.stdin.end(options.input);
		}
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
			ensureMacOsForKeychain();

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

async function resolveAllSecretsWithOpCli(
	serviceAccountToken: string,
	refs: Record<string, SecretRef>,
	exec: (
		command: string,
		args: readonly string[],
		options?: ExecFileOptions,
	) => Promise<ExecFileResult>,
): Promise<Record<string, string>> {
	try {
		return await resolveAllSecretsWithOpInject(serviceAccountToken, refs, exec);
	} catch {
		writeStderr(
			'[secret-resolver] op inject batch resolution failed; falling back to serial op read.',
		);
		return await resolveAllSecretsWithSerialOpReads(serviceAccountToken, refs, exec);
	}
}

function opInjectStartMarker(batchId: string, index: number): string {
	return `agent-vm-op-inject-start:${batchId}:${String(index)}`;
}

function opInjectEndMarker(batchId: string, index: number): string {
	return `agent-vm-op-inject-end:${batchId}:${String(index)}`;
}

function buildOpInjectTemplate(
	entries: readonly (readonly [string, SecretRef])[],
	batchId: string,
): string {
	return entries
		.map(([_secretName, secretRef], index) =>
			[
				opInjectStartMarker(batchId, index),
				`{{ ${secretRef.ref} }}`,
				opInjectEndMarker(batchId, index),
			].join('\n'),
		)
		.join('\n');
}

function extractInjectedSecret(options: {
	readonly batchId: string;
	readonly index: number;
	readonly output: string;
	readonly secretName: string;
	readonly secretReference: string;
}): string {
	const startToken = `${opInjectStartMarker(options.batchId, options.index)}\n`;
	const endToken = `\n${opInjectEndMarker(options.batchId, options.index)}`;
	const valueStartIndex = options.output.indexOf(startToken);
	if (valueStartIndex === -1) {
		throw new Error(
			`op inject output omitted start marker for secret '${options.secretName}' (${options.secretReference}).`,
		);
	}
	const secretStartIndex = valueStartIndex + startToken.length;
	const secretEndIndex = options.output.indexOf(endToken, secretStartIndex);
	if (secretEndIndex === -1) {
		throw new Error(
			`op inject output omitted end marker for secret '${options.secretName}' (${options.secretReference}).`,
		);
	}
	return options.output.slice(secretStartIndex, secretEndIndex).trim();
}

function mapOpInjectOutput(
	entries: readonly (readonly [string, SecretRef])[],
	batchId: string,
	output: string,
): Record<string, string> {
	return Object.fromEntries(
		entries.map(([secretName, secretRef], index) => [
			secretName,
			extractInjectedSecret({
				batchId,
				index,
				output,
				secretName,
				secretReference: secretRef.ref,
			}),
		]),
	);
}

async function resolveAllSecretsWithOpInject(
	serviceAccountToken: string,
	refs: Record<string, SecretRef>,
	exec: (
		command: string,
		args: readonly string[],
		options?: ExecFileOptions,
	) => Promise<ExecFileResult>,
): Promise<Record<string, string>> {
	const entries = Object.entries(refs);
	if (entries.length === 0) {
		return {};
	}

	const batchId = randomUUID();
	const result = await exec('op', ['inject'], {
		env: {
			...process.env,
			OP_SERVICE_ACCOUNT_TOKEN: serviceAccountToken,
		},
		input: buildOpInjectTemplate(entries, batchId),
		redactErrorOutput: true,
	});
	return mapOpInjectOutput(entries, batchId, result.stdout);
}

async function resolveAllSecretsWithSerialOpReads(
	serviceAccountToken: string,
	refs: Record<string, SecretRef>,
	exec: (
		command: string,
		args: readonly string[],
		options?: ExecFileOptions,
	) => Promise<ExecFileResult>,
): Promise<Record<string, string>> {
	const resolvedSecrets: Record<string, string> = {};
	const failures: Error[] = [];

	for (const [secretName, secretRef] of Object.entries(refs)) {
		try {
			// Sequential resolution avoids concurrent `op read` failures with the same service account token.
			// oxlint-disable-next-line eslint/no-await-in-loop
			resolvedSecrets[secretName] = await resolveSecretWithOpCli(
				serviceAccountToken,
				secretRef.ref,
				exec,
			);
		} catch (error) {
			failures.push(
				new Error(
					`Failed to resolve secret '${secretName}' from '${secretRef.ref}' via op read: ${formatUnknownError(error)}`,
					{ cause: error },
				),
			);
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`Failed to resolve ${String(failures.length)} secret(s) via op read.`,
		);
	}

	return resolvedSecrets;
}

function formatResolveReferenceError(error: ResolveReferenceError): string {
	return 'message' in error && typeof error.message === 'string'
		? `${error.type}: ${error.message}`
		: error.type;
}

function readSdkBatchSecret(options: {
	readonly response: ResolveAllResponse;
	readonly secretName: string;
	readonly secretReference: string;
}): string {
	const individualResponse = options.response.individualResponses[options.secretReference];
	if (!individualResponse) {
		throw new Error(
			`1Password SDK resolveAll response omitted '${options.secretName}' (${options.secretReference}).`,
		);
	}
	if (individualResponse.content !== undefined) {
		return individualResponse.content.secret;
	}
	if (individualResponse.error !== undefined) {
		throw new Error(
			`1Password SDK resolveAll failed for '${options.secretName}' (${options.secretReference}): ${formatResolveReferenceError(individualResponse.error)}`,
		);
	}
	throw new Error(
		`1Password SDK resolveAll returned neither content nor error for '${options.secretName}' (${options.secretReference}).`,
	);
}

function mapSdkResolveAllResponse(
	refs: Record<string, SecretRef>,
	response: ResolveAllResponse,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(refs).map(([secretName, secretRef]) => [
			secretName,
			readSdkBatchSecret({
				response,
				secretName,
				secretReference: secretRef.ref,
			}),
		]),
	);
}

export async function createSecretResolver(
	options: {
		readonly serviceAccountToken: string;
	},
	dependencies: CreateSecretResolverDependencies = {},
): Promise<SecretResolver> {
	const exec = dependencies.execFileAsync ?? execFileAsync;
	try {
		const client = await (dependencies.createClient ?? createClient)({
			auth: options.serviceAccountToken,
			integrationName: dependencies.integrationName ?? 'agent-vm',
			integrationVersion: dependencies.integrationVersion ?? '0.0.1',
		});

		return {
			resolve: async (ref: SecretRef): Promise<string> => {
				try {
					return await client.secrets.resolve(ref.ref);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeStderr(
						`[secret-resolver] 1Password SDK resolve failed for ${ref.ref}; falling back to op CLI: ${message}`,
					);
					return await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec);
				}
			},
			resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> => {
				try {
					const response = await client.secrets.resolveAll(
						Object.values(refs).map((secretRef) => secretRef.ref),
					);
					return mapSdkResolveAllResponse(refs, response);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeStderr(
						`[secret-resolver] 1Password SDK resolveAll failed; falling back to op CLI batch inject: ${message}`,
					);
					return await resolveAllSecretsWithOpCli(options.serviceAccountToken, refs, exec);
				}
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeStderr(
			`[secret-resolver] 1Password SDK client creation failed; falling back to op CLI: ${message}`,
		);
		return {
			resolve: async (ref: SecretRef): Promise<string> =>
				await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec),
			resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> =>
				await resolveAllSecretsWithOpCli(options.serviceAccountToken, refs, exec),
		};
	}
}

export async function createOpCliSecretResolver(
	options: {
		readonly serviceAccountToken: string;
	},
	dependencies: Pick<CreateSecretResolverDependencies, 'execFileAsync'> = {},
): Promise<SecretResolver> {
	const exec = dependencies.execFileAsync ?? execFileAsync;

	return {
		resolve: async (ref: SecretRef): Promise<string> =>
			await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec),
		resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> =>
			await resolveAllSecretsWithOpCli(options.serviceAccountToken, refs, exec),
	};
}
