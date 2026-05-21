import { execFile, type ExecFileException } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { SecretRef } from './contracts.js';
import {
	createSecretResolver,
	type ExecFileOptions,
	type ExecFileResult,
	type SecretResolverClient,
} from './onepassword-secret-resolver.js';
import { shouldRunOnePasswordSecretResolverSmoke } from './smoke-test-gates.js';

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
	readonly templateSecretReferences: readonly string[];
}

const unsafeAmbientOnePasswordAuthEnvNames = [
	'OP_CONNECT_HOST',
	'OP_CONNECT_TOKEN',
	'OP_SESSION',
] satisfies readonly string[];

const defaultOnePasswordSmokeSecretReferences = [
	'op://agent-vm-testing/smoke-test-item1/ref1',
	'op://agent-vm-testing/smoke-test-item1/ref2',
	'op://agent-vm-testing/smoke-test-item1/password',
	'op://agent-vm-testing/smoke-test-item2/password',
] satisfies readonly string[];

const describeOnePasswordSecretResolverSmoke = shouldRunOnePasswordSecretResolverSmoke()
	? describe
	: describe.skip;

describe('smoke: 1Password default refs', () => {
	it('covers both smoke items and item1 fields in one batch', () => {
		expect(defaultOnePasswordSmokeSecretReferences).toEqual([
			'op://agent-vm-testing/smoke-test-item1/ref1',
			'op://agent-vm-testing/smoke-test-item1/ref2',
			'op://agent-vm-testing/smoke-test-item1/password',
			'op://agent-vm-testing/smoke-test-item2/password',
		]);
	});
});

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
	const serviceAccountToken = process.env.TEST_OP_SERVICE_ACCOUNT_TOKEN;
	const secretReferences = readSmokeSecretReferences();

	if (!serviceAccountToken) {
		throw new Error('Set TEST_OP_SERVICE_ACCOUNT_TOKEN when AGENT_VM_1PASSWORD_SMOKE=1.');
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

function expectSafeRecordedOpCall(
	opCall: RecordedOpCall | undefined,
	config: OnePasswordSmokeConfig,
): RecordedOpCall {
	if (!opCall) {
		throw new Error('Expected the smoke resolver to record an op subprocess call.');
	}
	expect(opCall.redactErrorOutput).toBe(true);
	expect(opCall.serviceAccountTokenLength).toBe(config.serviceAccountToken.length);
	expect(opCall.forwardedUnsafeAuthEnvNames).toEqual([]);
	return opCall;
}

function expectOpInjectBatchCall(options: {
	readonly config: OnePasswordSmokeConfig;
	readonly opCall: RecordedOpCall | undefined;
}): void {
	const opInjectCall = expectSafeRecordedOpCall(options.opCall, options.config);
	expect(opInjectCall.command).toBe('op');
	expect(opInjectCall.args).toEqual(['inject', '--in-file', '/dev/stdin']);
	expect(opInjectCall.inputLength).toBeGreaterThan(options.config.secretReferences.join('').length);
	expect(opInjectCall.templateSecretReferences).toEqual(options.config.secretReferences);
}

function expectSerialOpReadFallbackCalls(options: {
	readonly config: OnePasswordSmokeConfig;
	readonly opCalls: readonly RecordedOpCall[];
}): void {
	expect(options.opCalls).toHaveLength(options.config.secretReferences.length + 1);
	expectOpInjectBatchCall({
		config: options.config,
		opCall: options.opCalls[0],
	});
	for (const [index, secretReference] of options.config.secretReferences.entries()) {
		const opReadCall = expectSafeRecordedOpCall(options.opCalls[index + 1], options.config);
		expect(opReadCall.command).toBe('op');
		expect(opReadCall.args).toEqual(['read', secretReference]);
		expect(opReadCall.inputLength).toBe(0);
		expect(opReadCall.templateSecretReferences).toEqual([]);
	}
}

describeOnePasswordSecretResolverSmoke('smoke: 1Password op inject fallback', () => {
	it('resolves live refs through one op inject batch and verifies serial read fallback', async () => {
		const config = readOnePasswordSmokeConfig();
		const refs = createSmokeSecretRefs(config.secretReferences);
		const batchOpCalls: RecordedOpCall[] = [];
		const serialFallbackOpCalls: RecordedOpCall[] = [];
		const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const batchResolver = await createSecretResolver(
			{ serviceAccountToken: config.serviceAccountToken },
			{
				createClient: async () => forcedFailingSdkClient,
				execFileAsync: createRecordingExecFileAsync(batchOpCalls),
			},
		);
		const serialFallbackResolver = await createSecretResolver(
			{ serviceAccountToken: config.serviceAccountToken },
			{
				createClient: async () => forcedFailingSdkClient,
				execFileAsync: createRecordingExecFileAsync(serialFallbackOpCalls, {
					failOpInjectBeforeExec: true,
				}),
			},
		);

		try {
			const batchResolvedSecrets = await batchResolver.resolveAll(refs);
			expectResolvedSmokeSecrets(batchResolvedSecrets, refs);
			expect(batchOpCalls).toHaveLength(1);
			expectOpInjectBatchCall({
				config,
				opCall: batchOpCalls[0],
			});

			const fallbackResolvedSecrets = await serialFallbackResolver.resolveAll(refs);
			expectResolvedSmokeSecrets(fallbackResolvedSecrets, refs);
			expectSerialOpReadFallbackCalls({
				config,
				opCalls: serialFallbackOpCalls,
			});
			expect(stderrWriteSpy).not.toHaveBeenCalled();
		} finally {
			stderrWriteSpy.mockRestore();
		}
	});
});
