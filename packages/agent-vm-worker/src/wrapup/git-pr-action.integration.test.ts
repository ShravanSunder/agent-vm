import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createGitPrToolDefinition } from './git-pr-action.js';
import { wrapupToolOutputSchema } from './wrapup-types.js';

const execFileAsync = promisify(execFile);

const ghInvocationSchema = z.object({
	branches: z.array(
		z.object({
			repoUrl: z.string(),
			branchName: z.string(),
			title: z.string(),
			body: z.string(),
		}),
	),
});

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
	return await execFileAsync('git', [...args], { cwd });
}

describe('git-pr-action integration', () => {
	let tempDir: string;
	let repoDir: string;
	let controllerBaseUrl: string;
	let receivedRequestBodyPath: string;
	let server: ReturnType<typeof createServer> | null = null;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(os.tmpdir(), 'git-pr-action-integration-'));
		repoDir = path.join(tempDir, 'repo');
		receivedRequestBodyPath = path.join(tempDir, 'push-request.json');
		await mkdir(repoDir, { recursive: true });

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

		server = createServer((request, response) => {
			void (async (): Promise<void> => {
				if (
					request.method === 'POST' &&
					request.url === '/zones/shravan/tasks/task-123/push-branches'
				) {
					const chunks: Buffer[] = [];
					for await (const chunk of request) {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					}
					await writeFile(receivedRequestBodyPath, Buffer.concat(chunks).toString('utf8'), 'utf8');
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(
						JSON.stringify({
							results: [
								{
									repoUrl: 'https://github.com/acme/widgets.git',
									branchName: 'agent/task-123',
									success: true,
									prUrl: 'https://github.com/acme/widgets/pull/42',
								},
							],
						}),
					);
					return;
				}

				response.writeHead(404);
				response.end();
			})().catch((error: unknown) => {
				response.writeHead(500);
				response.end(String(error));
			});
		});
		await new Promise<void>((resolve) => {
			server?.listen(0, '127.0.0.1', () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === 'string') {
			throw new Error('Expected controller server address.');
		}
		controllerBaseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			server = null;
		}
		await rm(tempDir, { recursive: true, force: true });
	});

	it('creates a real local branch and commit while returning the PR artifact', async () => {
		const tool = createGitPrToolDefinition({
			branchPrefix: 'agent/',
			commitCoAuthor: 'agent <noreply@agent>',
			controllerBaseUrl,
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
			zoneId: 'shravan',
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

		const pushRequest = ghInvocationSchema.parse(
			JSON.parse(await readFile(receivedRequestBodyPath, 'utf8')),
		);
		expect(pushRequest.branches).toEqual([
			{
				repoUrl: 'https://github.com/acme/widgets.git',
				branchName: 'agent/task-123',
				title: 'feat: add feature artifact',
				body: 'Implements the feature artifact test.',
			},
		]);
	});
});
