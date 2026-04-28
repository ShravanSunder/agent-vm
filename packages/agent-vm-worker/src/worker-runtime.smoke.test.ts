/* oxlint-disable eslint/no-await-in-loop -- smoke polling must be sequential against a live worker */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

function hasCommand(command: string): boolean {
	try {
		execFileSync('sh', ['-lc', `command -v ${command} >/dev/null`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

const runWorkerOnlySmoke =
	typeof process.env.OPEN_AI_TEST_KEY === 'string' &&
	process.env.OPEN_AI_TEST_KEY.length > 0 &&
	hasCommand('codex');

const describeWorkerOnlySmoke = runWorkerOnlySmoke ? describe : describe.skip;

async function findAvailablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to determine an available port.')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function waitForWorkerReady(port: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			if (response.ok) {
				return;
			}
		} catch {
			// The worker process may still be starting up; retry until the timeout window is exhausted.
		}
		// Worker boot polling is intentionally sequential.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error('Worker did not become ready in time.');
}

async function createSampleRepo(baseDir: string): Promise<string> {
	const repoDir = path.join(baseDir, 'sample-repo');
	await fs.mkdir(path.join(repoDir, 'scripts'), { recursive: true });
	await fs.writeFile(
		path.join(repoDir, 'package.json'),
		JSON.stringify({ name: 'worker-only-smoke' }),
	);
	await fs.writeFile(
		path.join(repoDir, 'scripts', 'verify.sh'),
		'#!/usr/bin/env bash\nset -euo pipefail\ntest -f READY.txt\ngrep -q "^READY$" READY.txt\n',
		{ mode: 0o755 },
	);
	execFileSync('git', ['init', '--initial-branch=main'], {
		cwd: repoDir,
		stdio: 'pipe',
	});
	execFileSync('git', ['config', 'user.email', 'smoke@example.com'], {
		cwd: repoDir,
		stdio: 'pipe',
	});
	execFileSync('git', ['config', 'user.name', 'smoke-test'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
	execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], {
		cwd: repoDir,
		stdio: 'pipe',
	});
	return repoDir;
}

const taskStateSchema = z.object({
	status: z.string(),
	failureReason: z.string().nullable().optional(),
});

async function waitForTaskCompletion(
	port: number,
	taskId: string,
): Promise<z.infer<typeof taskStateSchema>> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const response = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}`);
		if (response.ok) {
			const body = taskStateSchema.parse(await response.json());
			if (body.status === 'completed' || body.status === 'failed') {
				return body;
			}
		}
		// Task polling is intentionally sequential.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	throw new Error(`Task ${taskId} did not reach a terminal state in time.`);
}

const createTaskResponseSchema = z.object({
	taskId: z.string().min(1),
	status: z.literal('accepted'),
});

describeWorkerOnlySmoke('smoke: worker package real executor loop', () => {
	let workerProcess: ChildProcess | undefined;

	afterEach(async () => {
		if (workerProcess && !workerProcess.killed) {
			workerProcess.kill('SIGTERM');
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	});

	it('runs a real task directly against the worker server to completed', async () => {
		const repoRoot = path.resolve(process.cwd());
		execFileSync('pnpm', ['--filter', 'agent-vm-worker', 'build'], {
			cwd: repoRoot,
			stdio: 'inherit',
		});

		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-runtime-smoke-'));
		const stateDir = path.join(tempRoot, 'state');
		const workDir = path.join(tempRoot, 'work');
		const sourceRepoDir = await createSampleRepo(path.join(tempRoot, 'source'));
		const repoDir = path.join(workDir, 'sample-repo');
		const gitDirPath = path.join(tempRoot, 'gitdirs', 'sample-repo.git');
		await fs.mkdir(path.dirname(gitDirPath), { recursive: true });
		execFileSync('git', ['clone', '--bare', sourceRepoDir, gitDirPath], {
			stdio: 'pipe',
		});
		execFileSync('git', ['--git-dir', gitDirPath, 'config', 'core.bare', 'false'], {
			stdio: 'pipe',
		});
		const configPath = path.join(tempRoot, 'worker-config.json');
		const port = await findAvailablePort();
		const workerLogPath = path.join(tempRoot, 'worker.log');

		await fs.mkdir(stateDir, { recursive: true });
		await fs.mkdir(workDir, { recursive: true });
		await fs.writeFile(
			configPath,
			JSON.stringify({
				runtimeInstructions: 'Smoke test runtime instructions.',
				defaults: { provider: 'codex', model: 'gpt-5.4' },
				phases: {
					plan: {
						skills: [],
						cycle: { kind: 'noReview' },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					work: {
						skills: [],
						cycle: { kind: 'review', cycleCount: 1 },
						agentInstructions: null,
						reviewerInstructions: null,
					},
					wrapup: { skills: [], instructions: null },
				},
				mcpServers: [],
				verification: [{ name: 'verify', command: 'bash scripts/verify.sh' }],
				branchPrefix: 'agent/',
				stateDir,
			}),
		);

		const workerLogHandle = await fs.open(workerLogPath, 'a');
		workerProcess = spawn(
			'node',
			[
				path.join(repoRoot, 'packages', 'agent-vm-worker', 'dist', 'main.js'),
				'serve',
				'--port',
				String(port),
				'--config',
				configPath,
			],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					OPENAI_API_KEY: process.env.OPEN_AI_TEST_KEY ?? '',
					WORK_DIR: workDir,
				},
				stdio: ['ignore', workerLogHandle.fd, workerLogHandle.fd],
			},
		);

		try {
			await waitForWorkerReady(port);

			const createResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					taskId: 'worker-only-smoke',
					prompt: 'Create a file named READY.txt in the repository root containing exactly READY.',
					repos: [
						{
							repoUrl: 'https://example.com/local-fixture.git',
							baseBranch: 'main',
							gitDirPath,
							workPath: repoDir,
						},
					],
					context: { source: 'worker-only-smoke' },
				}),
			});

			expect(createResponse.status).toBe(201);
			const createBody = createTaskResponseSchema.parse(await createResponse.json());
			const finalState = await waitForTaskCompletion(port, createBody.taskId);
			if (finalState.status !== 'completed') {
				throw new Error(`Worker-only smoke failed: ${JSON.stringify(finalState)}`);
			}
			expect((await fs.readFile(path.join(repoDir, 'READY.txt'), 'utf8')).trim()).toBe('READY');
		} catch (error) {
			const workerLog = await fs.readFile(workerLogPath, 'utf8').catch(() => '');
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n\nWorker log:\n${workerLog}`,
				{ cause: error },
			);
		} finally {
			await workerLogHandle.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 900_000);
});
