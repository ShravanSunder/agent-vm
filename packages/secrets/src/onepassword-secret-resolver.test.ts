import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createOpCliSecretResolver,
	createSecretResolver,
	resolveServiceAccountToken,
	type ExecFileOptions,
	type ExecFileResult,
	type SecretResolverClient,
} from './onepassword-secret-resolver.js';

const emptyExecFileResult = async (): Promise<ExecFileResult> => ({ stdout: '', stderr: '' });
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
	it('resolves token via op-cli', async () => {
		const fakeExec = async (
			command: string,
			args: readonly string[],
			options?: ExecFileOptions,
		): Promise<ExecFileResult> => {
			expect(command).toBe('op');
			expect(args).toEqual(['read', 'op://vault/item/field']);
			expect(options).toEqual({ redactErrorOutput: true });
			return { stdout: 'resolved-token\n', stderr: '' };
		};

		const token = await resolveServiceAccountToken(
			{ type: 'op-cli', ref: 'op://vault/item/field' },
			{ execFileAsync: fakeExec },
		);
		expect(token).toBe('resolved-token');
	});

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

	it('throws when op-cli returns empty', async () => {
		await expect(
			resolveServiceAccountToken(
				{ type: 'op-cli', ref: 'op://vault/item/field' },
				{ execFileAsync: emptyExecFileResult },
			),
		).rejects.toThrow('empty value');
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
					'Error: op inject failed before serial op read: Error',
					"Error: Failed to resolve secret 'A' from 'op://vault/item/a' via op read: op failed:read op://vault/item/a",
				]);
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
					readOutputs: {
						[unsafeSecretReference]: 'resolved-through-op-read',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: unsafeSecretReference },
			}),
		).resolves.toEqual({
			A: 'resolved-through-op-read',
		});
		expect(execCalls).toHaveLength(1);
		expectOpReadCall({
			call: execCalls[0],
			secretReference: unsafeSecretReference,
			serviceAccountToken: 'service-token',
		});
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

	it('preserves serial op read fallback bytes except the CLI stdout terminator', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: [],
					injectError: new Error('inject unavailable'),
					readOutputs: {
						'op://vault/item/final-newline': 'line1\nline2\n',
						'op://vault/item/leading': ' leading-space-secret',
						'op://vault/item/trailing': 'trailing-space-secret ',
					},
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				LEADING: { source: '1password', ref: 'op://vault/item/leading' },
				TRAILING: { source: '1password', ref: 'op://vault/item/trailing' },
				FINAL_NEWLINE: { source: '1password', ref: 'op://vault/item/final-newline' },
			}),
		).resolves.toEqual({
			FINAL_NEWLINE: 'line1\nline2\n',
			LEADING: ' leading-space-secret',
			TRAILING: 'trailing-space-secret ',
		});
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
		).rejects.toThrow('Failed to resolve 1 secret(s) via op read.');
		await expectRejects(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
			}),
			(error: unknown): void => {
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) {
					throw new Error('Expected AggregateError');
				}
				expect(error.errors.map((cause: unknown) => String(cause))).toContainEqual(
					expect.stringMatching(/op inject output for secret 'A'.*marker/u),
				);
			},
		);
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
					if (args[0] === 'read') {
						throw new Error('serial read unavailable');
					}
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
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) {
					throw new Error('Expected AggregateError');
				}
				expect(error.errors.map((cause: unknown) => String(cause))).toContainEqual(
					expect.stringMatching(expectedMessage),
				);
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

	it('falls back to serial op reads when op inject fails', async () => {
		const execCalls: RecordedExecCall[] = [];
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: execCalls,
					defaultReadOutput: (secretReference: string): string => `serial:${secretReference}`,
					injectError: new Error('inject unavailable'),
				}),
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
		).resolves.toEqual({
			A: 'serial:op://vault/item/a',
			B: 'serial:op://vault/item/b',
		});
		expect(execCalls[0]).toEqual(expect.any(Object));
		expectOpReadCall({
			call: execCalls[1],
			secretReference: 'op://vault/item/a',
			serviceAccountToken: 'service-token',
		});
		expectOpReadCall({
			call: execCalls[2],
			secretReference: 'op://vault/item/b',
			serviceAccountToken: 'service-token',
		});
		expectOpInjectCall({
			call: execCalls[0],
			secretReferences: ['op://vault/item/a', 'op://vault/item/b'],
			serviceAccountToken: 'service-token',
		});
	});

	it('does not write op inject fallback details to stderr when serial op read recovers', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: createFakeOpExec({
					calls: [],
					defaultReadOutput: (secretReference: string): string => `serial:${secretReference}`,
					injectError: new Error('resolved-secret-value'),
				}),
			},
		);

		const captured = await captureStderrWhile(
			async (): Promise<Record<string, string>> =>
				await secretResolver.resolveAll({
					A: { source: '1password', ref: 'op://vault/item/a' },
				}),
		);

		expect(captured.result).toEqual({
			A: 'serial:op://vault/item/a',
		});
		expect(captured.stderr).toBe('');
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
				OP_CONNECT_HOST: 'https://connect.example.test',
				OP_CONNECT_TOKEN: 'connect-token-should-not-forward',
				OP_SERVICE_ACCOUNT_TOKEN: 'ambient-token-should-not-forward',
				OP_SESSION: 'session-token-should-not-forward',
				PATH: '/tmp/op-bin',
				SSH_AUTH_SOCK: '/tmp/ssh-agent-should-not-forward.sock',
				SSL_CERT_FILE: '/tmp/custom-ca.pem',
				TMPDIR: '/tmp/op-tmpdir',
				USERPROFILE: '/tmp/op-userprofile',
				XDG_CONFIG_HOME: '/tmp/op-config',
				XDG_RUNTIME_DIR: '/tmp/op-runtime',
			},
			async () => {
				const secretResolver = await createOpCliSecretResolver(
					{ serviceAccountToken: 'service-token' },
					{
						execFileAsync: createFakeOpExec({
							calls: execCalls,
							defaultReadOutput: (secretReference: string): string => `serial:${secretReference}`,
							injectError: new Error('inject unavailable'),
						}),
					},
				);

				await expect(
					secretResolver.resolveAll({
						A: { source: '1password', ref: 'op://vault/item/a' },
					}),
				).resolves.toEqual({
					A: 'serial:op://vault/item/a',
				});
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
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
					PATH: '/tmp/op-bin',
					SSL_CERT_FILE: '/tmp/custom-ca.pem',
					TMPDIR: '/tmp/op-tmpdir',
					USERPROFILE: '/tmp/op-userprofile',
					XDG_CONFIG_HOME: '/tmp/op-config',
					XDG_RUNTIME_DIR: '/tmp/op-runtime',
				}),
			);
			expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
			expect(env).not.toHaveProperty('GITHUB_TOKEN');
			expect(env).not.toHaveProperty('OP_CONNECT_HOST');
			expect(env).not.toHaveProperty('OP_CONNECT_TOKEN');
			expect(env).not.toHaveProperty('OP_SESSION');
			expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
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
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) {
					throw new Error('Expected AggregateError');
				}
				const renderedError = [String(error), ...error.errors.map((child) => String(child))].join(
					'\n',
				);
				expect(renderedError).toContain('op inject failed before serial op read: exit code 1');
				expect(renderedError).toContain(
					"Failed to resolve secret 'A' from 'op://vault/item/a' via op read: op failed: exit code 1",
				);
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
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) {
					throw new Error('Expected AggregateError');
				}
				const renderedChildren = error.errors.map((child) => String(child));
				expect(renderedChildren).toContainEqual(
					expect.stringContaining('op inject failed before serial op read: '),
				);
				expect(renderedChildren).toContainEqual(
					expect.stringMatching(
						/op inject failed before serial op read: (stdin write failed|exit code 1)/u,
					),
				);
				expect(renderedChildren.some((child) => child.includes('SUPER-SECRET-VALUE'))).toBe(false);
			},
		);
	});

	it('adds per-secret context when op read resolveAll fails', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: async (_command, args) => {
					throw new Error(`denied:${args[1]}`);
				},
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
		).rejects.toThrow('Failed to resolve 2 secret(s) via op read.');
		await expectRejects(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
			(error: unknown): void => {
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) {
					throw new Error('Expected AggregateError');
				}
				expect(error.errors.map((cause: unknown) => String(cause))).toEqual([
					'Error: op inject failed before serial op read: Error',
					"Error: Failed to resolve secret 'A' from 'op://vault/item/a' via op read: denied:op://vault/item/a",
					"Error: Failed to resolve secret 'B' from 'op://vault/item/b' via op read: denied:op://vault/item/b",
				]);
			},
		);
	});

	it('keeps nested AggregateError details in op read per-secret failures', async () => {
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: async (_command, args): Promise<ExecFileResult> => {
					if (args[0] === 'inject') {
						throw new Error('inject unavailable');
					}
					throw new AggregateError(
						[new Error('first nested failure'), new Error('second nested failure')],
						'op read aggregate failure',
					);
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
				expect(error.errors.map((cause: unknown) => String(cause))).toContain(
					"Error: Failed to resolve secret 'A' from 'op://vault/item/a' via op read: op read aggregate failure. Details: first nested failure; second nested failure",
				);
			},
		);
	});
});
