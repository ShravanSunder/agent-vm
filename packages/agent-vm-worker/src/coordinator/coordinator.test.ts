import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workerConfigSchema, type WorkerConfig } from '../config/worker-config.js';
import type { WorkExecutor } from '../work-executor/executor-interface.js';
import { createCoordinator } from './coordinator.js';

const mocks = vi.hoisted(() => ({
	createWorkExecutor: vi.fn(),
	getDiff: vi.fn(),
	runVerification: vi.fn(),
	allVerificationsPassed: vi.fn(),
	buildVerificationFailureSummary: vi.fn(),
	reviewWork: vi.fn(),
	buildWrapupTools: vi.fn(),
	getWrapupActionConfigs: vi.fn(),
	findMissingRequiredActions: vi.fn(),
	gatherContext: vi.fn(),
}));

vi.mock('../work-executor/executor-factory.js', () => ({
	createWorkExecutor: mocks.createWorkExecutor,
}));
vi.mock('../git/git-operations.js', () => ({
	getDiff: mocks.getDiff,
}));
vi.mock('../work-reviewer/verification-runner.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../work-reviewer/verification-runner.js')>();
	return {
		...original,
		runVerification: mocks.runVerification,
		allVerificationsPassed: mocks.allVerificationsPassed,
		buildVerificationFailureSummary: mocks.buildVerificationFailureSummary,
	};
});
vi.mock('../work-reviewer/work-reviewer.js', () => ({
	reviewWork: mocks.reviewWork,
}));
vi.mock('../wrapup/wrapup-action-registry.js', () => ({
	buildWrapupTools: mocks.buildWrapupTools,
	getWrapupActionConfigs: mocks.getWrapupActionConfigs,
}));
vi.mock('../wrapup/wrapup-types.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../wrapup/wrapup-types.js')>();
	return {
		...original,
		findMissingRequiredActions: mocks.findMissingRequiredActions,
	};
});
vi.mock('../context/gather-context.js', () => ({
	gatherContext: mocks.gatherContext,
}));

function createMockExecutor(overrides?: {
	readonly executeResponse?: string;
	readonly fixResponse?: string;
}): WorkExecutor {
	let threadId: string | null = null;
	return {
		async execute() {
			threadId = threadId ?? 'thread-1';
			return {
				response: overrides?.executeResponse ?? 'ok',
				tokenCount: 10,
				threadId,
			};
		},
		async fix() {
			return {
				response: overrides?.fixResponse ?? 'fixed',
				tokenCount: 5,
				threadId: threadId ?? 'thread-1',
			};
		},
		async resumeOrRebuild() {},
		getThreadId() {
			return threadId;
		},
	};
}

function makeConfig(stateDir: string): WorkerConfig {
	return workerConfigSchema.parse({ stateDir });
}

async function waitForStatus(
	coordinator: ReturnType<typeof createCoordinator>,
	taskId: string,
	expectedStatus: string,
	timeoutMs: number = 5000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (coordinator.getTaskState(taskId)?.status === expectedStatus) {
			return;
		}
		// Polling is intentionally sequential here; each sleep waits for the coordinator loop to advance.
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
		tempDir = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
		stateDir = join(tempDir, 'state');
		await mkdir(stateDir, { recursive: true });

		const planExecutor = createMockExecutor({ executeResponse: 'The implementation plan' });
		const reviewExecutor = createMockExecutor({
			executeResponse: JSON.stringify({ approved: true, comments: [], summary: 'Plan looks good' }),
		});
		const workExecutor = createMockExecutor({ executeResponse: 'Implemented' });
		const wrapupExecutor = createMockExecutor({ executeResponse: 'Wrapup complete' });

		let executorCallCount = 0;
		mocks.createWorkExecutor.mockImplementation(() => {
			executorCallCount += 1;
			if (executorCallCount === 1) return planExecutor;
			if (executorCallCount === 2) return reviewExecutor;
			if (executorCallCount === 3) return workExecutor;
			return wrapupExecutor;
		});

		mocks.gatherContext.mockResolvedValue({
			fileCount: 3,
			summary: 'Repository structure (3 files):\nsrc/index.ts',
			claudeMd: null,
			packageJson: null,
		});
		mocks.getDiff.mockResolvedValue('diff --git');
		mocks.runVerification.mockResolvedValue([
			{ name: 'test', passed: true, exitCode: 0, output: '' },
		]);
		mocks.allVerificationsPassed.mockReturnValue(true);
		mocks.buildVerificationFailureSummary.mockReturnValue('');
		mocks.reviewWork.mockResolvedValue({
			verificationResults: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
			verificationPassed: true,
			review: { approved: true, comments: [], summary: 'Looks good' },
		});
		mocks.buildWrapupTools.mockReturnValue({
			tools: [],
			getResults: () => [],
		});
		mocks.getWrapupActionConfigs.mockReturnValue([]);
		mocks.findMissingRequiredActions.mockReturnValue([]);
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('runs a task through all phases to completion', async () => {
		const coordinator = createCoordinator({ config: makeConfig(stateDir), workspaceDir: tempDir });

		const { taskId } = await coordinator.submitTask({
			taskId: 'test-task-1',
			prompt: 'fix the login bug',
			repo: {
				repoUrl: 'https://github.com/org/repo.git',
				baseBranch: 'main',
				workspacePath: '/workspace',
			},
		});

		await waitForStatus(coordinator, taskId, 'completed');
		const state = coordinator.getTaskState(taskId);
		expect(state?.status).toBe('completed');
		expect(state?.plan).toBe('The implementation plan');
	});

	it('rejects a second task while one is active', async () => {
		const slowExecutor = {
			async execute() {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return { response: 'done', tokenCount: 10, threadId: 't' };
			},
			async fix() {
				return { response: 'fixed', tokenCount: 5, threadId: 't' };
			},
			async resumeOrRebuild() {},
			getThreadId() {
				return 't';
			},
		};
		mocks.createWorkExecutor.mockReturnValue(slowExecutor);

		const coordinator = createCoordinator({ config: makeConfig(stateDir), workspaceDir: tempDir });
		await coordinator.submitTask({ taskId: 'task-a', prompt: 'first task' });

		await expect(
			coordinator.submitTask({ taskId: 'task-b', prompt: 'second task' }),
		).rejects.toThrow('Another task is already active');
	});

	it('uses controller-provided taskId', async () => {
		const coordinator = createCoordinator({ config: makeConfig(stateDir), workspaceDir: tempDir });

		const { taskId } = await coordinator.submitTask({
			taskId: 'controller-provided-id',
			prompt: 'test',
		});

		expect(taskId).toBe('controller-provided-id');
	});

	it('sanitizes error messages with tokens', async () => {
		mocks.createWorkExecutor.mockImplementation(() => ({
			async execute() {
				throw new Error('failed: https://x-access-token:secret@github.com/org/repo');
			},
			async fix() {
				throw new Error('should not reach');
			},
			async resumeOrRebuild() {},
			getThreadId() {
				return null;
			},
		}));

		const coordinator = createCoordinator({ config: makeConfig(stateDir), workspaceDir: tempDir });
		await coordinator.submitTask({ taskId: 'sanitize-test', prompt: 'test' });

		await waitForStatus(coordinator, 'sanitize-test', 'failed');
		const logContents = readFileSync(join(stateDir, 'tasks', 'sanitize-test.jsonl'), 'utf-8');
		expect(logContents).not.toContain('x-access-token:secret');
		expect(logContents).toContain('x-access-token:***');
	});

	it('close-while-running stops the task', async () => {
		const slowExecutor = {
			async execute() {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return { response: 'done', tokenCount: 10, threadId: 't' };
			},
			async fix() {
				return { response: 'fixed', tokenCount: 5, threadId: 't' };
			},
			async resumeOrRebuild() {},
			getThreadId() {
				return 't';
			},
		};
		mocks.createWorkExecutor.mockReturnValue(slowExecutor);

		const coordinator = createCoordinator({ config: makeConfig(stateDir), workspaceDir: tempDir });
		const { taskId } = await coordinator.submitTask({ taskId: 'close-test', prompt: 'slow task' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await coordinator.closeTask(taskId);
		await new Promise((resolve) => setTimeout(resolve, 600));

		expect(coordinator.getTaskState(taskId)?.status).toBe('completed');
		expect(coordinator.getActiveTaskId()).toBeNull();
	});
});
