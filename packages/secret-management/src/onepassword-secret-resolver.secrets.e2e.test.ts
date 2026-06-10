import { execFile, type ExecFileException } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { SecretRef } from './contracts.js';
import { shouldRunOnePasswordSecretResolverE2e } from './e2e-test-gates.js';
import {
	readOnePasswordE2eTestConfig,
	type OnePasswordE2eTestConfig,
} from './onepassword-e2e-test-config.js';
import {
	createSecretResolver,
	type ExecFileOptions,
	type ExecFileResult,
	type SecretResolverClient,
} from './onepassword-secret-resolver.js';

interface RecordedOpCall {
	readonly args: readonly string[];
	readonly command: string;
	readonly forwardedUnsafeAuthEnvNames: readonly string[];
	readonly inputLength: number;
	readonly opBiometricUnlock: string | undefined;
	readonly opCache: string | undefined;
	readonly opConfigDir: string | undefined;
	readonly redactErrorOutput: boolean;
	readonly serviceAccountTokenLength: number;
	readonly templateSecretReferences: readonly string[];
}

const unsafeAmbientOnePasswordAuthEnvNames = [
	'OP_ACCOUNT',
	'OP_CONNECT_HOST',
	'OP_CONNECT_TOKEN',
	'OP_SESSION',
	'OP_SESSION_human',
] satisfies readonly string[];

const poisonedAmbientOnePasswordEnv = {
	OP_ACCOUNT: 'ambient-human-account',
	OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
	OP_CACHE: 'true',
	OP_CONNECT_HOST: 'https://connect.example.test',
	OP_CONNECT_TOKEN: 'ambient-connect-token',
	OP_CONFIG_DIR: '/tmp/ambient-human-op-config',
	OP_SERVICE_ACCOUNT_TOKEN: 'ambient-service-token',
	OP_SESSION: 'ambient-session-token',
	OP_SESSION_human: 'ambient-named-session-token',
} satisfies Readonly<Record<string, string>>;

const describeOnePasswordSecretResolverE2e = shouldRunOnePasswordSecretResolverE2e()
	? describe
	: describe.skip;

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

function readTemplateSecretReferences(input: string | undefined): readonly string[] {
	if (input === undefined) {
		return [];
	}

	const secretReferences: string[] = [];
	for (const line of input.split('\n')) {
		if (line.startsWith('{{ ') && line.endsWith(' }}')) {
			secretReferences.push(line.slice(3, -3));
		}
	}
	return secretReferences;
}

function createSmokeSecretRefs(secretReferences: readonly string[]): Record<string, SecretRef> {
	const refs: Record<string, SecretRef> = {};
	for (const [index, secretReference] of secretReferences.entries()) {
		refs[`ONE_PASSWORD_SMOKE_SECRET_${String(index + 1)}`] = {
			ref: secretReference,
			source: '1password',
		};
	}
	return refs;
}

function createRecordingExecFileAsync(
	calls: RecordedOpCall[],
	recordingOptions: {
		readonly failOpInjectBeforeExec?: boolean | undefined;
	} = {},
): (
	command: string,
	args: readonly string[],
	execOptions?: ExecFileOptions,
) => Promise<ExecFileResult> {
	return (command, args, execOptions): Promise<ExecFileResult> =>
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
			const childEnv = copyExecEnv(execOptions?.env);

			calls.push({
				args: [...args],
				command,
				forwardedUnsafeAuthEnvNames: unsafeAmbientOnePasswordAuthEnvNames.filter(
					(envName) => execOptions?.env?.[envName] !== undefined,
				),
				inputLength: execOptions?.input?.length ?? 0,
				opBiometricUnlock: execOptions?.env?.OP_BIOMETRIC_UNLOCK_ENABLED,
				opCache: execOptions?.env?.OP_CACHE,
				opConfigDir: execOptions?.env?.OP_CONFIG_DIR,
				redactErrorOutput: execOptions?.redactErrorOutput === true,
				serviceAccountTokenLength: execOptions?.env?.OP_SERVICE_ACCOUNT_TOKEN?.length ?? 0,
				templateSecretReferences: readTemplateSecretReferences(execOptions?.input),
			});

			if (recordingOptions.failOpInjectBeforeExec && command === 'op' && args[0] === 'inject') {
				rejectOnce(new Error('forced op inject failure for 1Password smoke'));
				return;
			}

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

			if (execOptions?.input !== undefined) {
				if (!child.stdin) {
					child.kill();
					rejectOnce(new Error(`${command} did not expose stdin for smoke input`));
					return;
				}

				child.stdin.once('error', () => {
					child.kill();
					rejectOnce(new Error(`${command} failed writing smoke input`));
				});
				child.stdin.end(execOptions.input);
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

function expectResolvedSmokeSecrets(
	resolvedSecrets: Readonly<Record<string, string>>,
	refs: Readonly<Record<string, SecretRef>>,
): void {
	expect(Object.keys(resolvedSecrets)).toHaveLength(Object.keys(refs).length);
	for (const secretName of Object.keys(refs)) {
		const resolvedSecret = resolvedSecrets[secretName];
		expect(resolvedSecret).toBeDefined();
		expect(resolvedSecret?.length).toBeGreaterThan(0);
	}
}

async function withPoisonedAmbientOnePasswordEnv<TResult>(
	callback: () => Promise<TResult>,
): Promise<TResult> {
	const previousValues = Object.fromEntries(
		Object.keys(poisonedAmbientOnePasswordEnv).map((envName) => [envName, process.env[envName]]),
	) as Record<keyof typeof poisonedAmbientOnePasswordEnv, string | undefined>;
	for (const [envName, envValue] of Object.entries(poisonedAmbientOnePasswordEnv)) {
		process.env[envName] = envValue;
	}
	try {
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

function expectSafeRecordedOpCall(
	opCall: RecordedOpCall | undefined,
	config: OnePasswordE2eTestConfig,
): RecordedOpCall {
	if (!opCall) {
		throw new Error('Expected the smoke resolver to record an op subprocess call.');
	}
	expect(opCall.redactErrorOutput).toBe(true);
	expect(opCall.serviceAccountTokenLength).toBe(config.serviceAccountToken.length);
	expect(opCall.forwardedUnsafeAuthEnvNames).toEqual([]);
	expect(opCall.opBiometricUnlock).toBe('false');
	expect(opCall.opCache).toBe('false');
	expect(opCall.opConfigDir).toContain('agent-vm-op-config-');
	expect(opCall.opConfigDir).not.toBe(poisonedAmbientOnePasswordEnv.OP_CONFIG_DIR);
	return opCall;
}

function expectOpInjectBatchCall(options: {
	readonly config: OnePasswordE2eTestConfig;
	readonly opCall: RecordedOpCall | undefined;
}): void {
	const opInjectCall = expectSafeRecordedOpCall(options.opCall, options.config);
	expect(opInjectCall.command).toBe('op');
	expect(opInjectCall.args).toEqual(['inject', '--in-file', '/dev/stdin']);
	expect(opInjectCall.inputLength).toBeGreaterThan(options.config.secretReferences.join('').length);
	expect(opInjectCall.templateSecretReferences).toEqual(options.config.secretReferences);
}

describeOnePasswordSecretResolverE2e('e2e: 1Password op inject fallback', () => {
	it('resolves live refs through one op inject batch when the SDK fails', async () => {
		const config = readOnePasswordE2eTestConfig();
		const refs = createSmokeSecretRefs(config.secretReferences);
		const batchOpCalls: RecordedOpCall[] = [];
		const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

		try {
			await withPoisonedAmbientOnePasswordEnv(async () => {
				const batchResolver = await createSecretResolver(
					{ serviceAccountToken: config.serviceAccountToken },
					{
						createClient: async () => forcedFailingSdkClient,
						execFileAsync: createRecordingExecFileAsync(batchOpCalls),
					},
				);

				const batchResolvedSecrets = await batchResolver.resolveAll(refs);
				expectResolvedSmokeSecrets(batchResolvedSecrets, refs);
				expect(batchOpCalls).toHaveLength(1);
				expectOpInjectBatchCall({
					config,
					opCall: batchOpCalls[0],
				});
			});
			expect(stderrWriteSpy).not.toHaveBeenCalled();
		} finally {
			stderrWriteSpy.mockRestore();
		}
	});

	it('throws when both the SDK and op inject fail (no further fallback)', async () => {
		const config = readOnePasswordE2eTestConfig();
		const refs = createSmokeSecretRefs(config.secretReferences);
		const opCalls: RecordedOpCall[] = [];
		const failingResolver = await createSecretResolver(
			{ serviceAccountToken: config.serviceAccountToken },
			{
				createClient: async () => forcedFailingSdkClient,
				execFileAsync: createRecordingExecFileAsync(opCalls, {
					failOpInjectBeforeExec: true,
				}),
			},
		);

		await expect(failingResolver.resolveAll(refs)).rejects.toThrow(
			/1Password SDK resolveAll and op CLI fallback both failed/u,
		);
		// op inject was attempted; serial op read fallback is intentionally absent.
		const opReadCalls = opCalls.filter((call) => call.args[0] === 'read');
		expect(opReadCalls).toEqual([]);
	});
});
