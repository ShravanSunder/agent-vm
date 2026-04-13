import { describe, expect, it, vi } from 'vitest';

import { workerConfigSchema } from './config/worker-config.js';
import { createApp, type ServerDeps } from './server.js';
import type { TaskState } from './state/task-state.js';

const TEST_EFFECTIVE_CONFIG = workerConfigSchema.parse({});

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
		plannerThreadId: null,
		workThreadId: null,
		planReviewLoop: 0,
		workReviewLoop: 0,
		verificationAttempt: 0,
		lastReviewSummary: null,
		lastVerificationResults: null,
		wrapupResults: null,
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
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.status).toBe('ok');
		expect(body.executor).toBeDefined();
	});

	it('POST /tasks creates a task and returns 201', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ taskId: 'task-1', prompt: 'fix the bug' }),
		});

		expect(response.status).toBe(201);
		const body = (await response.json()) as Record<string, unknown>;
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
						workspacePath: '/workspace/frontend',
					},
					{
						repoUrl: 'https://github.com/org/backend.git',
						baseBranch: 'main',
						workspacePath: '/workspace/backend',
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
		const body = (await response.json()) as Record<string, unknown>;
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
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.error).toBe('invalid-request');
	});

	it('GET /tasks/:id returns task state', async () => {
		const app = createApp(createDeps({ getTaskState: () => makeTaskState({ taskId: 'my-task' }) }));
		const response = await app.request('/tasks/my-task');

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.taskId).toBe('my-task');
	});

	it('GET /tasks/:id returns 404 for unknown task', async () => {
		const app = createApp(createDeps());
		const response = await app.request('/tasks/nonexistent');
		expect(response.status).toBe(404);
	});

	it('POST /tasks/:id/close closes a running task', async () => {
		const app = createApp(createDeps({ getTaskState: () => makeTaskState({ status: 'working' }) }));
		const response = await app.request('/tasks/test-1/close', { method: 'POST' });

		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
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
