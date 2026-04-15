/* oxlint-disable eslint/no-await-in-loop -- verification commands must run in stable serial order */
import { execa } from 'execa';

export type CommandStatus = 'passed' | 'failed' | 'timeout';

export interface VerificationCommand {
	readonly name: string;
	readonly command: string;
}

export interface VerificationCommandResult {
	readonly name: string;
	readonly passed: boolean;
	readonly exitCode: number;
	readonly output: string;
}

export interface RunVerificationOptions {
	readonly commands: readonly VerificationCommand[];
	readonly cwd: string;
	readonly timeoutMs: number;
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return 'Unknown error';
	}
}

export function parseCommand(command: string): readonly [string, ...string[]] {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		throw new Error('Unsafe command: command must not be empty');
	}

	const tokens: string[] = [];
	let current = '';
	let quote: "'" | '"' | null = null;

	for (let index = 0; index < trimmed.length; index += 1) {
		const char = trimmed[index] ?? '';
		const next = trimmed[index + 1] ?? '';

		if (quote === null) {
			if (char === "'" || char === '"') {
				quote = char;
				continue;
			}
			if (/\s/.test(char)) {
				if (current.length > 0) {
					tokens.push(current);
					current = '';
				}
				continue;
			}
			if (
				char === '|' ||
				char === '&' ||
				char === ';' ||
				char === '>' ||
				char === '<' ||
				char === '`' ||
				(char === '$' && next === '(')
			) {
				throw new Error(`Unsafe command: shell operator '${char}' is not allowed`);
			}
			if (char === '\\') {
				current += next;
				index += 1;
				continue;
			}
			current += char;
			continue;
		}

		if (char === quote) {
			quote = null;
			continue;
		}
		if (char === '\\') {
			current += next;
			index += 1;
			continue;
		}
		current += char;
	}

	if (quote !== null) {
		throw new Error('Unsafe command: unmatched quote');
	}
	if (current.length > 0) {
		tokens.push(current);
	}

	const [bin, ...args] = tokens;
	if (!bin) {
		throw new Error('Unsafe command: command must not be empty');
	}

	return [bin, ...args];
}

export async function runCommandWithTimeout(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ readonly status: CommandStatus; readonly output: string; readonly exitCode: number }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const [bin, ...args] = parseCommand(command);
		const result = await execa(bin, args, {
			cwd,
			cancelSignal: controller.signal,
			reject: false,
		});

		clearTimeout(timeout);

		if (result.isCanceled || result.isTerminated) {
			return { status: 'timeout', output: '', exitCode: -1 };
		}

		if ('code' in result && result.code === 'ENOENT') {
			const output =
				'shortMessage' in result && typeof result.shortMessage === 'string'
					? result.shortMessage
					: 'Command not found';
			return { status: 'failed', output, exitCode: 127 };
		}

		if (result.exitCode === 0) {
			return { status: 'passed', output: '', exitCode: 0 };
		}

		const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
		return {
			status: 'failed',
			output: combinedOutput.length > 4096 ? combinedOutput.slice(-4096) : combinedOutput,
			exitCode: result.exitCode ?? 1,
		};
	} catch (error) {
		clearTimeout(timeout);
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return {
				status: 'failed',
				output: formatUnknownError(error),
				exitCode: 127,
			};
		}
		return {
			status: 'failed',
			output: formatUnknownError(error),
			exitCode: 1,
		};
	}
}

export async function runVerification(
	options: RunVerificationOptions,
): Promise<readonly VerificationCommandResult[]> {
	const results: VerificationCommandResult[] = [];

	// Verification runs sequentially to keep output ordering stable and avoid oversubscribing the VM.
	// oxlint-disable-next-line eslint/no-await-in-loop
	for (const command of options.commands) {
		const result = await runCommandWithTimeout(command.command, options.cwd, options.timeoutMs);
		results.push({
			name: command.name,
			passed: result.status === 'passed',
			exitCode: result.exitCode,
			output: result.output,
		});
	}

	return results;
}

export function allVerificationsPassed(results: readonly VerificationCommandResult[]): boolean {
	return results.every((result) => result.passed);
}

export function buildVerificationFailureSummary(
	results: readonly VerificationCommandResult[],
): string {
	const failed = results.filter((result) => !result.passed);
	if (failed.length === 0) {
		return 'All verifications passed.';
	}

	return failed
		.map((result) => `${result.name} failed (exit code ${result.exitCode}):\n${result.output}`)
		.join('\n\n');
}
