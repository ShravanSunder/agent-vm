import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs, { watch } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveWorkerRuntimeEntrypoint, shouldRunWorkerRuntimeE2e } from './worker-e2e-gates.js';

function hasCommand(command: string): boolean {
	try {
		execFileSync('sh', ['-lc', `command -v ${command} >/dev/null`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

const runWorkerOnlySmoke = shouldRunWorkerRuntimeE2e({
	commandExists: hasCommand,
	env: process.env,
	provider: 'codex',
});

const describeWorkerOnlySmoke = runWorkerOnlySmoke ? describe : describe.skip;

interface WorkerProcessOutput {
	stderr: string;
	stdout: string;
}

function withTimeout<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
	message: string,
): Promise<TValue> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	});
}

function waitForOutputCondition(options: {
	readonly child: ChildProcess;
	readonly describeCondition: string;
	readonly isReady: () => boolean;
	readonly output: WorkerProcessOutput;
	readonly stream: Readable | null;
	readonly timeoutMs: number;
}): Promise<void> {
	if (options.isReady()) {
		return Promise.resolve();
	}
	if (options.child.exitCode !== null) {
		return Promise.reject(
			new Error(
				`${options.describeCondition} failed because the process exited:\n${options.output.stderr}`,
			),
		);
	}
	if (options.stream === null) {
		return Promise.reject(new Error(`${options.describeCondition} failed: stdout is not piped.`));
	}
	const outputStream = options.stream;
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`${options.describeCondition} did not complete within ${String(
						options.timeoutMs,
					)}ms.\nstdout:\n${options.output.stdout}\nstderr:\n${options.output.stderr}`,
				),
			);
		}, options.timeoutMs);
		const cleanup = (): void => {
			clearTimeout(timeout);
			outputStream.off('data', onData);
			options.child.off('exit', onExit);
		};
		const onData = (): void => {
			if (options.isReady()) {
				cleanup();
				resolve();
			}
		};
		const onExit = (): void => {
			cleanup();
			reject(
				new Error(
					`${options.describeCondition} failed because the process exited:\n${options.output.stderr}`,
				),
			);
		};
		outputStream.on('data', onData);
		options.child.once('exit', onExit);
		onData();
	});
}

async function waitForChildExit(
	child: ChildProcess,
	timeoutMs: number,
	describeExit: string,
): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await withTimeout(
		once(child, 'exit').then(() => undefined),
		timeoutMs,
		`${describeExit} did not exit within ${String(timeoutMs)}ms.`,
	);
}

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

async function waitForWorkerReady(options: {
	readonly output: WorkerProcessOutput;
	readonly port: number;
	readonly workerProcess: ChildProcess;
	readonly timeoutMs: number;
}): Promise<void> {
	await waitForOutputCondition({
		child: options.workerProcess,
		describeCondition: 'Worker readiness',
		isReady: () =>
			options.output.stdout.includes(
				`Server listening on http://localhost:${String(options.port)}`,
			),
		output: options.output,
		stream: options.workerProcess.stdout,
		timeoutMs: options.timeoutMs,
	});

	const response = await fetch(`http://127.0.0.1:${String(options.port)}/health`);
	if (!response.ok) {
		throw new Error(
			`Worker reported listening but /health returned HTTP ${String(response.status)}.`,
		);
	}
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

async function readTaskState(
	port: number,
	taskId: string,
): Promise<z.infer<typeof taskStateSchema> | null> {
	const response = await fetch(`http://127.0.0.1:${String(port)}/tasks/${taskId}`);
	if (!response.ok) {
		return null;
	}
	return taskStateSchema.parse(await response.json());
}

async function waitForTaskCompletion(options: {
	readonly port: number;
	readonly stateDir: string;
	readonly taskId: string;
	readonly timeoutMs: number;
}): Promise<z.infer<typeof taskStateSchema>> {
	const tasksDir = path.join(options.stateDir, 'tasks');
	await fs.mkdir(tasksDir, { recursive: true });
	const watcher = watch(tasksDir, { persistent: false });
	const deadlineMs = Date.now() + options.timeoutMs;
	let lastState: z.infer<typeof taskStateSchema> | null = null;
	try {
		while (true) {
			const nextTaskEvent = watcher.next();
			// oxlint-disable-next-line eslint/no-await-in-loop -- each pass reads current state before waiting for the next JSONL append event
			const body = await readTaskState(options.port, options.taskId);
			lastState = body;
			if (body !== null && (body.status === 'completed' || body.status === 'failed')) {
				return body;
			}
			const remainingTimeoutMs = deadlineMs - Date.now();
			if (remainingTimeoutMs <= 0) {
				throw new Error(
					`Task ${options.taskId} did not reach terminal state within ${String(
						options.timeoutMs,
					)}ms. Last state: ${JSON.stringify(lastState)}.`,
				);
			}
			// oxlint-disable-next-line eslint/no-await-in-loop -- task completion is driven by sequential JSONL append events
			const nextResult = await withTimeout(
				nextTaskEvent,
				remainingTimeoutMs,
				`Task ${options.taskId} did not emit state changes within ${String(
					options.timeoutMs,
				)}ms. Last state: ${JSON.stringify(lastState)}.`,
			);
			if (nextResult.done === true) {
				throw new Error(
					`Task state watcher ended before ${options.taskId} reached terminal state.`,
				);
			}
		}
	} finally {
		await watcher.return?.();
	}
}

const createTaskResponseSchema = z.object({
	taskId: z.string().min(1),
	status: z.literal('accepted'),
});

describeWorkerOnlySmoke('smoke: worker package real executor loop', () => {
	let workerProcess: ChildProcess | undefined;

	afterEach(async () => {
		if (workerProcess && workerProcess.exitCode === null) {
			workerProcess.kill('SIGTERM');
			try {
				await waitForChildExit(workerProcess, 5_000, 'Worker SIGTERM shutdown');
			} catch (error) {
				if (workerProcess.exitCode === null) {
					workerProcess.kill('SIGKILL');
					await waitForChildExit(workerProcess, 5_000, 'Worker SIGKILL shutdown');
				}
				throw error;
			}
		}
	});

	it('runs a real task directly against the worker server to completed', async () => {
		const repoRoot = path.resolve(process.cwd());
		const workerEntrypoint = resolveWorkerRuntimeEntrypoint(repoRoot);
		await fs.access(workerEntrypoint);

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
		const workerOutput: WorkerProcessOutput = { stderr: '', stdout: '' };

		await fs.mkdir(stateDir, { recursive: true });
		await fs.mkdir(workDir, { recursive: true });
		await fs.writeFile(
			configPath,
			JSON.stringify({
				runtimeInstructions: 'Smoke test runtime instructions.',
				defaults: { provider: 'codex', model: 'gpt-5.4-mini' },
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

		workerProcess = spawn(
			'node',
			[workerEntrypoint, 'serve', '--port', String(port), '--config', configPath],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					OPENAI_API_KEY: process.env.AGENT_VM_TEST_OPENAI_API_KEY ?? '',
					WORK_DIR: workDir,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		workerProcess.stdout?.setEncoding('utf8');
		workerProcess.stderr?.setEncoding('utf8');
		workerProcess.stdout?.on('data', (chunk: string) => {
			workerOutput.stdout += chunk;
		});
		workerProcess.stderr?.on('data', (chunk: string) => {
			workerOutput.stderr += chunk;
		});

		try {
			await waitForWorkerReady({
				output: workerOutput,
				port,
				timeoutMs: 30_000,
				workerProcess,
			});

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
			const finalState = await waitForTaskCompletion({
				port,
				stateDir,
				taskId: createBody.taskId,
				timeoutMs: 300_000,
			});
			if (finalState.status !== 'completed') {
				throw new Error(`Worker-only smoke failed: ${JSON.stringify(finalState)}`);
			}
			expect((await fs.readFile(path.join(repoDir, 'READY.txt'), 'utf8')).trim()).toBe('READY');
		} catch (error) {
			await fs.writeFile(workerLogPath, workerOutput.stdout + workerOutput.stderr).catch(() => {});
			const workerLog = await fs.readFile(workerLogPath, 'utf8').catch(() => '');
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\n\nWorker log:\n${workerLog}`,
				{ cause: error },
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 900_000);
});
