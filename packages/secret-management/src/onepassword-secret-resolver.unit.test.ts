import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createOpCliSecretResolver,
	createSecretResolver,
	probeOnePasswordServiceAccountHeadlessAuth,
	resolveServiceAccountToken,
	type ExecFileOptions,
	type ExecFileResult,
	type SecretResolverClient,
} from './onepassword-secret-resolver.js';

const originalPlatform = process.platform;
const originalPath = process.env.PATH;

const temporaryDirectories: string[] = [];

interface RecordedExecCall {
	readonly args: readonly string[];
	readonly command: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly input?: string | undefined;
	readonly redactErrorOutput?: boolean | undefined;
}

type FakeExecFileAsync = (
	command: string,
	args: readonly string[],
	options?: ExecFileOptions,
) => Promise<ExecFileResult>;

function requireOpInjectTemplate(command: string, args: readonly string[], input?: string): string {
	if (
		command !== 'op' ||
		args.length !== 3 ||
		args[0] !== 'inject' ||
		args[1] !== '--in-file' ||
		args[2] !== '/dev/stdin' ||
		input === undefined
	) {
		throw new Error(`unexpected op fallback call: ${command} ${args.join(' ')}`);
	}
	return input;
}

function renderOpInjectTemplate(options: {
	readonly args: readonly string[];
	readonly command: string;
	readonly input?: string | undefined;
	readonly replacements: Readonly<Record<string, string>>;
}): string {
	const template = requireOpInjectTemplate(options.command, options.args, options.input);
	return Object.entries(options.replacements).reduce(
		(renderedTemplate, [secretReference, value]) =>
			renderedTemplate.replaceAll(`{{ ${secretReference} }}`, value),
		template,
	);
}

function captureEnvironmentValues(envNames: readonly string[]): Record<string, string | undefined> {
	const values: Record<string, string | undefined> = {};
	for (const envName of envNames) {
		values[envName] = process.env[envName];
	}
	return values;
}

async function withProcessEnv<TValue>(
	envValues: Readonly<Record<string, string | undefined>>,
	callback: () => Promise<TValue>,
): Promise<TValue> {
	const previousValues = captureEnvironmentValues(Object.keys(envValues));
	try {
		for (const [envName, envValue] of Object.entries(envValues)) {
			if (envValue === undefined) {
				delete process.env[envName];
			} else {
				process.env[envName] = envValue;
			}
		}
		return await callback();
	} finally {
		for (const [envName, envValue] of Object.entries(previousValues)) {
			if (envValue === undefined) {
				delete process.env[envName];
			} else {
				process.env[envName] = envValue;
			}
		}
	}
}

async function captureStderrWhile<TValue>(
	callback: () => Promise<TValue>,
): Promise<{ readonly result: TValue; readonly stderr: string }> {
	const capturedStderrChunks: string[] = [];
	const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk): boolean => {
		capturedStderrChunks.push(String(chunk));
		return true;
	});
	try {
		return {
			result: await callback(),
			stderr: capturedStderrChunks.join(''),
		};
	} finally {
		stderrWrite.mockRestore();
	}
}

async function expectRejects<TValue>(
	promise: Promise<TValue>,
	assertError: (error: unknown) => void,
): Promise<void> {
	try {
		await promise;
	} catch (error) {
		assertError(error);
		return;
	}
	throw new Error('Expected promise to reject.');
}

function renderErrorTree(error: unknown): string {
	const lines = [String(error)];
	if (error instanceof AggregateError) {
		lines.push(...error.errors.map(renderErrorTree));
	}
	if (typeof error === 'object' && error !== null && 'cause' in error) {
		const cause = (error as { readonly cause?: unknown }).cause;
		if (cause !== undefined) {
			lines.push(renderErrorTree(cause));
		}
	}
	return lines.join('\n');
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function writeExecutableOpShim(options: {
	readonly directoryPath: string;
	readonly script: string;
}): Promise<void> {
	const opPath = path.join(options.directoryPath, 'op');
	await writeFile(opPath, options.script, 'utf8');
	await chmod(opPath, 0o755);
}

function requireOpReadSecretReference(command: string, args: readonly string[]): string {
	const secretReference = args[1];
	if (command !== 'op' || args[0] !== 'read' || !secretReference) {
		throw new Error(`unexpected op read call: ${command} ${args.join(' ')}`);
	}
	return secretReference;
}

function recordExecCall(
	calls: RecordedExecCall[],
	command: string,
	args: readonly string[],
	options?: ExecFileOptions,
): void {
	calls.push({
		args,
		command,
		...(options?.env ? { env: options.env } : {}),
		...(options?.input !== undefined ? { input: options.input } : {}),
		...(options?.redactErrorOutput !== undefined
			? { redactErrorOutput: options.redactErrorOutput }
			: {}),
	});
}

function createFakeOpExec(options: {
	readonly calls: RecordedExecCall[];
	readonly defaultReadOutput?: (secretReference: string) => string;
	readonly injectError?: Error;
	readonly injectReplacements?: Readonly<Record<string, string>>;
	readonly readOutputs?: Readonly<Record<string, string>>;
}): FakeExecFileAsync {
	return async (command, args, execOptions): Promise<ExecFileResult> => {
		recordExecCall(options.calls, command, args, execOptions);
		if (args[0] === 'inject') {
			if (options.injectError) {
				throw options.injectError;
			}
			return {
				stdout: renderOpInjectTemplate({
					args,
					command,
					input: execOptions?.input,
					replacements: options.injectReplacements ?? {},
				}),
				stderr: '',
			};
		}

		const secretReference = requireOpReadSecretReference(command, args);
		const configuredReadOutput = options.readOutputs?.[secretReference];
		const readOutput =
			configuredReadOutput ?? options.defaultReadOutput?.(secretReference) ?? secretReference;
		return { stdout: `${readOutput}\n`, stderr: '' };
	};
}

function requireRecordedEnv(
	call: RecordedExecCall | undefined,
): Readonly<Record<string, string | undefined>> {
	if (!call?.env) {
		throw new Error('Expected recorded op call with env.');
	}
	return call.env;
}

function expectOpInjectCall(options: {
	readonly call: RecordedExecCall | undefined;
	readonly secretReferences: readonly string[];
	readonly serviceAccountToken: string;
}): void {
	if (!options.call) {
		throw new Error('Expected op inject call.');
	}

	expect(options.call).toEqual({
		args: ['inject', '--in-file', '/dev/stdin'],
		command: 'op',
		env: expect.objectContaining({
			OP_SERVICE_ACCOUNT_TOKEN: options.serviceAccountToken,
		}),
		input: expect.any(String),
		redactErrorOutput: true,
	});

	if (options.call.input === undefined) {
		throw new Error('Expected op inject stdin template.');
	}

	for (const secretReference of options.secretReferences) {
		expect(options.call.input).toContain(`{{ ${secretReference} }}`);
	}
}

function expectOpReadCall(options: {
	readonly call: RecordedExecCall | undefined;
	readonly secretReference: string;
	readonly serviceAccountToken: string;
}): void {
	expect(options.call).toEqual({
		args: ['read', options.secretReference],
		command: 'op',
		env: expect.objectContaining({
			OP_SERVICE_ACCOUNT_TOKEN: options.serviceAccountToken,
		}),
		redactErrorOutput: true,
	});
}

afterEach(() => {
	Object.defineProperty(process, 'platform', {
		configurable: true,
		value: originalPlatform,
	});
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
});

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectory) => {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}),
	);
});

describe('resolveServiceAccountToken', () => {
	it('resolves token via env var', async () => {
		const original = process.env.OP_SERVICE_ACCOUNT_TOKEN;
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'env-token';
		try {
			const token = await resolveServiceAccountToken({ type: 'env' });
			expect(token).toBe('env-token');
		} finally {
			if (original === undefined) {
				delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
			} else {
				process.env.OP_SERVICE_ACCOUNT_TOKEN = original;
			}
		}
	});

	it('throws when env var is not set', async () => {
		const original = process.env.TEST_MISSING_VAR;
		delete process.env.TEST_MISSING_VAR;
		try {
			await expect(
				resolveServiceAccountToken({ type: 'env', envVar: 'TEST_MISSING_VAR' }),
			).rejects.toThrow('TEST_MISSING_VAR is not set');
		} finally {
			if (original !== undefined) {
				process.env.TEST_MISSING_VAR = original;
			}
		}
	});

	it('resolves token via keychain', async () => {
		Object.defineProperty(process, 'platform', {
			configurable: true,
			value: 'darwin',
		});

		const fakeExec = async (command: string, args: readonly string[]): Promise<ExecFileResult> => {
			expect(command).toBe('security');
			expect(args).toEqual([
				'find-generic-password',
				'-s',
				'agent-vm',
				'-a',
				'service-account',
				'-w',
			]);
			return { stdout: 'keychain-token\n', stderr: '' };
		};

		const token = await resolveServiceAccountToken(
			{ type: 'keychain', service: 'agent-vm', account: 'service-account' },
			{ execFileAsync: fakeExec },
		);
		expect(token).toBe('keychain-token');
	});

	it('throws a clear error when keychain token source is used off macOS', async () => {
		Object.defineProperty(process, 'platform', {
			configurable: true,
			value: 'linux',
		});

		await expect(
			resolveServiceAccountToken({
				type: 'keychain',
				service: 'agent-vm',
				account: 'service-account',
			}),
		).rejects.toThrow(/macOS/u);
	});
});

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

	it('resolves all refs through the sdk batch API and preserves caller keys', async () => {
		const batchCalls: string[][] = [];
		const singleResolveCalls: string[] = [];
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => {
					singleResolveCalls.push(secretReference);
					return `single:${secretReference}`;
				},
				resolveAll: async (secretReferences: readonly string[]) => {
					batchCalls.push([...secretReferences]);
					return {
						individualResponses: Object.fromEntries(
							secretReferences.map((secretReference) => [
								secretReference,
								{
									content: {
										secret: `batch:${secretReference}`,
										itemId: `item:${secretReference}`,
										vaultId: 'vault-id',
									},
								},
							]),
						),
					};
				},
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
				DISCORD_BOT_TOKEN: {
					source: '1password',
					ref: 'op://agent-vm/agent-discord-app/bot-token',
				},
				OPENCLAW_GATEWAY_TOKEN: {
					source: '1password',
					ref: 'op://agent-vm/agent-gateway/token',
				},
			}),
		).resolves.toEqual({
			DISCORD_BOT_TOKEN: 'batch:op://agent-vm/agent-discord-app/bot-token',
			OPENCLAW_GATEWAY_TOKEN: 'batch:op://agent-vm/agent-gateway/token',
		});
		expect(batchCalls).toEqual([
			['op://agent-vm/agent-discord-app/bot-token', 'op://agent-vm/agent-gateway/token'],
		]);
		expect(singleResolveCalls).toEqual([]);
	});

	it('resolves config refs locally and sends only 1Password refs to the sdk batch API', async () => {
		const batchCalls: string[][] = [];
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => `single:${secretReference}`,
				resolveAll: async (secretReferences: readonly string[]) => {
					batchCalls.push([...secretReferences]);
					return {
						individualResponses: Object.fromEntries(
							secretReferences.map((secretReference) => [
								secretReference,
								{
									content: {
										secret: `batch:${secretReference}`,
										itemId: `item:${secretReference}`,
										vaultId: 'vault-id',
									},
								},
							]),
						),
					};
				},
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
				source: 'config',
				value: 'inline-token',
			}),
		).resolves.toBe('inline-token');
		await expect(
			secretResolver.resolveAll({
				INLINE_TOKEN: { source: 'config', value: 'inline-token' },
				OPENAI_API_KEY: { source: '1password', ref: 'op://vault/openai/key' },
			}),
		).resolves.toEqual({
			INLINE_TOKEN: 'inline-token',
			OPENAI_API_KEY: 'batch:op://vault/openai/key',
		});
		expect(batchCalls).toEqual([['op://vault/openai/key']]);
	});

	it('rejects environment refs when the 1Password resolver is used directly', async () => {
		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'op-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => ({
					secrets: {
						resolve: async () => {
							throw new Error('environment ref should not reach sdk resolve');
						},
						resolveAll: async () => {
							throw new Error('environment ref should not reach sdk resolveAll');
						},
					},
				}),
			},
		);

		await expect(
			secretResolver.resolve({ source: 'environment', ref: 'OPENAI_API_KEY' }),
		).rejects.toThrow(
			"Secret source 'environment' must be resolved by the composite resolver before reaching the 1Password resolver.",
		);
		await expect(
			secretResolver.resolveAll({
				OPENAI_API_KEY: { source: 'environment', ref: 'OPENAI_API_KEY' },
			}),
		).rejects.toThrow(
			"Secret source 'environment' must be resolved by the composite resolver before reaching the 1Password resolver.",
		);
	});

	it('falls back to one op inject batch when sdk resolveAll fails', async () => {
		const execCalls: RecordedExecCall[] = [];
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => `single:${secretReference}`,
				resolveAll: async (): Promise<never> => {
					throw new Error('request library compatibility issue: reqwest library');
				},
			},
		};
		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => fakeClient,
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					injectReplacements: {
						'op://vault/item/a': 'op-inject-a',
						'op://vault/item/b': 'line 1\nline 2',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
		).resolves.toEqual({
			A: 'op-inject-a',
			B: 'line 1\nline 2',
		});
		expect(execCalls).toHaveLength(1);
		expectOpInjectCall({
			call: execCalls[0],
			secretReferences: ['op://vault/item/a', 'op://vault/item/b'],
			serviceAccountToken: 'service-token',
		});
	});

	it('does not write sdk resolveAll fallback details to stderr when op inject recovers', async () => {
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => `single:${secretReference}`,
				resolveAll: async (): Promise<never> => {
					throw new Error('request library compatibility issue: reqwest library');
				},
			},
		};
		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => fakeClient,
				execFileAsync: createFakeOpExec({
					calls: [],
					injectReplacements: {
						'op://vault/item/a': 'op-inject-a',
					},
				}),
			},
		);

		const captured = await captureStderrWhile(
			async (): Promise<Record<string, string>> =>
				await secretResolver.resolveAll({
					A: { source: '1password', ref: 'op://vault/item/a' },
				}),
		);

		expect(captured.result).toEqual({ A: 'op-inject-a' });
		expect(captured.stderr).toBe('');
	});

	it('keeps sdk resolveAll fallback details in the final error when every fallback fails', async () => {
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => `single:${secretReference}`,
				resolveAll: async (): Promise<never> => {
					throw new Error('request library compatibility issue: reqwest library');
				},
			},
		};
		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => fakeClient,
				execFileAsync: async (_command, args): Promise<ExecFileResult> => {
					throw new Error(`op failed:${args.join(' ')}`);
				},
			},
		);

		await expectRejects(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
			}),
			(error: unknown): void => {
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) {
					throw new Error('Expected AggregateError');
				}
				expect(error.errors.map((cause: unknown) => String(cause))).toEqual([
					'Error: 1Password SDK resolveAll failed before op CLI fallback: request library compatibility issue: reqwest library',
					'Error: op failed:inject --in-file /dev/stdin',
				]);
				expect(renderErrorTree(error)).not.toContain('op://');
			},
		);
	});

	it('falls back to op inject batch when sdk client creation fails', async () => {
		const execCalls: RecordedExecCall[] = [];

		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => {
					throw new Error('sdk init failed');
				},
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					injectReplacements: {
						'op://agent-vm/agent-gateway/token': 'resolved-from-op-inject',
					},
					readOutputs: {
						'op://AI/anthropic/api-key': 'resolved-from-op',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolve({
				source: '1password',
				ref: 'op://AI/anthropic/api-key',
			}),
		).resolves.toBe('resolved-from-op');
		await expect(
			secretResolver.resolveAll({
				OPENCLAW_GATEWAY_TOKEN: {
					source: '1password',
					ref: 'op://agent-vm/agent-gateway/token',
				},
			}),
		).resolves.toEqual({
			OPENCLAW_GATEWAY_TOKEN: 'resolved-from-op-inject',
		});
		expectOpReadCall({
			call: execCalls[0],
			secretReference: 'op://AI/anthropic/api-key',
			serviceAccountToken: 'service-token',
		});
		expect(execCalls[1]).toEqual(expect.any(Object));
		expectOpInjectCall({
			call: execCalls[1],
			secretReferences: ['op://agent-vm/agent-gateway/token'],
			serviceAccountToken: 'service-token',
		});
	});

	it('redacts service-account token values from sdk and fallback error messages', async () => {
		const serviceAccountToken = 'SUPER-SECRET-SERVICE-ACCOUNT-TOKEN';
		const secretResolver = await createSecretResolver(
			{ serviceAccountToken },
			{
				createClient: async (): Promise<SecretResolverClient> => {
					throw new Error(`sdk auth failed for token ${serviceAccountToken}`);
				},
				execFileAsync: async (): Promise<ExecFileResult> => {
					throw new Error(`op fallback failed for token ${serviceAccountToken}`);
				},
			},
		);

		await expectRejects(
			secretResolver.resolveAll({
				OPENCLAW_GATEWAY_TOKEN: {
					source: '1password',
					ref: 'op://agent-vm/agent-gateway/token',
				},
			}),
			(error: unknown): void => {
				const renderedError = renderErrorTree(error);
				expect(renderedError).toContain('sdk auth failed for token <redacted>');
				expect(renderedError).toContain('op fallback failed for token <redacted>');
				expect(renderedError).not.toContain(serviceAccountToken);
			},
		);
	});

	it('falls back to op read when sdk secret resolution fails after client creation', async () => {
		const execCalls: RecordedExecCall[] = [];

		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => ({
					secrets: {
						resolve: async (): Promise<string> => {
							throw new Error('sdk resolve failed');
						},
						resolveAll: async () => ({
							individualResponses: {},
						}),
					},
				}),
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					readOutputs: {
						'op://AI/anthropic/api-key': 'resolved-from-op',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolve({
				source: '1password',
				ref: 'op://AI/anthropic/api-key',
			}),
		).resolves.toBe('resolved-from-op');
		expectOpReadCall({
			call: execCalls[0],
			secretReference: 'op://AI/anthropic/api-key',
			serviceAccountToken: 'service-token',
		});
	});

	it('falls back to op inject batch when sdk resolveAll response cannot be mapped', async () => {
		const execCalls: RecordedExecCall[] = [];
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => `single:${secretReference}`,
				resolveAll: async () => ({
					individualResponses: {
						'op://vault/item/a': {
							content: {
								secret: 'sdk-a',
								itemId: 'item-a',
								vaultId: 'vault-id',
							},
						},
					},
				}),
			},
		};
		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => fakeClient,
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					injectReplacements: {
						'op://vault/item/a': 'op-inject-a',
						'op://vault/item/b': 'op-inject-b',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
		).resolves.toEqual({
			A: 'op-inject-a',
			B: 'op-inject-b',
		});
		expect(execCalls).toHaveLength(1);
		expectOpInjectCall({
			call: execCalls[0],
			secretReferences: ['op://vault/item/a', 'op://vault/item/b'],
			serviceAccountToken: 'service-token',
		});
	});

	it('falls back to op inject batch when sdk resolveAll returns a per-entry error', async () => {
		const execCalls: RecordedExecCall[] = [];
		const fakeClient: SecretResolverClient = {
			secrets: {
				resolve: async (secretReference: string): Promise<string> => `single:${secretReference}`,
				resolveAll: async () => ({
					individualResponses: {
						'op://vault/item/a': {
							error: {
								message: 'access denied',
								type: 'parsing',
							},
						},
					},
				}),
			},
		};
		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => fakeClient,
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					injectReplacements: {
						'op://vault/item/a': 'op-inject-a',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
			}),
		).resolves.toEqual({
			A: 'op-inject-a',
		});
		expect(execCalls).toHaveLength(1);
		expectOpInjectCall({
			call: execCalls[0],
			secretReferences: ['op://vault/item/a'],
			serviceAccountToken: 'service-token',
		});
	});
});

describe('createOpCliSecretResolver', () => {
	it('resolves config refs locally and sends only 1Password refs to op inject', async () => {
		const execCalls: RecordedExecCall[] = [];
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					injectReplacements: {
						'op://vault/item/a': 'op-inject-a',
					},
				}),
			},
		);

		await expect(secretResolver.resolve({ source: 'config', value: 'inline-token' })).resolves.toBe(
			'inline-token',
		);
		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				INLINE: { source: 'config', value: 'inline-token' },
			}),
		).resolves.toEqual({
			A: 'op-inject-a',
			INLINE: 'inline-token',
		});
		expect(execCalls).toHaveLength(1);
		expectOpInjectCall({
			call: execCalls[0],
			secretReferences: ['op://vault/item/a'],
			serviceAccountToken: 'service-token',
		});
	});

	it('resolves all refs through one op inject batch', async () => {
		const execCalls: RecordedExecCall[] = [];
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					injectReplacements: {
						'op://vault/item/a': 'op-inject-a',
						'op://vault/item/b': 'op-inject-b',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
		).resolves.toEqual({
			A: 'op-inject-a',
			B: 'op-inject-b',
		});
		expect(execCalls).toHaveLength(1);
		expectOpInjectCall({
			call: execCalls[0],
			secretReferences: ['op://vault/item/a', 'op://vault/item/b'],
			serviceAccountToken: 'service-token',
		});
	});

	it('preserves op inject secret bytes without trimming whitespace', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: [],
					injectReplacements: {
						'op://vault/item/leading': ' leading-space-secret',
						'op://vault/item/trailing': 'trailing-space-secret ',
						'op://vault/item/bookended': '\nbookended\n',
						'op://vault/item/final-newline': 'line1\nline2\n',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				LEADING: { source: '1password', ref: 'op://vault/item/leading' },
				TRAILING: { source: '1password', ref: 'op://vault/item/trailing' },
				BOOKENDED: { source: '1password', ref: 'op://vault/item/bookended' },
				FINAL_NEWLINE: { source: '1password', ref: 'op://vault/item/final-newline' },
			}),
		).resolves.toEqual({
			LEADING: ' leading-space-secret',
			TRAILING: 'trailing-space-secret ',
			BOOKENDED: '\nbookended\n',
			FINAL_NEWLINE: 'line1\nline2\n',
		});
	});

	it('resolves duplicate refs in one op inject batch', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: [],
					injectReplacements: {
						'op://vault/item/shared': 'shared-secret',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				FIRST: { source: '1password', ref: 'op://vault/item/shared' },
				SECOND: { source: '1password', ref: 'op://vault/item/shared' },
			}),
		).resolves.toEqual({
			FIRST: 'shared-secret',
			SECOND: 'shared-secret',
		});
	});

	it('does not place template-breaking secret refs in op inject stdin', async () => {
		const execCalls: RecordedExecCall[] = [];
		const unsafeSecretReference = 'op://vault/item/field }}\n{{ op://vault/other/field';
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: execCalls,
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: unsafeSecretReference },
			}),
		).rejects.toThrow(/op inject template rejected unsafe 1Password reference/u);
		expect(execCalls).toHaveLength(0);
	});

	it('preserves single op read secret bytes except the CLI stdout terminator', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: [],
					readOutputs: {
						'op://vault/item/final-newline': 'line1\nline2\n',
						'op://vault/item/leading': ' leading-space-secret',
						'op://vault/item/trailing': 'trailing-space-secret ',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolve({
				source: '1password',
				ref: 'op://vault/item/leading',
			}),
		).resolves.toBe(' leading-space-secret');
		await expect(
			secretResolver.resolve({
				source: '1password',
				ref: 'op://vault/item/trailing',
			}),
		).resolves.toBe('trailing-space-secret ');
		await expect(
			secretResolver.resolve({
				source: '1password',
				ref: 'op://vault/item/final-newline',
			}),
		).resolves.toBe('line1\nline2\n');
	});

	it('strips one CRLF terminator from single op read output', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: async (): Promise<ExecFileResult> => ({
					stdout: 'line1\r\nline2\r\n',
					stderr: '',
				}),
			},
		);

		await expect(
			secretResolver.resolve({
				source: '1password',
				ref: 'op://vault/item/crlf',
			}),
		).resolves.toBe('line1\r\nline2');
	});

	it('rejects op inject output when a resolved value contains an internal marker', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: async (command, args, execOptions) => {
					const template = requireOpInjectTemplate(command, args, execOptions?.input);
					const endMarker = template
						.split('\n')
						.find((templateLine) => templateLine.startsWith('agent-vm-op-inject-end:'));
					if (!endMarker) {
						throw new Error('Expected op inject end marker in template.');
					}
					return {
						stdout: template.replace('{{ op://vault/item/a }}', `before\n${endMarker}\nafter`),
						stderr: '',
					};
				},
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
			}),
		).rejects.toThrow(/op inject output for secret 'A'.*marker/u);
		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
			}),
		).rejects.not.toThrow(/op:\/\//u);
	});

	it.each([
		{
			expectedMessage: /omitted start marker/u,
			name: 'missing start marker',
			renderOutput: (_startMarker: string, endMarker: string): string =>
				`resolved-value\n${endMarker}`,
		},
		{
			expectedMessage: /omitted end marker/u,
			name: 'missing end marker',
			renderOutput: (startMarker: string): string => `${startMarker}\nresolved-value`,
		},
		{
			expectedMessage: /contained repeated start marker/u,
			name: 'duplicated start marker',
			renderOutput: (startMarker: string, endMarker: string): string =>
				`${startMarker}\nresolved-value\n${startMarker}\n${endMarker}`,
		},
	])('rejects op inject output with $name', async ({ expectedMessage, renderOutput }) => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: async (command, args, execOptions) => {
					const template = requireOpInjectTemplate(command, args, execOptions?.input);
					const startMarker = template
						.split('\n')
						.find((templateLine) => templateLine.startsWith('agent-vm-op-inject-start:'));
					const endMarker = template
						.split('\n')
						.find((templateLine) => templateLine.startsWith('agent-vm-op-inject-end:'));
					if (!startMarker || !endMarker) {
						throw new Error('Expected op inject markers in template.');
					}
					return {
						stdout: renderOutput(startMarker, endMarker),
						stderr: '',
					};
				},
			},
		);

		await expectRejects(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
			}),
			(error: unknown): void => {
				expect(error).toBeInstanceOf(Error);
				expect(String(error)).toMatch(expectedMessage);
			},
		);
	});

	it('returns empty results without invoking op inject for empty refs', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: async (): Promise<ExecFileResult> => {
					throw new Error('op should not be called for empty refs');
				},
			},
		);

		await expect(secretResolver.resolveAll({})).resolves.toEqual({});
	});

	it('limits op subprocess env to non-secret process plumbing and the intended service token', async () => {
		const execCalls: RecordedExecCall[] = [];

		await withProcessEnv(
			{
				APPDATA: '/tmp/op-appdata',
				AWS_SECRET_ACCESS_KEY: 'aws-secret-should-not-forward',
				COMSPEC: '/bin/sh',
				GITHUB_TOKEN: 'github-token-should-not-forward',
				HOME: '/tmp/op-home',
				HTTPS_PROXY: 'http://proxy.example.test:8080',
				HTTP_PROXY: 'http://proxy.example.test:8081',
				LANG: 'C.UTF-8',
				LC_ALL: 'C',
				LOCALAPPDATA: '/tmp/op-localappdata',
				NO_PROXY: 'localhost,127.0.0.1',
				OP_ACCOUNT: 'human-account-should-not-forward',
				OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
				OP_CACHE: 'true',
				OP_CONNECT_HOST: 'https://connect.example.test',
				OP_CONNECT_TOKEN: 'connect-token-should-not-forward',
				OP_CONFIG_DIR: '/tmp/human-op-config-should-not-forward',
				OP_SERVICE_ACCOUNT_TOKEN: 'ambient-token-should-not-forward',
				OP_SESSION: 'session-token-should-not-forward',
				OP_SESSION_human: 'named-session-token-should-not-forward',
				PATH: '/tmp/op-bin',
				SSH_AUTH_SOCK: '/tmp/ssh-agent-should-not-forward.sock',
				SSL_CERT_FILE: '/tmp/custom-ca.pem',
				TMPDIR: '/tmp/op-tmpdir',
				USERPROFILE: '/tmp/op-userprofile',
				XDG_CONFIG_HOME: '/tmp/op-config',
				XDG_CACHE_HOME: '/tmp/op-cache',
				XDG_DATA_HOME: '/tmp/op-data',
				XDG_RUNTIME_DIR: '/tmp/op-runtime',
			},
			async () => {
				const secretResolver = await createOpCliSecretResolver(
					{ serviceAccountToken: 'service-token' },
					{
						execFileAsync: createFakeOpExec({
							calls: execCalls,
							defaultReadOutput: (secretReference: string): string => `resolved:${secretReference}`,
							injectReplacements: {
								'op://vault/item/a': 'resolved:op://vault/item/a',
							},
						}),
					},
				);

				await expect(
					secretResolver.resolveAll({
						A: { source: '1password', ref: 'op://vault/item/a' },
					}),
				).resolves.toEqual({
					A: 'resolved:op://vault/item/a',
				});
				// Also exercise the single-secret resolve() path so the env
				// assertion below covers both `op inject` (resolveAll) and the
				// single-secret op CLI flow.
				await expect(
					secretResolver.resolve({ source: '1password', ref: 'op://vault/item/b' }),
				).resolves.toBe('resolved:op://vault/item/b');
			},
		);

		for (const opCall of execCalls) {
			const env = requireRecordedEnv(opCall);
			expect(env).toEqual(
				expect.objectContaining({
					APPDATA: '/tmp/op-appdata',
					COMSPEC: '/bin/sh',
					HOME: '/tmp/op-home',
					HTTPS_PROXY: 'http://proxy.example.test:8080',
					HTTP_PROXY: 'http://proxy.example.test:8081',
					LANG: 'C.UTF-8',
					LC_ALL: 'C',
					LOCALAPPDATA: '/tmp/op-localappdata',
					NO_PROXY: 'localhost,127.0.0.1',
					OP_BIOMETRIC_UNLOCK_ENABLED: 'false',
					OP_CACHE: 'false',
					OP_CONFIG_DIR: expect.stringContaining('agent-vm-op-config-'),
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
					PATH: '/tmp/op-bin',
					SSL_CERT_FILE: '/tmp/custom-ca.pem',
					TMPDIR: '/tmp/op-tmpdir',
					USERPROFILE: '/tmp/op-userprofile',
					XDG_RUNTIME_DIR: '/tmp/op-runtime',
				}),
			);
			expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
			expect(env).not.toHaveProperty('GITHUB_TOKEN');
			expect(env).not.toHaveProperty('OP_ACCOUNT');
			expect(env).not.toHaveProperty('OP_CONNECT_HOST');
			expect(env).not.toHaveProperty('OP_CONNECT_TOKEN');
			expect(env).not.toHaveProperty('OP_SESSION');
			expect(env).not.toHaveProperty('OP_SESSION_human');
			expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
			expect(env).not.toHaveProperty('XDG_CACHE_HOME');
			expect(env).not.toHaveProperty('XDG_CONFIG_HOME');
			expect(env).not.toHaveProperty('XDG_DATA_HOME');
		}
	});

	it('redacts stderr from real op inject child process failures', async () => {
		const temporaryDirectory = await createTemporaryDirectory('agent-vm-op-shim-');
		await writeExecutableOpShim({
			directoryPath: temporaryDirectory,
			script: [
				'#!/bin/sh',
				'if [ "$1" = "inject" ]; then',
				'  cat >/dev/null',
				'  printf "SUPER-SECRET-VALUE" >&2',
				'  exit 1',
				'fi',
				'printf "SUPER-SECRET-VALUE" >&2',
				'exit 1',
				'',
			].join('\n'),
		});
		process.env.PATH = originalPath
			? `${temporaryDirectory}${path.delimiter}${originalPath}`
			: temporaryDirectory;
		const secretResolver = await createOpCliSecretResolver({
			serviceAccountToken: 'service-token',
		});

		await expectRejects(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
			}),
			(error: unknown): void => {
				expect(error).toBeInstanceOf(Error);
				expect(error).not.toHaveProperty('cause');
				const renderedError = String(error);
				expect(renderedError).toContain('op failed: exit code 1');
				expect(renderedError).toContain('output=redacted');
				expect(renderedError).toContain('stdoutBytes=0');
				expect(renderedError).toContain('stderrBytes=18');
				expect(renderedError).toContain('opEnvIsolation=enabled');
				expect(renderedError).toContain('opAuth=service-account-token');
				expect(renderedError).toContain('opSubcommand=inject');
				expect(renderedError).toContain('opConfig=isolated');
				expect(renderedError).toContain('opBiometricUnlock=false');
				expect(renderedError).toContain('opConnectEnv=absent');
				expect(renderedError).toContain('opSessionEnv=absent');
				expect(renderedError).toContain('opAccountEnv=absent');
				expect(renderedError).not.toContain('SUPER-SECRET-VALUE');
			},
		);
	});

	it('preserves safe op inject failure details when the child closes stdin early', async () => {
		const temporaryDirectory = await createTemporaryDirectory('agent-vm-op-shim-');
		await writeExecutableOpShim({
			directoryPath: temporaryDirectory,
			script: [
				'#!/bin/sh',
				'if [ "$1" = "inject" ]; then',
				'  exec 0<&-',
				'  sleep 1',
				'  exit 1',
				'fi',
				'printf "SUPER-SECRET-VALUE" >&2',
				'exit 1',
				'',
			].join('\n'),
		});
		process.env.PATH = originalPath
			? `${temporaryDirectory}${path.delimiter}${originalPath}`
			: temporaryDirectory;
		const secretResolver = await createOpCliSecretResolver({
			serviceAccountToken: 'service-token',
		});
		const longSecretReference = `op://vault/item/${'a'.repeat(96 * 1024)}`;

		await expectRejects(
			secretResolver.resolveAll({
				A: { source: '1password', ref: longSecretReference },
			}),
			(error: unknown): void => {
				expect(error).toBeInstanceOf(Error);
				expect(error).not.toHaveProperty('cause');
				const renderedError = String(error);
				expect(renderedError).toMatch(
					/op failed( writing stdin)?: (stdin write failed|exit code 1)/u,
				);
				expect(renderedError).not.toContain('SUPER-SECRET-VALUE');
			},
		);
	});

	it('redacts stderr from service-account headless auth probe failures', async () => {
		const temporaryDirectory = await createTemporaryDirectory('agent-vm-op-shim-');
		await writeExecutableOpShim({
			directoryPath: temporaryDirectory,
			script: [
				'#!/bin/sh',
				'if [ "$1" = "whoami" ]; then',
				'  printf "SUPER-SECRET-VALUE" >&2',
				'  exit 1',
				'fi',
				'exit 1',
				'',
			].join('\n'),
		});
		process.env.PATH = originalPath
			? `${temporaryDirectory}${path.delimiter}${originalPath}`
			: temporaryDirectory;

		const probe = await probeOnePasswordServiceAccountHeadlessAuth({
			serviceAccountToken: 'service-token',
		});

		expect(probe.ok).toBe(false);
		expect(probe.hint).toContain('op whoami failed with isolated service-account env');
		expect(probe.hint).toContain('output=redacted');
		expect(probe.hint).toContain('stdoutBytes=0');
		expect(probe.hint).toContain('stderrBytes=18');
		expect(probe.hint).toContain('opEnvIsolation=enabled');
		expect(probe.hint).toContain('opAuth=service-account-token');
		expect(probe.hint).toContain('opSubcommand=whoami');
		expect(probe.hint).not.toContain('SUPER-SECRET-VALUE');
	});

	it('redacts service-account token values from headless auth probe dependency failures', async () => {
		const serviceAccountToken = 'SUPER-SECRET-SERVICE-ACCOUNT-TOKEN';
		const probe = await probeOnePasswordServiceAccountHeadlessAuth(
			{ serviceAccountToken },
			{
				execFileAsync: async (): Promise<ExecFileResult> => {
					throw new Error(`probe failed for token ${serviceAccountToken}`);
				},
			},
		);

		expect(probe.ok).toBe(false);
		expect(probe.hint).toContain('probe failed for token <redacted>');
		expect(probe.hint).not.toContain(serviceAccountToken);
	});
});
