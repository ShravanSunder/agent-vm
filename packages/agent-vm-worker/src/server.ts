import { zValidator } from '@hono/zod-validator';
import { getLogger } from '@logtape/logtape';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';

import {
	WORKER_CONTROL_READY_PATH,
	type WorkerControlService,
} from './control-session/worker-control-service.js';
import { toSafeWorkerLogProperties } from './shared/process-logging.js';
import { repoLocationSchema } from './shared/repo-location.js';
import { isTerminal } from './state/task-state.js';
import type { TaskState } from './state/task-state.js';

const serverLogger = getLogger(['agent-vm', 'worker', 'server']);

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
	readonly workerControlService?:
		| Pick<WorkerControlService, 'issueCredentialForReadyHeaders'>
		| undefined;
}

function requestUrlHasQueryParameters(url: string): boolean {
	const parsedUrl = new URL(url, 'http://worker.local');
	return [...parsedUrl.searchParams.keys()].length > 0;
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

	app.get(WORKER_CONTROL_READY_PATH, (context) => {
		const service = deps.workerControlService;
		if (service === undefined) {
			context.header('cache-control', 'no-store');
			return context.json({ error: 'worker-control-unavailable' }, 503);
		}
		try {
			context.header('cache-control', 'no-store');
			if (requestUrlHasQueryParameters(context.req.url)) {
				return context.json({ error: 'worker-control-unauthorized' }, 401);
			}
			return context.json(service.issueCredentialForReadyHeaders(context.req.raw.headers));
		} catch (error) {
			context.header('cache-control', 'no-store');
			if (error instanceof Error && /unauthorized/u.test(error.message)) {
				return context.json({ error: 'worker-control-unauthorized' }, 401);
			}
			return context.json(
				{
					error: 'worker-control-credential-unavailable',
					message: error instanceof Error ? error.message : 'credential unavailable',
				},
				429,
			);
		}
	});

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
				serverLogger.error(
					'Worker task submission failed.',
					toSafeWorkerLogProperties({
						event: 'task-submission-failed',
						failureClass: 'request-failed',
						error,
					}),
				);
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
			serverLogger.error(
				'Worker task close failed.',
				toSafeWorkerLogProperties({
					event: 'task-close-failed',
					failureClass: 'request-failed',
					error,
				}),
			);
			return context.json({ error: 'task-close-failed' }, 500);
		}
	});

	return app;
}
