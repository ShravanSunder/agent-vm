import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import { repoLocationSchema } from './shared/repo-location.js';
import { isTerminal } from './state/task-state.js';
import type { TaskState } from './state/task-state.js';

function validationErrorHook(
	result: {
		success: boolean;
		error?: { issues: readonly z.core.$ZodIssue[] };
	},
	context: Context,
): Response | void {
	if (!result.success) {
		return context.json(
			{
				error: 'invalid-request',
				details: result.error?.issues ?? [],
			},
			400,
		);
	}
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

export const createTaskRequestSchema = z.object({
	taskId: z.string().min(1),
	prompt: z.string().min(1),
	repos: z.array(repoLocationSchema).default([]),
	context: z.record(z.string(), z.unknown()).default({}),
});

export interface ServerDeps {
	readonly getActiveTaskId: () => string | null;
	readonly getActiveTaskStatus: () => string | null;
	readonly getTaskState: (taskId: string) => TaskState | undefined;
	readonly submitTask: (
		input: z.infer<typeof createTaskRequestSchema>,
	) => Promise<{ taskId: string; status: 'accepted' }>;
	readonly closeTask: (taskId: string) => Promise<{ status: 'closed' }>;
	readonly getUptime: () => number;
	readonly getExecutorInfo: () => {
		readonly provider: string;
		readonly model: string;
	};
}

export function createApp(deps: ServerDeps): Hono {
	const app = new Hono();

	app.get('/health', (context) =>
		context.json({
			status: 'ok',
			activeTask: deps.getActiveTaskId(),
			activeTaskStatus: deps.getActiveTaskStatus(),
			uptime: deps.getUptime(),
			executor: deps.getExecutorInfo(),
		}),
	);

	app.post(
		'/tasks',
		zValidator('json', createTaskRequestSchema, validationErrorHook),
		async (context) => {
			try {
				if (deps.getActiveTaskId() !== null) {
					return context.json(
						{
							error: 'task-already-active',
							activeTaskId: deps.getActiveTaskId(),
						},
						409,
					);
				}

				const result = await deps.submitTask(context.req.valid('json'));
				return context.json(result, 201);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				writeStderr(`[server] Failed to submit task: ${message}`);
				return context.json({ error: 'task-submission-failed' }, 500);
			}
		},
	);

	app.get('/tasks/:id', (context) => {
		const taskState = deps.getTaskState(context.req.param('id'));
		if (!taskState) {
			return context.json({ error: 'task-not-found' }, 404);
		}
		return context.json(taskState);
	});

	app.post('/tasks/:id/close', async (context) => {
		const taskId = context.req.param('id');
		const taskState = deps.getTaskState(taskId);
		if (!taskState) {
			return context.json({ error: 'task-not-found' }, 404);
		}
		if (isTerminal(taskState)) {
			return context.json({ error: 'task-is-terminal', status: taskState.status }, 410);
		}

		try {
			const result = await deps.closeTask(taskId);
			return context.json(result, 200);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeStderr(`[server] Failed to close task ${taskId}: ${message}`);
			return context.json({ error: 'task-close-failed' }, 500);
		}
	});

	return app;
}
