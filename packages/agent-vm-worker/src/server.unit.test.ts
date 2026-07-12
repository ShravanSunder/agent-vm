import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { workerConfigSchema } from './config/worker-config.js';
import { createApp, type ServerDeps } from './server.js';
import type { TaskState } from './state/task-state.js';

const TEST_EFFECTIVE_CONFIG = workerConfigSchema.parse({
	runtimeInstructions: 'runtime facts',
	commonAgentInstructions: null,
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
const genericJsonResponseSchema = z.record(z.string(), z.unknown());

function makeTaskState(overrides?: Partial<TaskState>): TaskState {
	return {
		taskId: 'test-1',
		status: 'pending',
		config: {
			taskId: 'test-1',
			prompt: 'fix bug',
			repos: [],
			context: {},
			effectiveConfig: TEST_EFFECTIVE_CONFIG,
		},
		plan: null,
		lastContextError: null,
		planAgentThreadId: null,
		planReviewerThreadId: null,
		workAgentThreadId: null,
		workReviewerThreadId: null,
		wrapupThreadId: null,
		planReviewCycle: 0,
		workReviewCycle: 0,
		currentCycle: 0,
		currentMaxCycles: 0,
		lastPlanReview: null,
		lastWorkReview: null,
		lastValidationResults: null,
		failureReason: null,
		wrapupResult: null,
		controllerOperations: { gitPushes: [], gitPulls: [] },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function createDeps(overrides?: Partial<ServerDeps>): ServerDeps {
	return {
		getActiveTaskId: () => null,
		getActiveTaskStatus: () => null,
		getTaskState: () => undefined,
		submitTask: vi.fn().mockResolvedValue({ taskId: 'test-1', status: 'accepted' }),
		closeTask: vi.fn().mockResolvedValue({ status: 'closed' }),
		getUptime: () => 1000,
		getExecutorInfo: () => ({ provider: 'codex', model: 'gpt-5.4-low' }),
		...overrides,
	};
}

describe('server', () => {
	it('GET /health returns health status', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/health');
		expect(response.status).toBe(200);
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.status).toBe('ok');
		expect(body.executor).toBeDefined();
	});

	it('GET /__agent-vm/worker-ready returns a private control credential when configured', async () => {
		const issueCredentialForReadyHeaders = vi.fn((_headers: Headers) => ({
			audience: 'worker_control' as const,
			bootId: 'worker-boot-a',
			controllerEpoch: 'controller-epoch-a',
			credentialId: 'credential-a',
			expiresAtMs: 2_000,
			generationId: 'worker-generation-a',
			issuedAtMs: 1_000,
			nonce: 'nonce-nonce-nonce-nonce',
			peerId: 'worker-zone-a',
			protocolVersion: 1 as const,
			zoneId: 'zone-a',
		}));
		const app = createApp(
			createDeps({
				workerControlService: {
					issueCredentialForReadyHeaders,
				},
			}),
		);

		const response = await app.request('/__agent-vm/worker-ready', {
			headers: { 'x-agent-vm-control-ready-request-id': 'request-a' },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(issueCredentialForReadyHeaders).toHaveBeenCalledOnce();
		expect(
			issueCredentialForReadyHeaders.mock.calls[0]?.[0].get('x-agent-vm-control-ready-request-id'),
		).toBe('request-a');
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.audience).toBe('worker_control');
		expect(body.credentialId).toBe('credential-a');
	});

	it('GET /__agent-vm/worker-ready returns 401 when ready proof is unauthorized', async () => {
		const app = createApp(
			createDeps({
				workerControlService: {
					issueCredentialForReadyHeaders: () => {
						throw new Error('worker control ready request is unauthorized');
					},
				},
			}),
		);

		const response = await app.request('/__agent-vm/worker-ready');

		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.error).toBe('worker-control-unauthorized');
	});

	it('GET /__agent-vm/worker-ready rejects any query string before issuing credentials', async () => {
		const issueCredentialForReadyHeaders = vi.fn();
		const app = createApp(
			createDeps({
				workerControlService: {
					issueCredentialForReadyHeaders,
				},
			}),
		);

		const response = await app.request(
			'/__agent-vm/worker-ready?x-agent-vm-control-signature=leak',
			{
				headers: { 'x-agent-vm-control-ready-request-id': 'request-a' },
			},
		);

		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(issueCredentialForReadyHeaders).not.toHaveBeenCalled();
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.error).toBe('worker-control-unauthorized');

		const neutralResponse = await app.request('/__agent-vm/worker-ready?debug=signature-leak', {
			headers: { 'x-agent-vm-control-ready-request-id': 'request-a' },
		});

		expect(neutralResponse.status).toBe(401);
		expect(issueCredentialForReadyHeaders).not.toHaveBeenCalled();
	});

	it('GET /__agent-vm/worker-ready fails closed when worker control is not configured', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/__agent-vm/worker-ready');

		expect(response.status).toBe(503);
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.error).toBe('worker-control-unavailable');
	});

	it('POST /tasks creates a task and returns 201', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ taskId: 'task-1', prompt: 'fix the bug' }),
		});

		expect(response.status).toBe(201);
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.taskId).toBe('test-1');
	});

	it('POST /tasks accepts multiple repos', async () => {
		const submitTask = vi.fn().mockResolvedValue({ taskId: 'test-1', status: 'accepted' });
		const app = createApp(createDeps({ submitTask }));
		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				taskId: 'task-1',
				prompt: 'fix the cross-repo bug',
				repos: [
					{
						repoUrl: 'https://github.com/org/frontend.git',
						baseBranch: 'main',
						gitDirPath: '/gitdirs/frontend.git',
						workPath: '/work/repos/frontend',
					},
					{
						repoUrl: 'https://github.com/org/backend.git',
						baseBranch: 'main',
						gitDirPath: '/gitdirs/backend.git',
						workPath: '/work/repos/backend',
					},
				],
			}),
		});

		expect(response.status).toBe(201);
		expect(submitTask).toHaveBeenCalledWith(
			expect.objectContaining({
				repos: [
					expect.objectContaining({ repoUrl: 'https://github.com/org/frontend.git' }),
					expect.objectContaining({ repoUrl: 'https://github.com/org/backend.git' }),
				],
			}),
		);
	});

	it('POST /tasks returns 409 when task is already active', async () => {
		const app = createApp(createDeps({ getActiveTaskId: () => 'active-task-1' }));
		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ taskId: 'task-2', prompt: 'another task' }),
		});

		expect(response.status).toBe(409);
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.error).toBe('task-already-active');
	});

	it('POST /tasks returns 400 for invalid request body', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(400);
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.error).toBe('invalid-request');
	});

	it('GET /tasks/:id returns task state', async () => {
		const app = createApp(createDeps({ getTaskState: () => makeTaskState({ taskId: 'my-task' }) }));
		const response = await app.request('/tasks/my-task');

		expect(response.status).toBe(200);
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.taskId).toBe('my-task');
	});

	it('GET /tasks/:id returns 404 for unknown task', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/tasks/nonexistent');
		expect(response.status).toBe(404);
	});

	it('POST /tasks/:id/close closes a running task', async () => {
		const app = createApp(
			createDeps({ getTaskState: () => makeTaskState({ status: 'work-agent' }) }),
		);
		const response = await app.request('/tasks/test-1/close', { method: 'POST' });

		expect(response.status).toBe(200);
		const body = genericJsonResponseSchema.parse(await response.json());
		expect(body.status).toBe('closed');
	});

	it('POST /tasks/:id/close returns 404 for unknown task', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/tasks/nonexistent/close', { method: 'POST' });
		expect(response.status).toBe(404);
	});

	it('POST /tasks/:id/close returns 410 for terminal task', async () => {
		const app = createApp(
			createDeps({ getTaskState: () => makeTaskState({ status: 'completed' }) }),
		);
		const response = await app.request('/tasks/test-1/close', { method: 'POST' });
		expect(response.status).toBe(410);
	});
});
