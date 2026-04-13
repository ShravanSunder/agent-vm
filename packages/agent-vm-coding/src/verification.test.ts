import { describe, expect, it } from 'vitest';

import { runCommandWithTimeout, verify, type VerifyOptions } from './verification.js';

describe('verification', () => {
	describe('verify', () => {
		it('returns passed when both commands exit 0', async () => {
			const options: VerifyOptions = {
				testCommand: 'true',
				lintCommand: 'true',
				cwd: process.cwd(),
				timeoutMs: 5000,
			};

			const result = await verify(options);

			expect(result.testStatus).toBe('passed');
			expect(result.testExitCode).toBe(0);
			expect(result.lintStatus).toBe('passed');
			expect(result.lintExitCode).toBe(0);
		});

		it('returns failed with output when test command exits non-zero', async () => {
			const options: VerifyOptions = {
				testCommand: 'node -e "console.log(\'test failed\'); process.exit(1)"',
				lintCommand: 'true',
				cwd: process.cwd(),
				timeoutMs: 5000,
			};

			const result = await verify(options);

			expect(result.testStatus).toBe('failed');
			expect(result.testExitCode).toBe(1);
			expect(result.testOutput).toContain('test failed');
			expect(result.lintStatus).toBe('passed');
			expect(result.lintExitCode).toBe(0);
		});

		it('returns timeout when command exceeds timeout', async () => {
			const options: VerifyOptions = {
				testCommand: 'sleep 30',
				lintCommand: 'true',
				cwd: process.cwd(),
				timeoutMs: 500,
			};

			const result = await verify(options);

			expect(result.testStatus).toBe('timeout');
			expect(result.lintStatus).toBe('passed');
		});

		it('lint runs independently of test result', async () => {
			const options: VerifyOptions = {
				testCommand: 'false',
				lintCommand: 'node -e "console.log(\'lint failed\'); process.exit(2)"',
				cwd: process.cwd(),
				timeoutMs: 5000,
			};

			const result = await verify(options);

			expect(result.testStatus).toBe('failed');
			expect(result.testExitCode).toBe(1);
			expect(result.lintStatus).toBe('failed');
			expect(result.lintExitCode).toBe(2);
			expect(result.lintOutput).toContain('lint failed');
		});

		it('lint fails independently of test passing', async () => {
			const options: VerifyOptions = {
				testCommand: 'node -e "console.log(\'ok\')"',
				lintCommand: 'false',
				cwd: process.cwd(),
				timeoutMs: 5000,
			};

			const result = await verify(options);

			expect(result.testStatus).toBe('passed');
			expect(result.lintStatus).toBe('failed');
			expect(result.lintExitCode).toBe(1);
		});

		it('both test and lint fail with different exit codes', async () => {
			const options: VerifyOptions = {
				testCommand: 'node -e "process.exit(3)"',
				lintCommand: 'node -e "process.exit(5)"',
				cwd: process.cwd(),
				timeoutMs: 5000,
			};

			const result = await verify(options);

			expect(result.testStatus).toBe('failed');
			expect(result.testExitCode).toBe(3);
			expect(result.lintStatus).toBe('failed');
			expect(result.lintExitCode).toBe(5);
		});

		it('empty output on failure when no stdout', async () => {
			const options: VerifyOptions = {
				testCommand: 'false',
				lintCommand: 'true',
				cwd: process.cwd(),
				timeoutMs: 5000,
			};

			const result = await verify(options);

			expect(result.testStatus).toBe('failed');
			expect(result.testOutput).toBe('');
			expect(result.testOutput).not.toBeUndefined();
			expect(result.testOutput).not.toBeNull();
		});
	});

	describe('runCommandWithTimeout', () => {
		it('rejects commands with unsafe shell operators', async () => {
			const result = await runCommandWithTimeout(
				'echo safe && touch pwned.txt',
				process.cwd(),
				5000,
			);

			expect(result.status).toBe('failed');
			expect(result.output).toContain('Unsafe command');
		});

		it('returns command-not-found failures with exit code 127', async () => {
			const result = await runCommandWithTimeout(
				'definitely-not-a-real-command',
				process.cwd(),
				5000,
			);

			expect(result.status).toBe('failed');
			expect(result.exitCode).toBe(127);
		});

		it('truncates output to 4KB for large outputs', async () => {
			const result = await runCommandWithTimeout(
				'node -e "process.stdout.write(\'x\'.repeat(10000)); process.exit(1)"',
				process.cwd(),
				5000,
			);

			expect(result.status).toBe('failed');
			expect(result.output.length).toBeLessThanOrEqual(4096);
		});

		it('returns passed for successful command', async () => {
			const result = await runCommandWithTimeout('true', process.cwd(), 5000);

			expect(result.status).toBe('passed');
			expect(result.exitCode).toBe(0);
		});

		it('returns failed for non-zero exit', async () => {
			const result = await runCommandWithTimeout(
				'node -e "console.log(\'error message\'); process.exit(3)"',
				process.cwd(),
				5000,
			);

			expect(result.status).toBe('failed');
			expect(result.exitCode).toBe(3);
			expect(result.output).toContain('error message');
		});

		it('returns timeout when command is aborted', async () => {
			const result = await runCommandWithTimeout('sleep 10', process.cwd(), 500);

			expect(result.status).toBe('timeout');
		});
	});
});
