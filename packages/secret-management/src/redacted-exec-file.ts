import { execFile } from 'node:child_process';

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

function readAggregateErrorChildren(error: AggregateError): readonly unknown[] {
	const errorChildren: unknown = error.errors;
	return Array.isArray(errorChildren) ? errorChildren : [];
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

function readErrorKilled(error: Error): boolean | undefined {
	if (!('killed' in error) || typeof error.killed !== 'boolean') {
		return undefined;
	}
	return error.killed;
}

function hasEnvironmentPrefix(
	env: Readonly<Record<string, string | undefined>>,
	prefix: string,
): boolean {
	return Object.keys(env).some((envName) => envName.startsWith(prefix));
}

function formatOpCliAuthContext(
	env: Readonly<Record<string, string | undefined>> | undefined,
	args: readonly string[],
): readonly string[] {
	if (env === undefined) {
		return ['opEnvIsolation=disabled', 'opAuth=ambient-process'];
	}

	return [
		'opEnvIsolation=enabled',
		`opAuth=${env.OP_SERVICE_ACCOUNT_TOKEN === undefined ? 'missing' : 'service-account-token'}`,
		`opSubcommand=${args[0] ?? 'unknown'}`,
		`opConfig=${env.OP_CONFIG_DIR === undefined ? 'default' : 'isolated'}`,
		`opBiometricUnlock=${env.OP_BIOMETRIC_UNLOCK_ENABLED ?? 'unset'}`,
		`opCache=${env.OP_CACHE ?? 'unset'}`,
		`opConnectEnv=${env.OP_CONNECT_HOST !== undefined || env.OP_CONNECT_TOKEN !== undefined ? 'present' : 'absent'}`,
		`opSessionEnv=${hasEnvironmentPrefix(env, 'OP_SESSION') ? 'present' : 'absent'}`,
		`opAccountEnv=${env.OP_ACCOUNT === undefined ? 'absent' : 'present'}`,
	];
}

function formatRedactedExecErrorDetail(options: {
	readonly args: readonly string[];
	readonly command: string;
	readonly elapsedMs: number;
	readonly env?: Readonly<Record<string, string | undefined>> | undefined;
	readonly error: Error;
	readonly stderr: string;
	readonly stdout: string;
}): string {
	const error = options.error;
	const exitCode = readErrorCode(error) ?? 'unknown';
	const signal = readErrorSignal(error);
	const details = [
		signal === undefined ? `exit code ${exitCode}` : `exit code ${exitCode}, signal ${signal}`,
		`elapsedMs=${String(options.elapsedMs)}`,
		'output=redacted',
		`stdoutBytes=${String(Buffer.byteLength(options.stdout, 'utf8'))}`,
		`stderrBytes=${String(Buffer.byteLength(options.stderr, 'utf8'))}`,
	];
	const killed = readErrorKilled(error);
	if (killed !== undefined) {
		details.push(`killed=${String(killed)}`);
	}
	if (options.command === 'op') {
		details.push(...formatOpCliAuthContext(options.env, options.args));
	}
	return details.join('; ');
}

function createExecFileError(options: {
	readonly args: readonly string[];
	readonly command: string;
	readonly elapsedMs: number;
	readonly env?: Readonly<Record<string, string | undefined>> | undefined;
	readonly error: Error;
	readonly redactErrorOutput?: boolean | undefined;
	readonly stderr: string;
	readonly stdout: string;
}): Error {
	if (options.redactErrorOutput) {
		const safeDetail = formatRedactedExecErrorDetail({
			args: options.args,
			command: options.command,
			elapsedMs: options.elapsedMs,
			...(options.env ? { env: options.env } : {}),
			error: options.error,
			stderr: options.stderr,
			stdout: options.stdout,
		});
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
		return new RedactedExecFileError(`${command} failed writing stdin: ${safeDetail}`, safeDetail);
	}
	return new Error(`${command} failed writing stdin: ${formatUnknownError(error)}`, {
		cause: error,
	});
}

export function execFileAsync(
	command: string,
	args: readonly string[],
	options?: ExecFileOptions,
): Promise<ExecFileResult> {
	return new Promise((resolve, reject) => {
		const startedAtMs = Date.now();
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
							args,
							command,
							elapsedMs: Date.now() - startedAtMs,
							env: options?.env,
							error,
							redactErrorOutput: options?.redactErrorOutput,
							stderr,
							stdout,
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
