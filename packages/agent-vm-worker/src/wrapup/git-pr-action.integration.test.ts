import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createGitPrToolDefinition } from './git-pr-action.js';
import { wrapupToolOutputSchema } from './wrapup-types.js';

const execFileAsync = promisify(execFile);

const ghInvocationSchema = z.object({
	args: z.array(z.string()),
	cwd: z.string(),
});

async function writeExecutable(filePath: string, contents: string): Promise<void> {
	await writeFile(filePath, contents, { encoding: 'utf8', mode: 0o755 });
}

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
	return await execFileAsync('git', [...args], { cwd });
}

describe('git-pr-action integration', () => {
	let tempDir: string;
	let repoDir: string;
	let helperBinDir: string;
	let originalPath: string | undefined;
	let originalGithubToken: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'git-pr-action-integration-'));
		repoDir = path.join(tempDir, 'repo');
		helperBinDir = path.join(tempDir, 'bin');
		await mkdir(repoDir, { recursive: true });
		await mkdir(helperBinDir, { recursive: true });

		execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
		execFileSync('git', ['config', 'user.email', 'integration@example.com'], {
			cwd: repoDir,
			stdio: 'pipe',
		});
		execFileSync('git', ['config', 'user.name', 'integration-test'], {
			cwd: repoDir,
			stdio: 'pipe',
		});
		execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
			cwd: repoDir,
			stdio: 'pipe',
		});
		await writeFile(path.join(repoDir, 'README.md'), 'initial\n', 'utf8');
		execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'pipe' });
		execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], {
			cwd: repoDir,
			stdio: 'pipe',
		});
		await writeFile(path.join(repoDir, 'feature.txt'), 'done\n', 'utf8');

		const pushLogPath = path.join(tempDir, 'push-log.txt');
		const ghLogPath = path.join(tempDir, 'gh-log.json');
		const realGitPath = execFileSync('sh', ['-lc', 'command -v git'], {
			encoding: 'utf8',
			stdio: 'pipe',
		}).trim();

		await writeExecutable(
			path.join(helperBinDir, 'git'),
			`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "push" ]]; then
  printf '%s\\n' "$*" >> "${pushLogPath}"
  exit 0
fi
exec "${realGitPath}" "$@"
`,
		);
		await writeExecutable(
			path.join(helperBinDir, 'gh'),
			`#!/usr/bin/env bash
set -euo pipefail
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}))' "${ghLogPath}" "$@"
printf '%s\\n' "https://github.com/acme/widgets/pull/42"
`,
		);

		originalPath = process.env.PATH;
		originalGithubToken = process.env.GITHUB_TOKEN;
		process.env.PATH = `${helperBinDir}:${originalPath ?? ''}`;
		process.env.GITHUB_TOKEN = 'integration-token';
	});

	afterEach(async () => {
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		if (originalGithubToken === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = originalGithubToken;
		}
		await rm(tempDir, { recursive: true, force: true });
	});

	it('creates a real local branch and commit while returning the PR artifact', async () => {
		const tool = createGitPrToolDefinition({
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent <noreply@agent>',
			taskId: 'task-123',
			taskPrompt: 'Add feature',
			plan: 'Implement feature.txt',
			repos: [
				{
					repoUrl: 'https://github.com/acme/widgets.git',
					baseBranch: 'main',
					workspacePath: repoDir,
				},
			],
		});

		const result = wrapupToolOutputSchema.parse(
			await tool.execute({
				title: 'feat: add feature artifact',
				body: 'Implements the feature artifact test.',
			}),
		);

		expect(result).toEqual({
			type: 'git-pr',
			success: true,
			artifact: 'https://github.com/acme/widgets/pull/42',
		});

		const currentBranch = (await runGit(repoDir, ['branch', '--show-current'])).stdout.trim();
		expect(currentBranch).toBe('agent/task-123');

		const latestCommitTitle = (await runGit(repoDir, ['log', '-1', '--pretty=%s'])).stdout.trim();
		expect(latestCommitTitle).toBe('feat: add feature artifact');

		const commitBody = (await runGit(repoDir, ['log', '-1', '--pretty=%B'])).stdout;
		expect(commitBody).toContain('Co-Authored-By: agent <noreply@agent>');

		const pushLog = await readFile(path.join(tempDir, 'push-log.txt'), 'utf8');
		expect(pushLog).toContain(
			'push https://x-access-token:integration-token@github.com/acme/widgets.git agent/task-123',
		);

		const ghInvocation = ghInvocationSchema.parse(
			JSON.parse(await readFile(path.join(tempDir, 'gh-log.json'), 'utf8')),
		);
		expect(await realpath(ghInvocation.cwd)).toBe(await realpath(repoDir));
		expect(ghInvocation.args).toEqual([
			'pr',
			'create',
			'--repo',
			'acme/widgets',
			'--title',
			'feat: add feature artifact',
			'--body',
			'Implements the feature artifact test.',
			'--base',
			'main',
			'--head',
			'agent/task-123',
		]);
	});
});
