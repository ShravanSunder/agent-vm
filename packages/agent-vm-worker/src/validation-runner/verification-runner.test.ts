import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

		it('writes raw logs with headers for passing commands', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-'));

			const results = await runVerification({
				commands: [{ name: 'echo-ok', command: 'echo hello-world' }],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-1',
			});

			const logPath = results[0]?.logPath;
			expect(logPath).toBeDefined();
			const contents = await readFile(logPath ?? '', 'utf-8');
			expect(contents).toMatch(/^# verification log$/m);
			expect(contents).toMatch(/^# name:\s+echo-ok$/m);
			expect(contents).toMatch(/^# command:\s+echo hello-world$/m);
			expect(contents).toMatch(/^# attempt:\s+verify-1$/m);
			expect(contents).toMatch(/^# exitCode:\s+0$/m);
			expect(contents).toMatch(/^# status:\s+passed$/m);
			expect(contents).toContain('hello-world');
			await rm(logDir, { recursive: true, force: true });
		});

		it('persists full raw output while keeping failure summaries capped', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-'));
			const payloadChars = 8_000;

			const results = await runVerification({
				commands: [
					{
						name: 'big-fail',
						command: `node -e "process.stdout.write('x'.repeat(${String(payloadChars)})); process.exit(2)"`,
					},
				],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-1',
			});

			const result = results[0];
			expect(result?.passed).toBe(false);
			expect(result?.output.length).toBeLessThanOrEqual(4096);
			const contents = await readFile(result?.logPath ?? '', 'utf-8');
			expect(contents).toMatch(/^# status:\s+failed$/m);
			const rawPayload = contents.split('# ---\n')[1] ?? '';
			expect((rawPayload.match(/x/g) ?? []).length).toBe(payloadChars);
			await rm(logDir, { recursive: true, force: true });
		});

		it('caps timeout summaries while keeping full timeout raw logs', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-timeout-'));
			const payloadChars = 8_000;

			const results = await runVerification({
				commands: [
					{
						name: 'big-timeout',
						command: `node -e "process.stdout.write('x'.repeat(${String(payloadChars)})); setTimeout(() => {}, 30_000)"`,
					},
				],
				cwd: tempDir,
				timeoutMs: 100,
				rawLogDir: logDir,
				attemptLabel: 'verify-1',
			});

			const result = results[0];
			expect(result?.passed).toBe(false);
			expect(result?.exitCode).toBe(-1);
			expect(result?.output.length).toBeLessThanOrEqual(4096);
			const contents = await readFile(result?.logPath ?? '', 'utf-8');
			expect(contents).toMatch(/^# status:\s+timeout$/m);
			const rawPayload = contents.split('# ---\n')[1] ?? '';
			expect((rawPayload.match(/x/g) ?? []).length).toBe(payloadChars);
			await rm(logDir, { recursive: true, force: true });
		});

		it('omits logPath when rawLogDir is not set', async () => {
			const results = await runVerification({
				commands: [{ name: 'echo-ok', command: 'echo hi' }],
				cwd: tempDir,
				timeoutMs: 10_000,
			});

			expect(results[0]?.logPath).toBeUndefined();
		});

		it('uses attempt label and sanitized command names for log filenames', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-'));

			const results = await runVerification({
				commands: [{ name: 'npm test / unit', command: 'echo ok' }],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-3',
			});

			expect(results[0]?.logPath).toContain('verify-3-npm_test___unit.log');
			await rm(logDir, { recursive: true, force: true });
		});

		it('does not overwrite logs from different attempts', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-'));

			await runVerification({
				commands: [{ name: 'test', command: 'echo attempt-1' }],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-1',
			});
			await runVerification({
				commands: [{ name: 'test', command: 'echo attempt-2' }],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-2',
			});

			expect((await readdir(logDir)).toSorted()).toEqual([
				'verify-1-test.log',
				'verify-2-test.log',
			]);
			await expect(readFile(join(logDir, 'verify-1-test.log'), 'utf-8')).resolves.toContain(
				'attempt-1',
			);
			await expect(readFile(join(logDir, 'verify-2-test.log'), 'utf-8')).resolves.toContain(
				'attempt-2',
			);
			await rm(logDir, { recursive: true, force: true });
		});

		it('captures stdout and stderr in raw logs', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-'));

			const results = await runVerification({
				commands: [
					{
						name: 'mixed',
						command: `node -e "console.log('OUT-LINE'); console.error('ERR-LINE'); process.exit(1)"`,
					},
				],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-1',
			});

			const contents = await readFile(results[0]?.logPath ?? '', 'utf-8');
			expect(contents).toContain('OUT-LINE');
			expect(contents).toContain('ERR-LINE');
			await rm(logDir, { recursive: true, force: true });
		});

		it('creates rawLogDir when missing', async () => {
			const parentDir = await mkdtemp(join(tmpdir(), 'verify-logs-parent-'));
			const logDir = join(parentDir, 'nested', 'logs');

			const results = await runVerification({
				commands: [{ name: 'mk', command: 'echo created' }],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-1',
			});

			await expect(stat(results[0]?.logPath ?? '')).resolves.toMatchObject({
				isFile: expect.any(Function),
			});
			await rm(parentDir, { recursive: true, force: true });
		});

		it('continues verification when raw log write fails', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-ro-'));
			await chmod(logDir, 0o555);

			const results = await runVerification({
				commands: [{ name: 'cmd', command: 'echo still-runs' }],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-1',
			});

			expect(results[0]?.passed).toBe(true);
			expect(results[0]?.logPath).toBeUndefined();
			await chmod(logDir, 0o755);
			await rm(logDir, { recursive: true, force: true });
		});

		it('captures validation stdout verbatim in raw logs', async () => {
			const logDir = await mkdtemp(join(tmpdir(), 'verify-logs-'));
			const marker = 'ghs_test_secret_abc123';

			const results = await runVerification({
				commands: [{ name: 'echo', command: `node -e "console.log('${marker}')"` }],
				cwd: tempDir,
				timeoutMs: 10_000,
				rawLogDir: logDir,
				attemptLabel: 'verify-redaction-contract',
			});

			const logPath = results[0]?.logPath;
			expect(logPath).toBeDefined();
			await expect(readFile(logPath ?? '', 'utf-8')).resolves.toContain(marker);
			await rm(logDir, { recursive: true, force: true });
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
