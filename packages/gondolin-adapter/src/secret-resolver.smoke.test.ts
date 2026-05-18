import { execFile, type ExecFileException } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import {
	createSecretResolver,
	type ExecFileOptions,
	type ExecFileResult,
	type SecretResolverClient,
} from './secret-resolver.js';
import { shouldRunOnePasswordSecretResolverSmoke } from './smoke-test-gates.js';
import type { SecretRef } from './types.js';

interface OnePasswordSmokeConfig {
	readonly secretReferences: readonly string[];
	readonly serviceAccountToken: string;
}

interface RecordedOpCall {
	readonly args: readonly string[];
	readonly command: string;
	readonly forwardedUnsafeAuthEnvNames: readonly string[];
	readonly inputLength: number;
	readonly redactErrorOutput: boolean;
	readonly serviceAccountTokenLength: number;
}

const unsafeAmbientOnePasswordAuthEnvNames = [
	'OP_CONNECT_HOST',
	'OP_CONNECT_TOKEN',
	'OP_SESSION',
] satisfies readonly string[];

const defaultOnePasswordSmokeSecretReferences = [
	'op://agent-vm/smoke-test-item1/ref1',
	'op://agent-vm/smoke-test-item1/ref2',
	'op://agent-vm/smoke-test-item2/password',
] satisfies readonly string[];

const describeOnePasswordSecretResolverSmoke = shouldRunOnePasswordSecretResolverSmoke()
	? describe
	: describe.skip;

function readSmokeSecretReferences(): readonly string[] {
	const configuredReferences = process.env.AGENT_VM_1PASSWORD_SMOKE_REFS;
	if (!configuredReferences) {
		return defaultOnePasswordSmokeSecretReferences;
	}

	return configuredReferences
		.split(',')
		.map((secretReference) => secretReference.trim())
		.filter((secretReference) => secretReference.length > 0);
}

function readOnePasswordSmokeConfig(): OnePasswordSmokeConfig {
	const serviceAccountToken =
		process.env.AGENT_VM_1PASSWORD_SMOKE_SERVICE_ACCOUNT_TOKEN ??
		process.env.OP_SERVICE_ACCOUNT_TOKEN;
	const secretReferences = readSmokeSecretReferences();

	if (!serviceAccountToken) {
		throw new Error(
			'Set AGENT_VM_1PASSWORD_SMOKE_SERVICE_ACCOUNT_TOKEN or OP_SERVICE_ACCOUNT_TOKEN when AGENT_VM_1PASSWORD_SMOKE=1.',
		);
	}
	if (secretReferences.length === 0) {
		throw new Error('Set AGENT_VM_1PASSWORD_SMOKE_REFS to at least one op:// reference.');
	}
	for (const secretReference of secretReferences) {
		if (!secretReference.startsWith('op://')) {
			throw new Error('Every AGENT_VM_1PASSWORD_SMOKE_REFS entry must be an op:// reference.');
		}
	}

	return { secretReferences, serviceAccountToken };
}

function copyExecEnv(
	env: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv | undefined {
	if (!env) {
		return undefined;
	}

	const copiedEnv: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) {
			copiedEnv[name] = value;
		}
	}
	return copiedEnv;
}

function readExecErrorCode(error: ExecFileException): string {
	if (typeof error.code === 'number' || typeof error.code === 'string') {
		return String(error.code);
	}
	return 'unknown';
}

function formatSmokeExecError(command: string, error: ExecFileException): Error {
	const signal = error.signal === null ? undefined : error.signal;
	const signalDetail = signal === undefined ? '' : `, signal ${signal}`;
	return new Error(`${command} failed: exit code ${readExecErrorCode(error)}${signalDetail}`);
}

function createRecordingExecFileAsync(
	calls: RecordedOpCall[],
): (
	command: string,
	args: readonly string[],
	options?: ExecFileOptions,
) => Promise<ExecFileResult> {
	return (command, args, options): Promise<ExecFileResult> =>
		new Promise((resolve, reject) => {
			let hasSettled = false;
			const resolveOnce = (result: ExecFileResult): void => {
				if (hasSettled) {
					return;
				}
				hasSettled = true;
				resolve(result);
			};
			const rejectOnce = (error: Error): void => {
				if (hasSettled) {
					return;
				}
				hasSettled = true;
				reject(error);
			};
			const childEnv = copyExecEnv(options?.env);

			calls.push({
				args: [...args],
				command,
				forwardedUnsafeAuthEnvNames: unsafeAmbientOnePasswordAuthEnvNames.filter(
					(envName) => options?.env?.[envName] !== undefined,
				),
				inputLength: options?.input?.length ?? 0,
				redactErrorOutput: options?.redactErrorOutput === true,
				serviceAccountTokenLength: options?.env?.OP_SERVICE_ACCOUNT_TOKEN?.length ?? 0,
			});

			const child = execFile(
				command,
				[...args],
				{ encoding: 'utf8', env: childEnv, timeout: 30_000 },
				(error, stdout, stderr) => {
					if (error) {
						rejectOnce(formatSmokeExecError(command, error));
						return;
					}

					resolveOnce({
						stdout,
						stderr,
					});
				},
			);

			if (options?.input !== undefined) {
				if (!child.stdin) {
					child.kill();
					rejectOnce(new Error(`${command} did not expose stdin for smoke input`));
					return;
				}

				child.stdin.once('error', () => {
					child.kill();
					rejectOnce(new Error(`${command} failed writing smoke input`));
				});
				child.stdin.end(options.input);
			}
		});
}

const forcedFailingSdkClient = {
	secrets: {
		resolve: async (_secretReference: string): Promise<never> => {
			throw new Error('forced SDK resolve failure for 1Password smoke');
		},
		resolveAll: async (_secretReferences: readonly string[]): Promise<never> => {
			throw new Error('forced SDK resolveAll failure for 1Password smoke');
		},
	},
} satisfies SecretResolverClient;

describeOnePasswordSecretResolverSmoke('smoke: 1Password op inject fallback', () => {
	it('resolves live 1Password refs through one op inject subprocess after SDK failure', async () => {
		const config = readOnePasswordSmokeConfig();
		const recordedOpCalls: RecordedOpCall[] = [];
		const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const resolver = await createSecretResolver(
			{ serviceAccountToken: config.serviceAccountToken },
			{
				createClient: async () => forcedFailingSdkClient,
				execFileAsync: createRecordingExecFileAsync(recordedOpCalls),
			},
		);
		const refs = Object.fromEntries(
			config.secretReferences.map((secretReference, index) => [
				`ONE_PASSWORD_SMOKE_SECRET_${String(index + 1)}`,
				{ ref: secretReference, source: '1password' },
			]),
		) satisfies Record<string, SecretRef>;

		try {
			const resolvedSecrets = await resolver.resolveAll(refs);

			expect(Object.keys(resolvedSecrets)).toHaveLength(config.secretReferences.length);
			for (const secretName of Object.keys(refs)) {
				const resolvedSecret = resolvedSecrets[secretName];
				expect(resolvedSecret).toBeDefined();
				expect(resolvedSecret?.length).toBeGreaterThan(0);
			}
			expect(recordedOpCalls).toHaveLength(1);

			const opInjectCall = recordedOpCalls[0];
			if (!opInjectCall) {
				throw new Error('Expected the smoke resolver to record one op inject subprocess call.');
			}

			expect(opInjectCall.command).toBe('op');
			expect(opInjectCall.args).toEqual(['inject', '--in-file', '/dev/stdin']);
			expect(opInjectCall.inputLength).toBeGreaterThan(config.secretReferences.join('').length);
			expect(opInjectCall.redactErrorOutput).toBe(true);
			expect(opInjectCall.serviceAccountTokenLength).toBe(config.serviceAccountToken.length);
			expect(opInjectCall.forwardedUnsafeAuthEnvNames).toEqual([]);
			expect(stderrWriteSpy).not.toHaveBeenCalled();
		} finally {
			stderrWriteSpy.mockRestore();
		}
	});
});
