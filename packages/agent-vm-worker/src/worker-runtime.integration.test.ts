import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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
	gatherContext: vi.fn(),
}));

vi.mock('./work-executor/executor-factory.js', () => ({
	createWorkExecutor: mocks.createWorkExecutor,
}));
vi.mock('./git/git-operations.js', () => ({
	getDiff: mocks.getDiff,
}));
vi.mock('./validation-runner/verification-runner.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('./validation-runner/verification-runner.js')>();
	return {
		...original,
		runVerification: mocks.runVerification,
		allVerificationsPassed: mocks.allVerificationsPassed,
		buildVerificationFailureSummary: mocks.buildVerificationFailureSummary,
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

const taskStatusBodySchema = z.object({
	status: z.string(),
	plan: z.string().nullable().optional(),
});

async function waitForTaskCompletion(
	app: ReturnType<typeof createApp>,
	taskId: string,
): Promise<z.infer<typeof taskStatusBodySchema>> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		// Task polling is intentionally serial so each request observes the latest coordinator state.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const response = await app.request(`/tasks/${taskId}`);
		// Response parsing is coupled to the sequential polling loop above.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const body = taskStatusBodySchema.parse(await response.json());
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
		const planExecutor = createMockExecutor(JSON.stringify({ plan: 'The implementation plan' }));
		const planReviewExecutor = createMockExecutor(
			JSON.stringify({ approved: true, summary: 'Looks good', comments: [] }),
		);
		const workExecutor = createMockExecutor(
			JSON.stringify({ summary: 'Implemented', commitShas: [], remainingConcerns: '' }),
		);
		const workReviewExecutor = createMockExecutor(
			JSON.stringify({
				approved: true,
				summary: 'Looks good',
				comments: [],
				validationResults: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
			}),
		);
		const wrapupExecutor = createMockExecutor(
			JSON.stringify({
				summary: 'Wrapup complete',
				prUrl: null,
				branchName: null,
				pushedCommits: [],
			}),
		);
		let callCount = 0;
		mocks.createWorkExecutor.mockImplementation(() => {
			callCount += 1;
			if (callCount === 1) return planExecutor;
			if (callCount === 2) return planReviewExecutor;
			if (callCount === 3) return workExecutor;
			if (callCount === 4) return workReviewExecutor;
			return wrapupExecutor;
		});
	});

	afterEach(async () => {
		vi.clearAllMocks();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('runs a task from HTTP submission through to completed state', async () => {
		const config = workerConfigSchema.parse({
			stateDir,
			phases: {
				plan: {
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: null,
					reviewerInstructions: null,
					skills: [],
				},
				work: {
					cycle: { kind: 'review', cycleCount: 1 },
					agentInstructions: null,
					reviewerInstructions: null,
					skills: [],
				},
				wrapup: { instructions: null, skills: [] },
			},
		});
		const coordinator = await createCoordinator({ config, workspaceDir });
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
