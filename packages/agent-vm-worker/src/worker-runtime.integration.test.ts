import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import { workerControlDeliveryPolicyByOperation } from '@agent-vm/worker-control-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { workerConfigSchema } from './config/worker-config.js';
import { createWorkerControlApplicationMessageHandler } from './control-session/worker-control-application-handler.js';
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

function createNeverResolvingExecutor(): {
	readonly executor: WorkExecutor;
	readonly started: Promise<void>;
} {
	const { promise: started, resolve: resolveStarted } = Promise.withResolvers<void>();
	return {
		executor: {
			async execute() {
				resolveStarted();
				return await new Promise<never>(() => {});
			},
			async fix() {
				return await new Promise<never>(() => {});
			},
			async resumeOrRebuild() {},
			getThreadId() {
				return 'thread-never-resolving';
			},
		},
		started,
	};
}

function workerControlCancelEnvelope(): ControlEnvelope {
	return {
		bootId: 'worker-boot-a',
		commandId: '11111111-1111-4111-8111-111111111111',
		connectionId: '22222222-2222-4222-8222-222222222222',
		controllerEpoch: 'controller-epoch-a',
		createdAtMs: 1,
		deliveryPolicy: workerControlDeliveryPolicyByOperation.operation_cancel,
		domain: 'worker_control',
		idempotencyKey: 'operation_cancel:test-task-active',
		kind: 'command',
		messageId: '33333333-3333-4333-8333-333333333333',
		operation: 'operation_cancel',
		peerId: 'worker-zone-a',
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: 1,
		sessionId: '44444444-4444-4444-8444-444444444444',
		zoneId: 'zone-a',
	};
}

const taskStatusBodySchema = z.object({
	status: z.string(),
	plan: z.string().nullable().optional(),
});

async function readTaskState(
	app: ReturnType<typeof createApp>,
	taskId: string,
): Promise<z.infer<typeof taskStatusBodySchema>> {
	const response = await app.request(`/tasks/${taskId}`);
	return taskStatusBodySchema.parse(await response.json());
}

describe('worker runtime integration', () => {
	let tempDir: string;
	let stateDir: string;
	let workDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'worker-runtime-integration-'));
		stateDir = join(tempDir, 'state');
		workDir = join(tempDir, 'work');
		await mkdir(stateDir, { recursive: true });
		await mkdir(workDir, { recursive: true });

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
			runtimeInstructions: 'runtime facts',
			commonAgentInstructions: null,
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
		const coordinator = await createCoordinator({ config, workDir });
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

		await coordinator.waitForTaskStatus('integration-task-1', 'completed', { timeoutMs: 5_000 });
		const taskState = await readTaskState(app, 'integration-task-1');
		expect(taskState.status).toBe('completed');
		expect(taskState.plan).toBe('The implementation plan');
	});

	it('keeps worker_control operation_cancel separate from the HTTP task close path', async () => {
		const neverResolvingExecutor = createNeverResolvingExecutor();
		mocks.createWorkExecutor.mockReturnValue(neverResolvingExecutor.executor);
		const config = workerConfigSchema.parse({
			runtimeInstructions: 'runtime facts',
			commonAgentInstructions: null,
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
		const coordinator = await createCoordinator({ config, workDir });
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
			body: JSON.stringify({
				taskId: 'cancel-boundary-task',
				prompt: 'stay active until HTTP close',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(createResponse.status).toBe(201);
		await neverResolvingExecutor.started;
		expect(coordinator.getActiveTaskId()).toBe('cancel-boundary-task');

		const handler = createWorkerControlApplicationMessageHandler();
		await expect(
			handler.handle({
				envelope: workerControlCancelEnvelope(),
				payload: {
					kind: 'command',
					operation: 'operation_cancel',
					payload: {
						activeOperationId: '55555555-5555-4555-8555-555555555555',
						initiatedBy: 'controller',
						reason: 'operator_cancelled',
					},
				},
			}),
		).resolves.toEqual({
			kind: 'command_result',
			operation: 'operation_cancel',
			payload: {
				activeOperationId: '55555555-5555-4555-8555-555555555555',
				error: {
					errorClass: 'worker_control_cancel_not_supported',
					retryable: false,
					safeMessage: 'worker task cancellation remains on the ingress HTTP task close route',
				},
				responseToMessageId: '33333333-3333-4333-8333-333333333333',
				result: 'rejected',
			},
		});
		expect(coordinator.getActiveTaskId()).toBe('cancel-boundary-task');

		const closeResponse = await app.request('/tasks/cancel-boundary-task/close', {
			method: 'POST',
		});
		expect(closeResponse.status).toBe(200);
		const closedTaskState = taskStatusBodySchema.parse(await closeResponse.json());
		expect(closedTaskState.status).toBe('closed');
		expect(coordinator.getActiveTaskId()).toBe('cancel-boundary-task');
	});
});
