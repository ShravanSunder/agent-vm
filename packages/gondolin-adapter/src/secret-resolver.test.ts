import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createSecretResolver,
	createOpCliSecretResolver,
	resolveServiceAccountToken,
	type ExecFileOptions,
	type ExecFileResult,
	type SecretResolverClient,
} from './secret-resolver.js';

const emptyExecFileResult = async (): Promise<ExecFileResult> => ({ stdout: '', stderr: '' });
const originalPlatform = process.platform;

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
	if (command !== 'op' || args.length !== 1 || args[0] !== 'inject' || input === undefined) {
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
			renderedTemplate.replace(`{{ ${secretReference} }}`, value),
		template,
	);
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

function expectOpInjectCall(options: {
	readonly call: RecordedExecCall | undefined;
	readonly secretReferences: readonly string[];
	readonly serviceAccountToken: string;
}): void {
	if (!options.call) {
		throw new Error('Expected op inject call.');
	}

	expect(options.call).toEqual({
		args: ['inject'],
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

afterEach(() => {
	Object.defineProperty(process, 'platform', {
		configurable: true,
		value: originalPlatform,
	});
});

describe('resolveServiceAccountToken', () => {
	it('resolves token via op-cli', async () => {
		const fakeExec = async (command: string, args: readonly string[]): Promise<ExecFileResult> => {
			expect(command).toBe('op');
			expect(args).toEqual(['read', 'op://vault/item/field']);
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
		expect(execCalls).toEqual([
			{
				args: ['read', 'op://AI/anthropic/api-key'],
				command: 'op',
				env: expect.objectContaining({
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
				}),
			},
			expect.any(Object),
		]);
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
		expect(execCalls).toEqual([
			{
				args: ['read', 'op://AI/anthropic/api-key'],
				command: 'op',
				env: expect.objectContaining({
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
				}),
			},
		]);
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
		expect(execCalls).toEqual([
			expect.any(Object),
			{
				args: ['read', 'op://vault/item/a'],
				command: 'op',
				env: expect.objectContaining({
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
				}),
			},
			{
				args: ['read', 'op://vault/item/b'],
				command: 'op',
				env: expect.objectContaining({
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
				}),
			},
		]);
		expectOpInjectCall({
			call: execCalls[0],
			secretReferences: ['op://vault/item/a', 'op://vault/item/b'],
			serviceAccountToken: 'service-token',
		});
	});

	it('does not write op inject error details to stderr', async () => {
		const capturedStderrChunks: string[] = [];
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk): boolean => {
			capturedStderrChunks.push(String(chunk));
			return true;
		});
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

		try {
			await expect(
				secretResolver.resolveAll({
					A: { source: '1password', ref: 'op://vault/item/a' },
				}),
			).resolves.toEqual({
				A: 'serial:op://vault/item/a',
			});
		} finally {
			stderrWrite.mockRestore();
		}

		const capturedStderr = capturedStderrChunks.join('');
		expect(capturedStderr).toContain(
			'[secret-resolver] op inject batch resolution failed; falling back to serial op read.',
		);
		expect(capturedStderr).not.toContain('resolved-secret-value');
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
		await secretResolver
			.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			})
			.catch((error: unknown) => {
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) {
					throw new Error('Expected AggregateError');
				}
				expect(error.errors.map((cause: unknown) => String(cause))).toEqual([
					"Error: Failed to resolve secret 'A' from 'op://vault/item/a' via op read: denied:op://vault/item/a",
					"Error: Failed to resolve secret 'B' from 'op://vault/item/b' via op read: denied:op://vault/item/b",
				]);
			});
	});
});
