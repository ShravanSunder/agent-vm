import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	allVerificationsPassed,
	buildVerificationFailureSummary,
	parseCommand,
	runVerification,
} from './verification-runner.js';

describe('verification-runner', () => {
	describe('parseCommand', () => {
		it('tokenizes a simple command', () => {
			expect(parseCommand('npm test')).toEqual(['npm', 'test']);
		});

		it('tokenizes a command with quoted arguments', () => {
			expect(parseCommand('echo "hello world"')).toEqual(['echo', 'hello world']);
		});

		it('tokenizes single-quoted arguments', () => {
			expect(parseCommand("echo 'hello world'")).toEqual(['echo', 'hello world']);
		});

		it('rejects pipe operator', () => {
			expect(() => parseCommand('cat file | grep foo')).toThrow("shell operator '|'");
		});

		it('rejects semicolon', () => {
			expect(() => parseCommand('echo a; echo b')).toThrow("shell operator ';'");
		});

		it('rejects backtick', () => {
			expect(() => parseCommand('echo `whoami`')).toThrow("shell operator '`'");
		});

		it('rejects $() subshell', () => {
			expect(() => parseCommand('echo $(whoami)')).toThrow("shell operator '$'");
		});

		it('rejects redirect operators', () => {
			expect(() => parseCommand('echo foo > file')).toThrow("shell operator '>'");
			expect(() => parseCommand('cat < file')).toThrow("shell operator '<'");
		});

		it('rejects empty command', () => {
			expect(() => parseCommand('')).toThrow('command must not be empty');
			expect(() => parseCommand('   ')).toThrow('command must not be empty');
		});

		it('rejects unmatched quote', () => {
			expect(() => parseCommand('echo "hello')).toThrow('unmatched quote');
		});

		it('handles escaped characters', () => {
			expect(parseCommand('echo hello\\ world')).toEqual(['echo', 'hello world']);
		});
	});

	describe('runVerification', () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'verify-test-'));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		it('runs passing commands and returns success', async () => {
			const results = await runVerification({
				commands: [{ name: 'echo-test', command: 'echo hello' }],
				cwd: tempDir,
				timeoutMs: 10_000,
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.name).toBe('echo-test');
			expect(results[0]?.passed).toBe(true);
			expect(results[0]?.exitCode).toBe(0);
		});

		it('runs failing commands and returns failure with output', async () => {
			const scriptPath = join(tempDir, 'fail.sh');
			await writeFile(scriptPath, '#!/bin/bash\necho "test failed" >&2\nexit 1\n', 'utf-8');
			await chmod(scriptPath, 0o755);

			const results = await runVerification({
				commands: [{ name: 'fail-test', command: `bash ${scriptPath}` }],
				cwd: tempDir,
				timeoutMs: 10_000,
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.passed).toBe(false);
			expect(results[0]?.exitCode).toBe(1);
			expect(results[0]?.output).toContain('test failed');
		});

		it('runs multiple commands sequentially', async () => {
			const results = await runVerification({
				commands: [
					{ name: 'first', command: 'echo first' },
					{ name: 'second', command: 'echo second' },
				],
				cwd: tempDir,
				timeoutMs: 10_000,
			});

			expect(results).toHaveLength(2);
			expect(results[0]?.passed).toBe(true);
			expect(results[1]?.passed).toBe(true);
		});

		it('reports command-not-found as failure', async () => {
			const results = await runVerification({
				commands: [{ name: 'nonexistent', command: 'definitely-not-a-real-command-12345' }],
				cwd: tempDir,
				timeoutMs: 10_000,
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.passed).toBe(false);
		});
	});

	describe('allVerificationsPassed', () => {
		it('returns true when all passed', () => {
			expect(
				allVerificationsPassed([
					{ name: 'test', passed: true, exitCode: 0, output: '' },
					{ name: 'lint', passed: true, exitCode: 0, output: '' },
				]),
			).toBe(true);
		});

		it('returns false when any failed', () => {
			expect(
				allVerificationsPassed([
					{ name: 'test', passed: true, exitCode: 0, output: '' },
					{ name: 'lint', passed: false, exitCode: 1, output: 'err' },
				]),
			).toBe(false);
		});
	});

	describe('buildVerificationFailureSummary', () => {
		it('builds summary for failed commands', () => {
			const summary = buildVerificationFailureSummary([
				{ name: 'test', passed: false, exitCode: 1, output: 'FAIL: 3 tests' },
				{ name: 'lint', passed: true, exitCode: 0, output: '' },
				{ name: 'typecheck', passed: false, exitCode: 2, output: 'TS2322: Type error' },
			]);

			expect(summary).toContain('test failed (exit code 1)');
			expect(summary).toContain('FAIL: 3 tests');
			expect(summary).toContain('typecheck failed (exit code 2)');
			expect(summary).not.toContain('lint');
		});

		it('returns all-passed message when none failed', () => {
			expect(
				buildVerificationFailureSummary([{ name: 'test', passed: true, exitCode: 0, output: '' }]),
			).toBe('All verifications passed.');
		});
	});
});
