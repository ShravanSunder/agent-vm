import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createClient, type ResolveAllResponse, type ResolveReferenceError } from '@1password/sdk';

import type { SecretRef, SecretResolver } from './contracts.js';

type ConfigSecretRef = Extract<SecretRef, { readonly source: 'config' }>;
type OnePasswordSecretRef = Extract<SecretRef, { readonly source: '1password' }>;

export interface SecretResolverClient {
	readonly secrets: {
		resolve(secretReference: string): Promise<string>;
		resolveAll(secretReferences: readonly string[]): Promise<ResolveAllResponse>;
	};
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

function formatUnknownError(error: unknown): string {
	if (error instanceof AggregateError) {
		const childMessages = readAggregateErrorChildren(error).map(formatUnknownError);
		if (childMessages.length === 0) {
			return error.message;
		}
		const separator = error.message.endsWith('.') ? '' : '.';
		return `${error.message}${separator} Details: ${childMessages.join('; ')}`;
	}
	return error instanceof Error ? error.message : String(error);
}

class RedactedExecFileError extends Error {
	constructor(
		message: string,
		readonly safeDetail: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.name = 'RedactedExecFileError';
	}
}

class OpInjectOutputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OpInjectOutputError';
	}
}

function formatErrorMetadataValue(value: unknown): string | undefined {
	if (typeof value === 'number' || typeof value === 'string') {
		return String(value);
	}
	return undefined;
}

function readErrorCode(error: Error): string | undefined {
	if (!('code' in error)) {
		return undefined;
	}
	return formatErrorMetadataValue(error.code);
}

function readErrorSignal(error: Error): string | undefined {
	if (!('signal' in error)) {
		return undefined;
	}
	return formatErrorMetadataValue(error.signal);
}

function formatRedactedExecErrorDetail(error: Error): string {
	const exitCode = readErrorCode(error) ?? 'unknown';
	const signal = readErrorSignal(error);
	return signal === undefined ? `exit code ${exitCode}` : `exit code ${exitCode}, signal ${signal}`;
}

function createExecFileError(options: {
	readonly command: string;
	readonly error: Error;
	readonly redactErrorOutput?: boolean | undefined;
	readonly stderr: string;
}): Error {
	if (options.redactErrorOutput) {
		const safeDetail = formatRedactedExecErrorDetail(options.error);
		return new RedactedExecFileError(`${options.command} failed: ${safeDetail}`, safeDetail);
	}

	const errorDetail = options.stderr.trim() || options.error.message;
	return new Error(`${options.command} failed: ${errorDetail}`);
}

function formatStdinWriteErrorDetail(error: Error): string {
	const errorCode = readErrorCode(error);
	return errorCode === undefined ? 'stdin write failed' : `stdin write failed: ${errorCode}`;
}

function createStdinWriteError(command: string, error: Error, redactErrorOutput?: boolean): Error {
	if (redactErrorOutput) {
		const safeDetail = formatStdinWriteErrorDetail(error);
		return new RedactedExecFileError(`${command} failed writing stdin: ${safeDetail}`, safeDetail, {
			cause: error,
		});
	}
	return new Error(`${command} failed writing stdin: ${formatUnknownError(error)}`, {
		cause: error,
	});
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
		let hasSettled = false;
		const rejectOnce = (error: Error): void => {
			if (hasSettled) {
				return;
			}
			hasSettled = true;
			reject(error);
		};
		const resolveOnce = (result: ExecFileResult): void => {
			if (hasSettled) {
				return;
			}
			hasSettled = true;
			resolve(result);
		};
		const child = execFile(
			command,
			[...args],
			{ env: options?.env, timeout: 30_000 },
			(error, stdout, stderr) => {
				if (error) {
					rejectOnce(
						createExecFileError({
							command,
							error,
							redactErrorOutput: options?.redactErrorOutput,
							stderr,
						}),
					);
					return;
				}

				resolveOnce({ stdout, stderr });
			},
		);
		if (options?.input !== undefined) {
			if (!child.stdin) {
				child.kill();
				rejectOnce(new Error(`${command} did not expose stdin for input`));
				return;
			}
			child.stdin.once('error', (error: Error) => {
				child.kill();
				rejectOnce(createStdinWriteError(command, error, options.redactErrorOutput));
			});
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
			const result = await exec('op', ['read', source.ref], { redactErrorOutput: true });
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

function resolveConfigSecretValue(ref: ConfigSecretRef): string {
	if (ref.value.trim().length === 0) {
		throw new Error('Config secret value is empty.');
	}
	return ref.value;
}

function createCompositeOnlySecretSourceError(
	source: Exclude<SecretRef['source'], '1password' | 'config'>,
): Error {
	return new Error(
		`Secret source '${source}' must be resolved by the composite resolver before reaching the 1Password resolver.`,
	);
}

interface SplitSecretRefs {
	readonly onePasswordRefs: Record<string, OnePasswordSecretRef>;
	readonly resolvedSecrets: Record<string, string>;
}

function splitSecretRefs(refs: Record<string, SecretRef>): SplitSecretRefs {
	const onePasswordRefs: Record<string, OnePasswordSecretRef> = {};
	const resolvedSecrets: Record<string, string> = {};

	for (const [secretName, secretRef] of Object.entries(refs)) {
		switch (secretRef.source) {
			case '1password':
				onePasswordRefs[secretName] = secretRef;
				break;
			case 'config':
				resolvedSecrets[secretName] = resolveConfigSecretValue(secretRef);
				break;
			case 'environment':
				throw createCompositeOnlySecretSourceError(secretRef.source);
			default: {
				const exhaustiveCheck: never = secretRef;
				throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
			}
		}
	}

	return { onePasswordRefs, resolvedSecrets };
}

function hasOnePasswordRefs(refs: Record<string, OnePasswordSecretRef>): boolean {
	return Object.keys(refs).length > 0;
}

function mergeResolvedSecrets(
	resolvedSecrets: Record<string, string>,
	onePasswordSecrets: Record<string, string>,
): Record<string, string> {
	return {
		...resolvedSecrets,
		...onePasswordSecrets,
	};
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
		env: createOpCliServiceAccountEnv(serviceAccountToken),
		redactErrorOutput: true,
	});
	return stripOpReadStdoutTerminator(result.stdout);
}

function stripOpReadStdoutTerminator(stdout: string): string {
	if (stdout.endsWith('\r\n')) {
		return stdout.slice(0, -2);
	}
	if (stdout.endsWith('\n')) {
		return stdout.slice(0, -1);
	}
	return stdout;
}

// This is an allowlist for process plumbing only. Do not add ambient OP_* auth
// variables here; they can switch `op` away from agent-vm's service account token.
const opCliProcessPlumbingEnvNames = [
	'APPDATA',
	'ALL_PROXY',
	'all_proxy',
	'COMSPEC',
	'HOME',
	'HTTP_PROXY',
	'http_proxy',
	'HTTPS_PROXY',
	'https_proxy',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'LOCALAPPDATA',
	'NO_PROXY',
	'no_proxy',
	'PATH',
	'SSL_CERT_DIR',
	'SSL_CERT_FILE',
	'TEMP',
	'TMP',
	'TMPDIR',
	'TZ',
	'USERPROFILE',
	'WINDIR',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_RUNTIME_DIR',
] satisfies readonly string[];

function createOpCliServiceAccountEnv(
	serviceAccountToken: string,
): Readonly<Record<string, string | undefined>> {
	const env: Record<string, string | undefined> = {};
	for (const envName of opCliProcessPlumbingEnvNames) {
		const envValue = process.env[envName];
		if (envValue !== undefined) {
			env[envName] = envValue;
		}
	}
	env.OP_SERVICE_ACCOUNT_TOKEN = serviceAccountToken;
	return env;
}

const opInjectTemplateDelimiterPattern = /(?:\{\{|\}\})/u;

function assertOpInjectTemplateSafeReference(entry: OpInjectEntry): void {
	if (
		!opInjectTemplateDelimiterPattern.test(entry.secretRef.ref) &&
		!entry.secretRef.ref.includes('\u0000') &&
		!entry.secretRef.ref.includes('\r') &&
		!entry.secretRef.ref.includes('\n')
	) {
		return;
	}
	throw new OpInjectOutputError(
		`op inject template rejected unsafe 1Password reference for secret '${entry.secretName}'.`,
	);
}

// Batch fallback for the SDK path is op inject only. We deliberately do not
// chain to a serial `op read` loop: with two-level fallback (SDK → op inject),
// the secret-management package's resolveAll API stays safe to call
// concurrently. Adding a serial-op-read tier re-introduces the "concurrent
// `op read` failures with the same service account token" hazard at the
// outer-call layer whenever multiple callers fall back at once.
async function resolveAllSecretsWithOpCli(
	serviceAccountToken: string,
	refs: Record<string, OnePasswordSecretRef>,
	exec: (
		command: string,
		args: readonly string[],
		options?: ExecFileOptions,
	) => Promise<ExecFileResult>,
): Promise<Record<string, string>> {
	return await resolveAllSecretsWithOpInject(serviceAccountToken, refs, exec);
}

function readAggregateErrorChildren(error: AggregateError): readonly unknown[] {
	const errorChildren: unknown = error.errors;
	return Array.isArray(errorChildren) ? errorChildren : [];
}

function createAggregateErrorWithCause(options: {
	readonly cause: unknown;
	readonly errors: readonly unknown[];
	readonly message: string;
}): AggregateError {
	const aggregateError = new AggregateError(options.errors, options.message);
	aggregateError.cause = options.cause;
	return aggregateError;
}

function createFallbackStageError(stage: string, error: unknown): Error {
	return new Error(`${stage} failed before op CLI fallback: ${formatUnknownError(error)}`, {
		cause: error,
	});
}

function createFallbackFailureError(options: {
	readonly fallbackError: unknown;
	readonly message: string;
	readonly stageError: Error;
}): AggregateError {
	if (options.fallbackError instanceof AggregateError) {
		return createAggregateErrorWithCause({
			cause: options.fallbackError,
			errors: [options.stageError, ...readAggregateErrorChildren(options.fallbackError)],
			message: options.fallbackError.message,
		});
	}
	return createAggregateErrorWithCause({
		cause: options.fallbackError,
		errors: [options.stageError, options.fallbackError],
		message: options.message,
	});
}

interface OpInjectEntry {
	readonly markerId: string;
	readonly secretName: string;
	readonly secretRef: OnePasswordSecretRef;
}

function opInjectStartMarker(markerId: string): string {
	return `agent-vm-op-inject-start:${markerId}`;
}

function opInjectEndMarker(markerId: string): string {
	return `agent-vm-op-inject-end:${markerId}`;
}

function createOpInjectEntries(
	refs: Record<string, OnePasswordSecretRef>,
): readonly OpInjectEntry[] {
	return Object.entries(refs).map(([secretName, secretRef]) => ({
		markerId: randomUUID(),
		secretName,
		secretRef,
	}));
}

function buildOpInjectTemplate(entries: readonly OpInjectEntry[]): string {
	return entries
		.map((entry) => {
			assertOpInjectTemplateSafeReference(entry);
			return [
				opInjectStartMarker(entry.markerId),
				`{{ ${entry.secretRef.ref} }}`,
				opInjectEndMarker(entry.markerId),
			].join('\n');
		})
		.join('\n');
}

function findUniqueOpInjectMarker(options: {
	readonly marker: string;
	readonly markerDescription: string;
	readonly output: string;
	readonly secretName: string;
	readonly secretReference: string;
}): number {
	const markerIndex = options.output.indexOf(options.marker);
	if (markerIndex === -1) {
		throw new OpInjectOutputError(
			`op inject output omitted ${options.markerDescription} marker for secret '${options.secretName}' (${options.secretReference}).`,
		);
	}
	const repeatedMarkerIndex = options.output.indexOf(
		options.marker,
		markerIndex + options.marker.length,
	);
	if (repeatedMarkerIndex !== -1) {
		throw new OpInjectOutputError(
			`op inject output for secret '${options.secretName}' (${options.secretReference}) contained repeated ${options.markerDescription} marker.`,
		);
	}
	return markerIndex;
}

function extractInjectedSecret(options: {
	readonly entry: OpInjectEntry;
	readonly output: string;
}): string {
	const startToken = `${opInjectStartMarker(options.entry.markerId)}\n`;
	const endToken = `\n${opInjectEndMarker(options.entry.markerId)}`;
	const valueStartIndex = findUniqueOpInjectMarker({
		marker: startToken,
		markerDescription: 'start',
		output: options.output,
		secretName: options.entry.secretName,
		secretReference: options.entry.secretRef.ref,
	});
	const secretStartIndex = valueStartIndex + startToken.length;
	const secretEndIndex = findUniqueOpInjectMarker({
		marker: endToken,
		markerDescription: 'end',
		output: options.output,
		secretName: options.entry.secretName,
		secretReference: options.entry.secretRef.ref,
	});
	return options.output.slice(secretStartIndex, secretEndIndex);
}

function mapOpInjectOutput(
	entries: readonly OpInjectEntry[],
	output: string,
): Record<string, string> {
	return Object.fromEntries(
		entries.map((entry) => [
			entry.secretName,
			extractInjectedSecret({
				entry,
				output,
			}),
		]),
	);
}

async function resolveAllSecretsWithOpInject(
	serviceAccountToken: string,
	refs: Record<string, OnePasswordSecretRef>,
	exec: (
		command: string,
		args: readonly string[],
		options?: ExecFileOptions,
	) => Promise<ExecFileResult>,
): Promise<Record<string, string>> {
	const entries = createOpInjectEntries(refs);
	if (entries.length === 0) {
		return {};
	}

	const result = await exec('op', ['inject', '--in-file', '/dev/stdin'], {
		env: createOpCliServiceAccountEnv(serviceAccountToken),
		input: buildOpInjectTemplate(entries),
		redactErrorOutput: true,
	});
	return mapOpInjectOutput(entries, result.stdout);
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
	refs: Record<string, OnePasswordSecretRef>,
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
				switch (ref.source) {
					case 'config':
						return resolveConfigSecretValue(ref);
					case 'environment':
						throw createCompositeOnlySecretSourceError(ref.source);
					case '1password':
						break;
					default: {
						const exhaustiveCheck: never = ref;
						throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
					}
				}
				try {
					return await client.secrets.resolve(ref.ref);
				} catch (error) {
					const sdkResolveError = createFallbackStageError('1Password SDK resolve', error);
					try {
						return await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec);
					} catch (fallbackError) {
						throw createFallbackFailureError({
							fallbackError,
							message: '1Password SDK resolve and op CLI fallback both failed.',
							stageError: sdkResolveError,
						});
					}
				}
			},
			resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> => {
				const splitRefs = splitSecretRefs(refs);
				if (!hasOnePasswordRefs(splitRefs.onePasswordRefs)) {
					return splitRefs.resolvedSecrets;
				}
				try {
					const response = await client.secrets.resolveAll(
						Object.values(splitRefs.onePasswordRefs).map((secretRef) => secretRef.ref),
					);
					return mergeResolvedSecrets(
						splitRefs.resolvedSecrets,
						mapSdkResolveAllResponse(splitRefs.onePasswordRefs, response),
					);
				} catch (error) {
					const sdkResolveAllError = createFallbackStageError('1Password SDK resolveAll', error);
					try {
						return mergeResolvedSecrets(
							splitRefs.resolvedSecrets,
							await resolveAllSecretsWithOpCli(
								options.serviceAccountToken,
								splitRefs.onePasswordRefs,
								exec,
							),
						);
					} catch (fallbackError) {
						throw createFallbackFailureError({
							fallbackError,
							message: '1Password SDK resolveAll and op CLI fallback both failed.',
							stageError: sdkResolveAllError,
						});
					}
				}
			},
		};
	} catch (error) {
		const sdkClientCreationError = createFallbackStageError('1Password SDK client creation', error);
		return {
			resolve: async (ref: SecretRef): Promise<string> => {
				switch (ref.source) {
					case 'config':
						return resolveConfigSecretValue(ref);
					case 'environment':
						throw createCompositeOnlySecretSourceError(ref.source);
					case '1password':
						break;
					default: {
						const exhaustiveCheck: never = ref;
						throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`, {
							cause: error,
						});
					}
				}
				try {
					return await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec);
				} catch (fallbackError) {
					throw createFallbackFailureError({
						fallbackError,
						message: '1Password SDK client creation and op CLI fallback both failed.',
						stageError: sdkClientCreationError,
					});
				}
			},
			resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> => {
				const splitRefs = splitSecretRefs(refs);
				if (!hasOnePasswordRefs(splitRefs.onePasswordRefs)) {
					return splitRefs.resolvedSecrets;
				}
				try {
					return mergeResolvedSecrets(
						splitRefs.resolvedSecrets,
						await resolveAllSecretsWithOpCli(
							options.serviceAccountToken,
							splitRefs.onePasswordRefs,
							exec,
						),
					);
				} catch (fallbackError) {
					throw createFallbackFailureError({
						fallbackError,
						message: '1Password SDK client creation and op CLI fallback both failed.',
						stageError: sdkClientCreationError,
					});
				}
			},
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
		resolve: async (ref: SecretRef): Promise<string> => {
			switch (ref.source) {
				case 'config':
					return resolveConfigSecretValue(ref);
				case 'environment':
					throw createCompositeOnlySecretSourceError(ref.source);
				case '1password':
					return await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec);
				default: {
					const exhaustiveCheck: never = ref;
					throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
				}
			}
		},
		resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> => {
			const splitRefs = splitSecretRefs(refs);
			if (!hasOnePasswordRefs(splitRefs.onePasswordRefs)) {
				return splitRefs.resolvedSecrets;
			}
			return mergeResolvedSecrets(
				splitRefs.resolvedSecrets,
				await resolveAllSecretsWithOpCli(
					options.serviceAccountToken,
					splitRefs.onePasswordRefs,
					exec,
				),
			);
		},
	};
}
