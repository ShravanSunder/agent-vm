import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
	runVerification: vi.fn(),
	allVerificationsPassed: vi.fn(),
	buildVerificationFailureSummary: vi.fn(),
	reviewWork: vi.fn(),
	buildWrapupTools: vi.fn(),
	getWrapupActionConfigs: vi.fn(),
	findMissingRequiredActions: vi.fn(),
	gatherContext: vi.fn(),
}));

const PLAN_MODEL = 'test-plan-model';
const PLAN_REVIEW_MODEL = 'test-plan-review-model';
const WORK_MODEL = 'test-work-model';
const WORK_REVIEW_MODEL = 'test-work-review-model';
const WRAPUP_MODEL = 'test-wrapup-model';

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function makeConfig(stateDir: string, overrides: Record<string, unknown> = {}): WorkerConfig {
	const phaseDefaults = {
		plan: { model: PLAN_MODEL },
		planReview: { model: PLAN_REVIEW_MODEL },
		work: { model: WORK_MODEL },
		workReview: { model: WORK_REVIEW_MODEL },
		wrapup: { model: WRAPUP_MODEL },
	};
	const overridePhases = (() => {
		if (!isRecord(overrides.phases)) {
			return {};
		}
		return overrides.phases;
	})();
	const getPhaseOverride = (phaseKey: string): Record<string, unknown> => {
		const candidate = overridePhases[phaseKey];
		if (!isRecord(candidate)) {
			return {};
		}
		return candidate;
	};

	const { phases: _ignoredPhases, ...remainingOverrides } = overrides;

	return workerConfigSchema.parse({
		stateDir,
		phases: {
			plan: {
				...phaseDefaults.plan,
				...getPhaseOverride('plan'),
			},
			planReview: {
				...phaseDefaults.planReview,
				...getPhaseOverride('planReview'),
			},
			work: {
				...phaseDefaults.work,
				...getPhaseOverride('work'),
			},
			workReview: {
				...phaseDefaults.workReview,
				...getPhaseOverride('workReview'),
			},
			wrapup: {
				...phaseDefaults.wrapup,
				...getPhaseOverride('wrapup'),
			},
		},
		...remainingOverrides,
	});
}

async function readEventNames(stateDir: string, taskId: string): Promise<readonly string[]> {
	const events = await replayEvents(join(stateDir, 'tasks', `${taskId}.jsonl`));
	return events.map((event) => event.data.event);
}

async function waitForStatus(
	coordinator: Coordinator,
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
	let executorsByModel: Map<string, WorkExecutor>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'coordinator-test-'));
		stateDir = join(tempDir, 'state');
		await mkdir(stateDir, { recursive: true });

		const planExecutor = createMockExecutor({ executeResponse: 'The implementation plan' });
		const reviewExecutor = createMockExecutor({
			executeResponse: JSON.stringify({ approved: true, comments: [], summary: 'Plan looks good' }),
		});
		const workExecutor = createMockExecutor({ executeResponse: 'Implemented' });
		const workReviewExecutor = createMockExecutor({
			executeResponse: JSON.stringify({ approved: true, comments: [], summary: 'Looks good' }),
		});
		const wrapupExecutor = createMockExecutor({ executeResponse: 'Wrapup complete' });
		executorsByModel = new Map([
			[PLAN_MODEL, planExecutor],
			[PLAN_REVIEW_MODEL, reviewExecutor],
			[WORK_MODEL, workExecutor],
			[WORK_REVIEW_MODEL, workReviewExecutor],
			[WRAPUP_MODEL, wrapupExecutor],
		]);
		mocks.createWorkExecutor.mockImplementation((_provider: string, model: string) => {
			const executor = executorsByModel.get(model);
			if (!executor) {
				throw new Error(`No mock executor configured for model ${model}`);
			}
			return executor;
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
		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workspaceDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({
			taskId: 'test-task-1',
			prompt: 'fix the login bug',
			repos: [
				{
					repoUrl: 'https://github.com/org/repo.git',
					baseBranch: 'main',
					workspacePath: '/workspace/repo',
				},
			],
		});

		await waitForStatus(coordinator, taskId, 'completed');
		const state = coordinator.getTaskState(taskId);
		expect(state?.status).toBe('completed');
		expect(state?.plan).toBe('The implementation plan');
		const logContents = readFileSync(join(stateDir, 'tasks', 'test-task-1.jsonl'), 'utf-8');
		expect(logContents).toContain('"phase":"plan"');
		expect(logContents).toContain('"phase":"work"');
		expect(logContents).toContain('"phase":"verification"');
		expect(logContents).toContain('"phase":"wrapup"');
		expect(await readEventNames(stateDir, taskId)).toEqual([
			'task-accepted',
			'phase-started',
			'plan-created',
			'phase-completed',
			'phase-started',
			'review-result',
			'phase-completed',
			'phase-started',
			'work-started',
			'phase-completed',
			'phase-started',
			'verification-result',
			'phase-completed',
			'phase-started',
			'review-result',
			'phase-completed',
			'phase-started',
			'wrapup-result',
			'phase-completed',
			'task-completed',
		]);
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
		executorsByModel = new Map([
			[PLAN_MODEL, slowExecutor],
			[PLAN_REVIEW_MODEL, slowExecutor],
			[WORK_MODEL, slowExecutor],
			[WORK_REVIEW_MODEL, slowExecutor],
			[WRAPUP_MODEL, slowExecutor],
		]);

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workspaceDir: tempDir,
		});
		await coordinator.submitTask({ taskId: 'task-a', prompt: 'first task' });

		await expect(
			coordinator.submitTask({ taskId: 'task-b', prompt: 'second task' }),
		).rejects.toThrow('Another task is already active');
	});

	it('uses controller-provided taskId', async () => {
		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workspaceDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({
			taskId: 'controller-provided-id',
			prompt: 'test',
		});

		expect(taskId).toBe('controller-provided-id');
		await waitForStatus(coordinator, taskId, 'completed');
	});

	it('fails the task when required wrapup actions are missing', async () => {
		mocks.getWrapupActionConfigs.mockReturnValue([
			{ key: 'git-pr:0', type: 'git-pr', required: true },
		]);
		mocks.findMissingRequiredActions.mockReturnValue(['git-pr']);

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workspaceDir: tempDir,
		});
		const { taskId } = await coordinator.submitTask({
			taskId: 'missing-wrapup',
			prompt: 'test required wrapup',
		});

		await waitForStatus(coordinator, taskId, 'failed');
		const state = coordinator.getTaskState(taskId);
		expect(state?.status).toBe('failed');
		const logContents = readFileSync(join(stateDir, 'tasks', 'missing-wrapup.jsonl'), 'utf-8');
		expect(logContents).toContain('Required wrapup actions not completed: git-pr');
		expect(logContents).not.toContain('task-completed');
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

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workspaceDir: tempDir,
		});
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
		executorsByModel = new Map([
			[PLAN_MODEL, slowExecutor],
			[PLAN_REVIEW_MODEL, slowExecutor],
			[WORK_MODEL, slowExecutor],
			[WORK_REVIEW_MODEL, slowExecutor],
			[WRAPUP_MODEL, slowExecutor],
		]);

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workspaceDir: tempDir,
		});
		const { taskId } = await coordinator.submitTask({ taskId: 'close-test', prompt: 'slow task' });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await coordinator.closeTask(taskId);
		await new Promise((resolve) => setTimeout(resolve, 600));

		expect(coordinator.getTaskState(taskId)?.status).toBe('completed');
		expect(coordinator.getActiveTaskId()).toBeNull();
	});

	it('fails when plan review loops are exhausted', async () => {
		const reviewExecutor = createMockExecutor({
			executeResponse: JSON.stringify({
				approved: false,
				comments: [],
				summary: 'Plan needs more detail',
			}),
		});
		executorsByModel = new Map([
			[PLAN_MODEL, createMockExecutor({ executeResponse: 'Initial plan' })],
			[PLAN_REVIEW_MODEL, reviewExecutor],
			[WORK_MODEL, createMockExecutor({ executeResponse: 'unused' })],
			[WORK_REVIEW_MODEL, createMockExecutor({ executeResponse: 'unused' })],
			[WRAPUP_MODEL, createMockExecutor({ executeResponse: 'unused' })],
		]);

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir, {
				phases: {
					plan: { maxReviewLoops: 1 },
				},
			}),
			workspaceDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({
			taskId: 'plan-review-exhausted',
			prompt: 'write a plan',
		});

		await waitForStatus(coordinator, taskId, 'failed');
		const logContents = readFileSync(
			join(stateDir, 'tasks', 'plan-review-exhausted.jsonl'),
			'utf-8',
		);
		expect(logContents).toContain('Plan review loop exhausted');
		expect(logContents).not.toContain('task-completed');
	});

	it('fails when verification retries are exhausted', async () => {
		mocks.runVerification.mockResolvedValue([
			{ name: 'test', passed: false, exitCode: 1, output: 'failed' },
		]);
		mocks.allVerificationsPassed.mockReturnValue(false);
		mocks.buildVerificationFailureSummary.mockReturnValue('tests failed');

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir, {
				phases: {
					work: { maxVerificationRetries: 1 },
				},
			}),
			workspaceDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({
			taskId: 'verification-exhausted',
			prompt: 'fix the failing test',
		});

		await waitForStatus(coordinator, taskId, 'failed');
		const logContents = readFileSync(
			join(stateDir, 'tasks', 'verification-exhausted.jsonl'),
			'utf-8',
		);
		expect(logContents).toContain('Verification failed after 1 attempts');
		expect(logContents).not.toContain('task-completed');
	});

	it('fails when work review loops are exhausted', async () => {
		mocks.reviewWork.mockResolvedValue({
			verificationResults: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
			verificationPassed: true,
			review: {
				approved: false,
				comments: [],
				summary: 'Still missing edge cases',
			},
		});

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir, {
				phases: {
					work: { maxReviewLoops: 1 },
				},
			}),
			workspaceDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({
			taskId: 'work-review-exhausted',
			prompt: 'implement the feature',
		});

		await waitForStatus(coordinator, taskId, 'failed');
		const logContents = readFileSync(
			join(stateDir, 'tasks', 'work-review-exhausted.jsonl'),
			'utf-8',
		);
		expect(logContents).toContain('Work review loop exhausted');
		expect(logContents).not.toContain('task-completed');
	});

	it('continues the task and logs when repo context gathering fails', async () => {
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		mocks.gatherContext.mockRejectedValue(new Error('workspace not readable'));

		const coordinator = await createCoordinator({
			config: makeConfig(stateDir),
			workspaceDir: tempDir,
		});

		const { taskId } = await coordinator.submitTask({
			taskId: 'gather-context-failed',
			prompt: 'fix the issue',
		});

		await waitForStatus(coordinator, taskId, 'completed');
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				`[coordinator] Failed to gather repo context for task ${taskId}: workspace not readable`,
			),
		);
	});
});
