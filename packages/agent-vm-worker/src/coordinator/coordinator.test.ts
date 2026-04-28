import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workerConfigSchema, type WorkerConfig } from '../config/worker-config.js';
import { replayEvents } from '../state/event-log.js';
import type { WorkExecutor } from '../work-executor/executor-interface.js';
import type { Coordinator } from './coordinator-types.js';
import { createCoordinator } from './coordinator.js';

const mocks = vi.hoisted(() => ({
	createWorkExecutor: vi.fn(),
	getDiff: vi.fn(),
	gatherContext: vi.fn(),
	bootstrapRepoWorktrees: vi.fn(),
}));

vi.mock('../work-executor/executor-factory.js', () => ({
	createWorkExecutor: mocks.createWorkExecutor,
}));
vi.mock('../git/git-operations.js', () => ({
	getDiff: mocks.getDiff,
}));
vi.mock('../context/gather-context.js', () => ({
	gatherContext: mocks.gatherContext,
}));
vi.mock('../git/repo-worktree-bootstrap.js', () => ({
	bootstrapRepoWorktrees: mocks.bootstrapRepoWorktrees,
}));

function makeConfig(stateDir: string, overrides: Record<string, unknown> = {}): WorkerConfig {
	return workerConfigSchema.parse({
		runtimeInstructions: 'runtime facts',
		commonAgentInstructions: null,
		stateDir,
		defaults: { provider: 'codex', model: 'latest-medium' },
		phases: {
			plan: {
				model: 'plan-model',
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			work: {
				model: 'work-model',
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			wrapup: {
				model: 'wrapup-model',
				instructions: null,
				skills: [],
			},
		},
		...overrides,
	});
}

function createMockExecutor(
	responses: readonly string[],
	options?: { readonly neverResolve?: boolean },
): WorkExecutor {
	let index = 0;
	let threadId: string | null = null;
	async function nextResponse(): Promise<{
		readonly response: string;
		readonly tokenCount: number;
		readonly threadId: string;
	}> {
		if (options?.neverResolve) {
			return await new Promise(() => {});
		}
		threadId = threadId ?? `thread-${Math.random().toString(16).slice(2)}`;
		return {
			response: responses[index++] ?? '',
			tokenCount: 10,
			threadId,
		};
	}

	return {
		execute: nextResponse,
		fix: nextResponse,
		async resumeOrRebuild() {},
		getThreadId: () => threadId,
	};
}

function enqueueHappyPathExecutors(): void {
	mocks.createWorkExecutor
		.mockReturnValueOnce(
			createMockExecutor([
				JSON.stringify({ plan: 'plan-v0' }),
				JSON.stringify({ plan: 'plan-v1' }),
			]),
		)
		.mockReturnValueOnce(
			createMockExecutor([JSON.stringify({ approved: false, summary: 'review', comments: [] })]),
		)
		.mockReturnValueOnce(
			createMockExecutor([
				JSON.stringify({ summary: 'work done', commitShas: [], remainingConcerns: '' }),
				JSON.stringify({
					summary: 'work revised',
					commitShas: [],
					remainingConcerns: '',
				}),
			]),
		)
		.mockReturnValueOnce(
			createMockExecutor([
				JSON.stringify({
					approved: true,
					summary: 'work review',
					comments: [],
					validationResults: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
				}),
			]),
		)
		.mockReturnValueOnce(createMockExecutor([JSON.stringify({ summary: 'wrapup' })]));
}

async function readEventNames(stateDir: string, taskId: string): Promise<readonly string[]> {
	const events = await replayEvents(join(stateDir, 'tasks', `${taskId}.jsonl`));
	return events.map((event) => event.data.event);
}

async function waitForStatus(
	coordinator: Coordinator,
	taskId: string,
	expectedStatus: string,
	timeoutMs: number = 5_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (coordinator.getTaskState(taskId)?.status === expectedStatus) {
			return;
		}
		// Polling is intentionally sequential while the background task advances.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`Task ${taskId} did not reach ${expectedStatus}. Last status: ${coordinator.getTaskState(taskId)?.status ?? 'unknown'}`,
	);
}

describe('coordinator', () => {
	let tempDir: string;
	let stateDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'worker-coordinator-test-'));
		stateDir = join(tempDir, 'state');
		vi.clearAllMocks();
		mocks.gatherContext.mockResolvedValue({ summary: 'repo summary' });
		mocks.getDiff.mockResolvedValue('diff --git a/file b/file');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('runs a task through plan, work, and wrapup', async () => {
		enqueueHappyPathExecutors();
		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({
			taskId: 'happy',
			prompt: 'fix the issue',
		});

		await waitForStatus(coordinator, taskId, 'completed');
		expect(await readEventNames(stateDir, taskId)).toEqual([
			'task-accepted',
			'phase-started',
			'plan-agent-turn',
			'plan-reviewer-turn',
			'plan-agent-turn',
			'plan-finalized',
			'phase-completed',
			'phase-started',
			'work-agent-turn',
			'work-reviewer-turn',
			'work-agent-turn',
			'work-agent-turn',
			'phase-completed',
			'phase-started',
			'wrapup-turn',
			'wrapup-result',
			'phase-completed',
			'task-completed',
		]);
		expect(coordinator.getTaskState(taskId)?.plan).toBe('plan-v1');
		expect(coordinator.getTaskState(taskId)?.lastValidationResults).toEqual([
			{ name: 'test', passed: true, exitCode: 0, output: '' },
		]);
	});

	it('rejects a second task while one is active', async () => {
		mocks.createWorkExecutor.mockReturnValue(createMockExecutor([], { neverResolve: true }));
		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workDir: tempDir,
		});

		await coordinator.submitTask({ taskId: 'first', prompt: 'one' });

		await expect(coordinator.submitTask({ taskId: 'second', prompt: 'two' })).rejects.toThrow(
			/Another task is already active/,
		);
	});

	it('sanitizes token-bearing failure messages', async () => {
		mocks.createWorkExecutor.mockReturnValueOnce(createMockExecutor(['not used'], undefined));
		mocks.createWorkExecutor.mockImplementationOnce(() => {
			throw new Error('boom https://x-access-token:secret@github.com/repo.git');
		});
		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({ taskId: 'sanitize', prompt: 'fix' });

		await waitForStatus(coordinator, taskId, 'failed');
		expect(coordinator.getTaskState(taskId)?.failureReason).toContain(
			'https://x-access-token:***@github.com/repo.git',
		);
	});

	it('continues when context gathering fails', async () => {
		enqueueHappyPathExecutors();
		mocks.gatherContext.mockRejectedValue(new Error('work dir not readable'));
		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({ taskId: 'context-failed', prompt: 'fix' });

		await waitForStatus(coordinator, taskId, 'completed');
		expect(coordinator.getTaskState(taskId)?.lastContextError).toBe('work dir not readable');
	});

	it('fails when diff reading fails', async () => {
		enqueueHappyPathExecutors();
		mocks.getDiff.mockRejectedValue(new Error('git diff failed'));
		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({ taskId: 'diff-failed', prompt: 'fix' });

		await waitForStatus(coordinator, taskId, 'failed');
		expect(coordinator.getTaskState(taskId)?.failureReason).toBe('git diff failed');
	});
});
