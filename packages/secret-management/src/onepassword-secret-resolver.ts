import { randomUUID } from 'node:crypto';

import { createClient, type ResolveAllResponse, type ResolveReferenceError } from '@1password/sdk';

import type { SecretRef, SecretResolver } from './contracts.js';
import { withOpCliServiceAccountEnv } from './op-cli-service-account-env.js';
import { execFileAsync, type ExecFileOptions, type ExecFileResult } from './redacted-exec-file.js';
import { redactOnePasswordReferences } from './secret-redaction.js';

export type { ExecFileOptions, ExecFileResult } from './redacted-exec-file.js';

type ConfigSecretRef = Extract<SecretRef, { readonly source: 'config' }>;
type OnePasswordSecretRef = Extract<SecretRef, { readonly source: '1password' }>;

export interface SecretResolverClient {
	readonly secrets: {
		resolve(secretReference: string): Promise<string>;
		resolveAll(secretReferences: readonly string[]): Promise<ResolveAllResponse>;
	};
}

export interface OnePasswordServiceAccountHeadlessAuthProbeResult {
	readonly hint: string;
	readonly ok: boolean;
}

// --- Token source: how to obtain the 1Password service account token ---

export type TokenSource =
	| { readonly type: 'env'; readonly envVar?: string | undefined }
	| { readonly type: 'keychain'; readonly service: string; readonly account: string };

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

function redactKnownSecretValues(message: string, secretValues: readonly string[]): string {
	return secretValues.reduce((redactedMessage, secretValue) => {
		if (secretValue.length === 0) {
			return redactedMessage;
		}
		return redactedMessage.replaceAll(secretValue, '<redacted>');
	}, message);
}

function formatUnknownErrorWithRedactions(error: unknown, secretValues: readonly string[]): string {
	return redactOnePasswordReferences(
		redactKnownSecretValues(formatUnknownError(error), secretValues),
	);
}

class OpInjectOutputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OpInjectOutputError';
	}
}

function ensureMacOsForKeychain(): void {
	if (process.platform !== 'darwin') {
		throw new Error(
			'Keychain token source is only supported on macOS. Use an env token source on this platform so cmd-ts can surface a clear startup error.',
		);
	}
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
	return await withOpCliServiceAccountEnv(serviceAccountToken, async (env) => {
		const result = await exec('op', ['read', secretReference], {
			env,
			redactErrorOutput: true,
		});
		return stripOpReadStdoutTerminator(result.stdout);
	});
}

export function stripOpReadStdoutTerminator(stdout: string): string {
	if (stdout.endsWith('\r\n')) {
		return stdout.slice(0, -2);
	}
	if (stdout.endsWith('\n')) {
		return stdout.slice(0, -1);
	}
	return stdout;
}

function opWhoamiReportsServiceAccount(stdout: string): boolean {
	return /^User Type:\s*SERVICE_ACCOUNT\s*$/imu.test(stdout);
}

export async function probeOnePasswordServiceAccountHeadlessAuth(
	options: {
		readonly serviceAccountToken: string;
	},
	dependencies: {
		readonly execFileAsync?: (
			command: string,
			args: readonly string[],
			options?: ExecFileOptions,
		) => Promise<ExecFileResult>;
	} = {},
): Promise<OnePasswordServiceAccountHeadlessAuthProbeResult> {
	const exec = dependencies.execFileAsync ?? execFileAsync;
	try {
		return await withOpCliServiceAccountEnv(options.serviceAccountToken, async (env) => {
			const result = await exec('op', ['whoami'], {
				env,
				redactErrorOutput: true,
			});
			if (opWhoamiReportsServiceAccount(result.stdout)) {
				return {
					hint: 'op whoami returned SERVICE_ACCOUNT with isolated service-account env',
					ok: true,
				};
			}
			return {
				hint: 'op whoami did not report SERVICE_ACCOUNT with isolated service-account env',
				ok: false,
			};
		});
	} catch (error) {
		return {
			hint: `op whoami failed with isolated service-account env: ${formatUnknownErrorWithRedactions(
				error,
				[options.serviceAccountToken],
			)}`,
			ok: false,
		};
	}
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
//
// Concurrency contract — what's verified vs what's assumed:
//   ✓ @1password/sdk's client.secrets.resolveAll is concurrency-safe on a
//     single Client instance (SharedCore WASM, verified via deepwiki source
//     analysis of 1Password/onepassword-sdk-js). Callers can invoke resolveAll
//     concurrently from multiple async contexts.
//   ? Two concurrent `op inject` subprocesses with the same service-account
//     token: NOT verified. 1Password's published comment about concurrency
//     hazards specifically called out `op read`; `op inject` was not
//     discussed. In practice op inject is the SDK's fallback and is only
//     reached when the SDK already failed, so two concurrent op-inject
//     invocations require both SDKs to fail at the same instant — rare.
//     If a future contributor sees auth errors from concurrent fallback
//     paths, the next investigation step is to test concurrent op inject
//     directly and (if unsafe) add an outer-layer mutex here.
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

function createFallbackStageError(
	stage: string,
	error: unknown,
	secretValues: readonly string[] = [],
): Error {
	const message = `${stage} failed before op CLI fallback: ${formatUnknownErrorWithRedactions(
		error,
		secretValues,
	)}`;
	return secretValues.length === 0 ? new Error(message, { cause: error }) : new Error(message);
}

function createFallbackFailureError(options: {
	readonly fallbackError: unknown;
	readonly message: string;
	readonly secretValues?: readonly string[] | undefined;
	readonly stageError: Error;
}): AggregateError {
	const fallbackMessage = formatUnknownErrorWithRedactions(
		options.fallbackError,
		options.secretValues ?? [],
	);
	const redactedFallbackError =
		options.secretValues === undefined || options.secretValues.length === 0
			? new Error(fallbackMessage, { cause: options.fallbackError })
			: new Error(fallbackMessage);
	if (options.fallbackError instanceof AggregateError) {
		return createAggregateErrorWithCause({
			cause: redactedFallbackError,
			errors: [options.stageError, redactedFallbackError],
			message: fallbackMessage,
		});
	}
	return createAggregateErrorWithCause({
		cause: redactedFallbackError,
		errors: [options.stageError, redactedFallbackError],
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
}): number {
	const markerIndex = options.output.indexOf(options.marker);
	if (markerIndex === -1) {
		throw new OpInjectOutputError(
			`op inject output omitted ${options.markerDescription} marker for secret '${options.secretName}'.`,
		);
	}
	const repeatedMarkerIndex = options.output.indexOf(
		options.marker,
		markerIndex + options.marker.length,
	);
	if (repeatedMarkerIndex !== -1) {
		throw new OpInjectOutputError(
			`op inject output for secret '${options.secretName}' contained repeated ${options.markerDescription} marker.`,
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
	});
	const secretStartIndex = valueStartIndex + startToken.length;
	const secretEndIndex = findUniqueOpInjectMarker({
		marker: endToken,
		markerDescription: 'end',
		output: options.output,
		secretName: options.entry.secretName,
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

	return await withOpCliServiceAccountEnv(serviceAccountToken, async (env) => {
		const result = await exec('op', ['inject', '--in-file', '/dev/stdin'], {
			env,
			input: buildOpInjectTemplate(entries),
			redactErrorOutput: true,
		});
		return mapOpInjectOutput(entries, result.stdout);
	});
}

function formatResolveReferenceError(error: ResolveReferenceError): string {
	return 'message' in error && typeof error.message === 'string'
		? `${error.type}: ${error.message}`
		: error.type;
}

function readSdkBatchSecret(options: {
	readonly response: ResolveAllResponse;
	readonly secretReference: string;
	readonly secretName: string;
}): string {
	const individualResponse = options.response.individualResponses[options.secretReference];
	if (!individualResponse) {
		throw new Error(`1Password SDK resolveAll response omitted '${options.secretName}'.`);
	}
	if (individualResponse.content !== undefined) {
		return individualResponse.content.secret;
	}
	if (individualResponse.error !== undefined) {
		throw new Error(
			`1Password SDK resolveAll failed for '${options.secretName}': ${formatResolveReferenceError(individualResponse.error)}`,
		);
	}
	throw new Error(
		`1Password SDK resolveAll returned neither content nor error for '${options.secretName}'.`,
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
					const sdkResolveError = createFallbackStageError('1Password SDK resolve', error, [
						options.serviceAccountToken,
					]);
					try {
						return await resolveSecretWithOpCli(options.serviceAccountToken, ref.ref, exec);
					} catch (fallbackError) {
						throw createFallbackFailureError({
							fallbackError,
							message: '1Password SDK resolve and op CLI fallback both failed.',
							secretValues: [options.serviceAccountToken],
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
					const sdkResolveAllError = createFallbackStageError('1Password SDK resolveAll', error, [
						options.serviceAccountToken,
					]);
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
							secretValues: [options.serviceAccountToken],
							stageError: sdkResolveAllError,
						});
					}
				}
			},
		};
	} catch (error) {
		const sdkClientCreationError = createFallbackStageError(
			'1Password SDK client creation',
			error,
			[options.serviceAccountToken],
		);
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
						secretValues: [options.serviceAccountToken],
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
						secretValues: [options.serviceAccountToken],
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
