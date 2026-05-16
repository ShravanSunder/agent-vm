import { afterEach, describe, expect, it } from 'vitest';

import {
	createSecretResolver,
	createOpCliSecretResolver,
	resolveServiceAccountToken,
	type ExecFileResult,
	type SecretResolverClient,
} from './secret-resolver.js';

const emptyExecFileResult = async (): Promise<ExecFileResult> => ({ stdout: '', stderr: '' });
const originalPlatform = process.platform;

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

	it('falls back to op read when sdk client creation fails', async () => {
		const execCalls: Array<{
			readonly args: readonly string[];
			readonly command: string;
			readonly env?: Readonly<Record<string, string | undefined>>;
		}> = [];

		const secretResolver = await createSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				createClient: async (): Promise<SecretResolverClient> => {
					throw new Error('sdk init failed');
				},
				execFileAsync: async (command, args, options) => {
					execCalls.push({
						args,
						command,
						...(options?.env ? { env: options.env } : {}),
					});
					return { stdout: 'resolved-from-op\n', stderr: '' };
				},
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
			OPENCLAW_GATEWAY_TOKEN: 'resolved-from-op',
		});
		expect(execCalls).toEqual([
			{
				args: ['read', 'op://AI/anthropic/api-key'],
				command: 'op',
				env: expect.objectContaining({
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
				}),
			},
			{
				args: ['read', 'op://agent-vm/agent-gateway/token'],
				command: 'op',
				env: expect.objectContaining({
					OP_SERVICE_ACCOUNT_TOKEN: 'service-token',
				}),
			},
		]);
	});

	it('falls back to op read when sdk secret resolution fails after client creation', async () => {
		const execCalls: {
			readonly args: readonly string[];
			readonly command: string;
			readonly env?: Readonly<Record<string, string | undefined>>;
		}[] = [];

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
				execFileAsync: async (command, args, options) => {
					execCalls.push({
						args,
						command,
						...(options?.env ? { env: options.env } : {}),
					});
					return { stdout: 'resolved-from-op\n', stderr: '' };
				},
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

	it('falls back to serial op reads when sdk resolveAll omits a requested ref', async () => {
		const execCalls: Array<{
			readonly args: readonly string[];
			readonly command: string;
			readonly env?: Readonly<Record<string, string | undefined>>;
		}> = [];
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
				execFileAsync: async (command, args, options) => {
					execCalls.push({
						args,
						command,
						...(options?.env ? { env: options.env } : {}),
					});
					return { stdout: `op:${args[1]}\n`, stderr: '' };
				},
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
		).resolves.toEqual({
			A: 'op:op://vault/item/a',
			B: 'op:op://vault/item/b',
		});
		expect(execCalls.map((call) => call.args)).toEqual([
			['read', 'op://vault/item/a'],
			['read', 'op://vault/item/b'],
		]);
	});
});

describe('createOpCliSecretResolver', () => {
	it('resolves all refs sequentially via op read', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const execCalls: {
			readonly args: readonly string[];
			readonly command: string;
			readonly env?: Readonly<Record<string, string | undefined>>;
		}[] = [];
		const secretResolver = await createOpCliSecretResolver(
			{ serviceAccountToken: 'service-token' },
			{
				execFileAsync: async (command, args, options) => {
					inFlight += 1;
					maxInFlight = Math.max(maxInFlight, inFlight);
					try {
						execCalls.push({
							args,
							command,
							...(options?.env ? { env: options.env } : {}),
						});
						return { stdout: `${args[1]}\n`, stderr: '' };
					} finally {
						inFlight -= 1;
					}
				},
			},
		);

		await expect(
			secretResolver.resolveAll({
				A: { source: '1password', ref: 'op://vault/item/a' },
				B: { source: '1password', ref: 'op://vault/item/b' },
			}),
		).resolves.toEqual({
			A: 'op://vault/item/a',
			B: 'op://vault/item/b',
		});
		expect(execCalls).toEqual([
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
		expect(maxInFlight).toBe(1);
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
