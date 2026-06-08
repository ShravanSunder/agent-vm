import { describe, expect, test, vi } from 'vitest';

import { isRetryableGitFailure, runGitCommandWithTransientRetries } from './git-retry-support.js';

describe('git-retry-support', () => {
	test('classifies transient GitHub and network failures as retryable', () => {
		const retryableOutputs = [
			'RPC failed; HTTP 503 EAI_AGAIN',
			'fatal: unable to access: Could not resolve host: github.com',
			'HTTP 429 GitHub rate limit',
			'early EOF',
			'Connection reset by peer',
			'git fetch terminated without an exit code',
		];

		for (const output of retryableOutputs) {
			expect(isRetryableGitFailure(output)).toBe(true);
		}
	});

	test('classifies auth and branch protection failures as permanent', () => {
		const permanentOutputs = [
			'HTTP 401 unauthorized',
			'HTTP 403 forbidden',
			'HTTP 404 Repository not found',
			'remote rejected: non-fast-forward',
			'Authentication failed',
			'Permission denied',
		];

		for (const output of permanentOutputs) {
			expect(isRetryableGitFailure(output)).toBe(false);
		}
	});

	test('does not classify unrelated 404 text as permanent', () => {
		expect(
			isRetryableGitFailure(
				'RPC failed; HTTP 503 while fetching https://api.github.com/repos/acme/widgets/issues/404',
			),
		).toBe(true);
	});

	test('passes abort signals to git attempts and retry sleeps', async () => {
		const abortController = new AbortController();
		const run = vi.fn(async () => ({
			stdout: '',
			stderr: 'RPC failed; HTTP 503',
			exitCode: 128,
		}));
		const sleep = vi.fn(async (_delayMs: number, signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			abortController.abort(new Error('cancelled'));
			throw abortController.signal.reason;
		});

		await expect(
			runGitCommandWithTransientRetries({
				run,
				sleep,
				signal: abortController.signal,
			}),
		).rejects.toThrow('cancelled');

		expect(run).toHaveBeenCalledWith(abortController.signal);
		expect(sleep).toHaveBeenCalledWith(2_000, abortController.signal);
	});

	test('aborts the default retry sleep without waiting for the full backoff', async () => {
		const abortController = new AbortController();
		const run = vi.fn(async () => ({
			stdout: '',
			stderr: 'RPC failed; HTTP 503',
			exitCode: 128,
		}));

		const promise = runGitCommandWithTransientRetries({
			run,
			signal: abortController.signal,
		});
		await Promise.resolve();
		abortController.abort(new Error('cancelled'));

		await expect(promise).rejects.toThrow('cancelled');
	});
});
