export const GIT_NETWORK_RETRY_DELAYS_MS = [2_000, 4_000, 16_000] as const;

export interface GitCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export interface GitCommandRetryResult {
	readonly attempts: number;
	readonly result: GitCommandResult;
}

const retryableGitFailurePatterns: readonly RegExp[] = [
	/ECONNRESET/iu,
	/EAI_AGAIN/iu,
	/Connection reset/iu,
	/Could not resolve host/iu,
	/HTTP (?:5\d\d|429)\b/iu,
	/\b(?:5\d\d|429)\b.*(?:GitHub|github|HTTP|http)/iu,
	/early EOF/iu,
	/RPC failed/iu,
	/terminated without an exit code/iu,
];

const permanentGitFailurePatterns: readonly RegExp[] = [
	/\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:401|403|404)\b/iu,
	/non-fast-forward/iu,
	/(?:!\s+\[rejected\]|remote rejected)/iu,
	/Authentication failed/iu,
	/Repository not found/iu,
	/Permission denied/iu,
];

export function isRetryableGitFailure(output: string): boolean {
	if (permanentGitFailurePatterns.some((pattern) => pattern.test(output))) {
		return false;
	}
	return retryableGitFailurePatterns.some((pattern) => pattern.test(output));
}

export async function runGitCommandWithTransientRetries(options: {
	readonly run: () => Promise<GitCommandResult>;
	readonly onRetry?: (props: {
		readonly attempt: number;
		readonly delayMs: number;
		readonly result: GitCommandResult;
	}) => Promise<void>;
	readonly sleep?: (delayMs: number) => Promise<void>;
}): Promise<GitCommandRetryResult> {
	const sleep =
		options.sleep ??
		(async (delayMs): Promise<void> => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, delayMs);
			});
		});
	let lastResult: GitCommandResult | undefined;

	for (
		let attemptNumber = 1;
		attemptNumber <= GIT_NETWORK_RETRY_DELAYS_MS.length + 1;
		attemptNumber += 1
	) {
		// Retry attempts are serial because each Git operation observes remote state.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const result = await options.run();
		lastResult = result;
		if (result.exitCode === 0) {
			return { attempts: attemptNumber, result };
		}
		const output = `${result.stdout}\n${result.stderr}`;
		const retryDelayMs = GIT_NETWORK_RETRY_DELAYS_MS[attemptNumber - 1];
		if (retryDelayMs === undefined || !isRetryableGitFailure(output)) {
			return { attempts: attemptNumber, result };
		}
		// Retry event ordering follows the serial Git attempts.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await options.onRetry?.({ attempt: attemptNumber, delayMs: retryDelayMs, result });
		// Backoff sleeps are intentionally serial between retry attempts.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await sleep(retryDelayMs);
	}

	if (!lastResult) {
		throw new Error('Git retry loop finished without running a command.');
	}
	return { attempts: GIT_NETWORK_RETRY_DELAYS_MS.length + 1, result: lastResult };
}
