import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { workerConfigSchema } from './config/worker-config.js';
import { createCoordinator } from './coordinator/coordinator.js';
import { createApp } from './server.js';
import type { WorkExecutor } from './work-executor/executor-interface.js';

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

vi.mock('./work-executor/executor-factory.js', () => ({
	createWorkExecutor: mocks.createWorkExecutor,
}));
vi.mock('./git/git-operations.js', () => ({
	getDiff: mocks.getDiff,
}));
vi.mock('./work-reviewer/verification-runner.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('./work-reviewer/verification-runner.js')>();
	return {
		...original,
		runVerification: mocks.runVerification,
		allVerificationsPassed: mocks.allVerificationsPassed,
		buildVerificationFailureSummary: mocks.buildVerificationFailureSummary,
	};
});
vi.mock('./work-reviewer/work-reviewer.js', () => ({
	reviewWork: mocks.reviewWork,
}));
vi.mock('./wrapup/wrapup-action-registry.js', () => ({
	buildWrapupTools: mocks.buildWrapupTools,
	getWrapupActionConfigs: mocks.getWrapupActionConfigs,
}));
vi.mock('./wrapup/wrapup-types.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('./wrapup/wrapup-types.js')>();
	return {
		...original,
		findMissingRequiredActions: mocks.findMissingRequiredActions,
	};
});
vi.mock('./context/gather-context.js', () => ({
	gatherContext: mocks.gatherContext,
}));

function createMockExecutor(response: string): WorkExecutor {
	let threadId: string | null = null;
	return {
		async execute() {
			threadId = threadId ?? 'thread-1';
			return { response, tokenCount: 10, threadId };
		},
		async fix() {
			return { response, tokenCount: 5, threadId: threadId ?? 'thread-1' };
		},
		async resumeOrRebuild() {},
		getThreadId() {
			return threadId;
		},
	};
}

async function waitForTaskCompletion(
	app: ReturnType<typeof createApp>,
	taskId: string,
): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		// Task polling is intentionally serial so each request observes the latest coordinator state.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const response = await app.request(`/tasks/${taskId}`);
		// Response parsing is coupled to the sequential polling loop above.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const body = (await response.json()) as Record<string, unknown>;
		if (body.status === 'completed' || body.status === 'failed') {
			return body;
		}
		// Polling must remain sequential because task progression happens asynchronously.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Task ${taskId} did not complete in time.`);
}

describe('worker runtime integration', () => {
	let tempDir: string;
	let stateDir: string;
	let workspaceDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'worker-runtime-integration-'));
		stateDir = join(tempDir, 'state');
		workspaceDir = join(tempDir, 'workspace');
		await mkdir(stateDir, { recursive: true });
		await mkdir(workspaceDir, { recursive: true });

		mocks.gatherContext.mockResolvedValue({
			fileCount: 2,
			summary: 'Repository structure (2 files):\nsrc/index.ts',
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

		const planExecutor = createMockExecutor('The implementation plan');
		const reviewExecutor = createMockExecutor(
			JSON.stringify({ approved: true, comments: [], summary: 'Looks good' }),
		);
		const workExecutor = createMockExecutor('Implemented');
		const wrapupExecutor = createMockExecutor('Wrapup complete');
		let callCount = 0;
		mocks.createWorkExecutor.mockImplementation(() => {
			callCount += 1;
			if (callCount === 1) return planExecutor;
			if (callCount === 2) return reviewExecutor;
			if (callCount === 3) return workExecutor;
			return wrapupExecutor;
		});
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('runs a task from HTTP submission through to completed state', async () => {
		const config = workerConfigSchema.parse({ stateDir });
		const coordinator = createCoordinator({ config, workspaceDir });
		const app = createApp({
			getActiveTaskId: () => coordinator.getActiveTaskId(),
			getActiveTaskStatus: () => coordinator.getActiveTaskId(),
			getTaskState: (taskId) => coordinator.getTaskState(taskId),
			submitTask: (input) => coordinator.submitTask(input),
			closeTask: (taskId) => coordinator.closeTask(taskId),
			getUptime: () => 1000,
			getExecutorInfo: () => ({ provider: 'codex', model: 'gpt-5.4-low' }),
		});

		const createResponse = await app.request('/tasks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				taskId: 'integration-task-1',
				prompt: 'fix the login bug',
				context: { ticket: 'INC-1' },
			}),
		});

		expect(createResponse.status).toBe(201);

		const taskState = await waitForTaskCompletion(app, 'integration-task-1');
		expect(taskState.status).toBe('completed');
		expect(taskState.plan).toBe('The implementation plan');
	});
});
