import { describe, expect, it } from 'vitest';

import { createApp, type ServerDeps } from './server.js';
import type { TaskState } from './state/task-state.js';
import { createTaskConfigFixture, createTaskStateFixture } from './tests/support/task-fixtures.js';

function createMockTaskState(overrides?: Partial<TaskState>): TaskState {
	return createTaskStateFixture({
		config: createTaskConfigFixture(),
		...overrides,
	});
}

function createMockDeps(overrides?: Partial<ServerDeps>): ServerDeps {
	return {
		getActiveTaskId: () => null,
		getTaskState: () => undefined,
		submitTask: async () => ({ taskId: 'task-123', status: 'accepted' }),
		submitFollowup: async () => ({ status: 'accepted' }),
		closeTask: async () => ({ status: 'closed' }),
		...overrides,
	};
}

describe('server', () => {
	it('GET /health returns ok', async () => {
		const app = createApp(createMockDeps());
		const response = await app.request('/health');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			status: 'ok',
			activeTask: null,
		});
	});

	it('POST /tasks returns 201 with defaults', async () => {
		let capturedInput: unknown = null;
		const app = createApp(
			createMockDeps({
				submitTask: async (input) => {
					capturedInput = input;
					return { taskId: 'task-123', status: 'accepted' };
				},
			}),
		);

		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				prompt: 'implement feature',
				repoUrl: 'https://github.com/user/repo',
			}),
		});

		expect(response.status).toBe(201);
		expect(capturedInput).toMatchObject({
			prompt: 'implement feature',
			repoUrl: 'https://github.com/user/repo',
			baseBranch: 'main',
			testCommand: 'npm test',
			lintCommand: 'npm run lint',
		});
	});

	it('POST /tasks returns 409 when another task is active', async () => {
		const app = createApp(createMockDeps({ getActiveTaskId: () => 'active-task-123' }));

		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				prompt: 'implement feature',
				repoUrl: 'https://github.com/user/repo',
			}),
		});

		expect(response.status).toBe(409);
	});

	it('POST /tasks returns a generic 500 on internal errors', async () => {
		const app = createApp(
			createMockDeps({
				submitTask: async () => {
					throw new Error('sensitive implementation detail');
				},
			}),
		);

		const response = await app.request('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				prompt: 'implement feature',
				repoUrl: 'https://github.com/user/repo',
			}),
		});

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: 'task-submission-failed',
		});
	});

	it('GET /tasks/:id returns 404 for unknown task', async () => {
		const app = createApp(createMockDeps());
		const response = await app.request('/tasks/unknown-task');

		expect(response.status).toBe(404);
	});

	it('POST /tasks/:id/followup only accepts awaiting-followup', async () => {
		const app = createApp(
			createMockDeps({
				getTaskState: () => createMockTaskState({ status: 'implementing' }),
			}),
		);

		const response = await app.request('/tasks/task-123/followup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'followup' }),
		});

		expect(response.status).toBe(409);
	});

	it('POST /tasks/:id/followup returns 200 when awaiting-followup', async () => {
		const app = createApp(
			createMockDeps({
				getTaskState: () => createMockTaskState({ status: 'awaiting-followup' }),
			}),
		);

		const response = await app.request('/tasks/task-123/followup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'followup' }),
		});

		expect(response.status).toBe(200);
	});

	it('POST /tasks/:id/followup returns a generic 500 on internal errors', async () => {
		const app = createApp(
			createMockDeps({
				getTaskState: () => createMockTaskState({ status: 'awaiting-followup' }),
				submitFollowup: async () => {
					throw new Error('sensitive followup detail');
				},
			}),
		);

		const response = await app.request('/tasks/task-123/followup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: 'followup' }),
		});

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: 'followup-submission-failed',
		});
	});

	it('POST /tasks/:id/close returns 200 for non-terminal tasks', async () => {
		const app = createApp(
			createMockDeps({
				getTaskState: () => createMockTaskState({ status: 'awaiting-followup' }),
			}),
		);

		const response = await app.request('/tasks/task-123/close', {
			method: 'POST',
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: 'closed' });
	});

	it('POST /tasks/:id/close returns a generic 500 on internal errors', async () => {
		const app = createApp(
			createMockDeps({
				getTaskState: () => createMockTaskState({ status: 'awaiting-followup' }),
				closeTask: async () => {
					throw new Error('sensitive close detail');
				},
			}),
		);

		const response = await app.request('/tasks/task-123/close', {
			method: 'POST',
		});

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: 'task-close-failed',
		});
	});
});
