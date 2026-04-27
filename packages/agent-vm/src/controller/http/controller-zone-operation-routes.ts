import { type Context, type Hono } from 'hono';
import type { z } from 'zod';

import { PullDefaultValidationError } from '../git-pull-default-operations.js';
import { PushBranchesValidationError } from '../git-push-operations.js';
import { buildTaskConfigFromPreparedInput } from '../task-config-builder.js';
import { writeTaskFailureSentinel } from '../task-state-reader.js';
import {
	ControllerRuntimeAtCapacityError,
	ControllerTaskNotReadyError,
	type ControllerRouteOperations,
} from './controller-http-route-support.js';
import {
	controllerDestroyZoneRequestSchema,
	controllerExecuteCommandRequestSchema,
	controllerPullDefaultRequestSchema,
	controllerPushBranchesRequestSchema,
	controllerWorkerTaskRequestSchema,
} from './controller-request-schemas.js';

class JsonBodyParseError extends Error {
	public constructor(cause: unknown) {
		super('Request body must be valid JSON.', { cause });
		this.name = 'JsonBodyParseError';
	}
}

async function parseJsonBody(context: Context): Promise<unknown> {
	try {
		return await context.req.json();
	} catch (error) {
		throw new JsonBodyParseError(error);
	}
}

async function parseJsonBodyWithSchema<TSchema extends z.ZodType>(
	context: Context,
	schema: TSchema,
	invalidRequestError: string,
): Promise<
	| { readonly ok: true; readonly data: z.output<TSchema> }
	| { readonly ok: false; readonly response: Response }
> {
	let body: unknown;
	try {
		body = await parseJsonBody(context);
	} catch (error) {
		if (error instanceof JsonBodyParseError) {
			return {
				ok: false,
				response: context.json(
					{
						error: 'invalid-json-request',
						message: error.message,
					},
					400,
				),
			};
		}
		throw error;
	}
	const parsedPayload = schema.safeParse(body);
	if (!parsedPayload.success) {
		return {
			ok: false,
			response: context.json(
				{
					error: invalidRequestError,
					issues: parsedPayload.error.issues,
				},
				400,
			),
		};
	}
	return { ok: true, data: parsedPayload.data };
}

function writeControllerRouteLog(message: string): void {
	process.stderr.write(`[controller-zone-operation-routes] ${message}\n`);
}

export function registerControllerZoneOperationRoutes(
	app: Hono,
	operations: ControllerRouteOperations,
): void {
	app.get('/controller-status', async (context) => context.json(await operations.getStatus()));
	app.get('/zones/:zoneId/status', async (context) =>
		context.json(await operations.getZoneStatus(context.req.param('zoneId'))),
	);
	app.get('/zones/:zoneId/logs', async (context) =>
		context.json(await operations.getZoneLogs(context.req.param('zoneId'))),
	);
	app.post('/zones/:zoneId/credentials/refresh', async (context) =>
		context.json(await operations.refreshZoneCredentials(context.req.param('zoneId'))),
	);
	app.post('/zones/:zoneId/destroy', async (context) => {
		const parsedPayload = await parseJsonBodyWithSchema(
			context,
			controllerDestroyZoneRequestSchema,
			'invalid-destroy-request',
		);
		if (!parsedPayload.ok) {
			return parsedPayload.response;
		}
		const payload = parsedPayload.data;
		return context.json(
			await operations.destroyZone(context.req.param('zoneId'), payload.purge === true),
		);
	});
	app.post('/zones/:zoneId/upgrade', async (context) =>
		context.json(await operations.upgradeZone(context.req.param('zoneId'))),
	);

	if (operations.prepareWorkerTask && operations.executeWorkerTask) {
		const prepareWorkerTask = operations.prepareWorkerTask;
		const executeWorkerTask = operations.executeWorkerTask;
		app.post('/zones/:zoneId/worker-tasks', async (context) => {
			const parsedPayload = await parseJsonBodyWithSchema(
				context,
				controllerWorkerTaskRequestSchema,
				'invalid-worker-task-request',
			);
			if (!parsedPayload.ok) {
				return parsedPayload.response;
			}
			try {
				const taskInput = parsedPayload.data;
				const prepared = await prepareWorkerTask(context.req.param('zoneId'), taskInput);

				void executeWorkerTask(prepared).catch(async (error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					writeControllerRouteLog(
						`executeWorkerTask failed for task '${prepared.taskId}': ${message}`,
					);
					try {
						await prepared.recordEvent({ event: 'task-failed', reason: message });
					} catch (logError) {
						writeControllerRouteLog(
							`Failed to record task-failed event for '${prepared.taskId}': ${logError instanceof Error ? logError.message : String(logError)}`,
						);
						try {
							await writeTaskFailureSentinel({
								config: buildTaskConfigFromPreparedInput({
									taskId: prepared.taskId,
									input: prepared.input,
									repos: prepared.preStartResult.repos,
									effectiveConfig: prepared.preStartResult.effectiveConfig,
								}),
								reason: message,
								stateDir: prepared.preStartResult.stateDir,
								taskId: prepared.taskId,
							});
						} catch (sentinelError) {
							writeControllerRouteLog(
								`Failed to write task-failed sentinel for '${prepared.taskId}': ${sentinelError instanceof Error ? sentinelError.message : String(sentinelError)}`,
							);
						}
					}
				});

				return context.json({ taskId: prepared.taskId, status: 'accepted' }, 202);
			} catch (error) {
				if (error instanceof ControllerRuntimeAtCapacityError) {
					return context.json(
						{
							status: 'at-capacity',
							error: error.message,
						},
						409,
					);
				}
				return context.json(
					{
						error: error instanceof Error ? error.message : 'worker-task-failed',
					},
					500,
				);
			}
		});
	}

	if (operations.getTaskState) {
		const getTaskState = operations.getTaskState;
		app.get('/zones/:zoneId/tasks/:taskId', async (context) => {
			try {
				const state = await getTaskState(context.req.param('zoneId'), context.req.param('taskId'));
				if (!state) {
					return context.json({ error: 'task-not-found' }, 404);
				}
				return context.json(state);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'get-task-state-failed';
				return context.json({ error: message }, 500);
			}
		});
	}

	if (operations.closeTaskForZone) {
		const closeTaskForZone = operations.closeTaskForZone;
		app.post('/zones/:zoneId/tasks/:taskId/close', async (context) => {
			try {
				return context.json(
					await closeTaskForZone(context.req.param('zoneId'), context.req.param('taskId')),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'close-task-failed';
				if (error instanceof ControllerTaskNotReadyError) {
					return context.json({ status: 'not-ready', error: message }, 409);
				}
				return context.json({ error: message }, 500);
			}
		});
	}

	if (operations.pushTaskBranches) {
		const pushTaskBranches = operations.pushTaskBranches;
		app.post('/zones/:zoneId/tasks/:taskId/push-branches', async (context) => {
			const parsedPayload = await parseJsonBodyWithSchema(
				context,
				controllerPushBranchesRequestSchema,
				'invalid-push-branches-request',
			);
			if (!parsedPayload.ok) {
				return parsedPayload.response;
			}
			try {
				return context.json(
					await pushTaskBranches(
						context.req.param('zoneId'),
						context.req.param('taskId'),
						parsedPayload.data,
					),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'push-branches-failed';
				writeControllerRouteLog(
					`push-branches failed for zone '${context.req.param('zoneId')}' task '${context.req.param('taskId')}': ${message}`,
				);
				return context.json(
					{
						error: message,
					},
					error instanceof PushBranchesValidationError ? 400 : 500,
				);
			}
		});
	}

	if (operations.pullDefaultForTask) {
		const pullDefaultForTask = operations.pullDefaultForTask;
		app.post('/zones/:zoneId/tasks/:taskId/pull-default', async (context) => {
			const parsedPayload = await parseJsonBodyWithSchema(
				context,
				controllerPullDefaultRequestSchema,
				'invalid-pull-default-request',
			);
			if (!parsedPayload.ok) {
				return parsedPayload.response;
			}
			try {
				return context.json(
					await pullDefaultForTask(
						context.req.param('zoneId'),
						context.req.param('taskId'),
						parsedPayload.data,
					),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'pull-default-failed';
				writeControllerRouteLog(
					`pull-default failed for zone '${context.req.param('zoneId')}' task '${context.req.param('taskId')}': ${message}`,
				);
				return context.json(
					{
						error: message,
					},
					error instanceof PullDefaultValidationError ? 400 : 500,
				);
			}
		});
	}

	if (operations.enableSshForZone) {
		const enableSshForZone = operations.enableSshForZone;
		app.post('/zones/:zoneId/enable-ssh', async (context) => {
			try {
				return context.json(await enableSshForZone(context.req.param('zoneId')));
			} catch (error) {
				return context.json(
					{
						error: error instanceof Error ? error.message : 'zone-ssh-enable-failed',
					},
					500,
				);
			}
		});
	}

	if (operations.execInZone) {
		const execInZone = operations.execInZone;
		app.post('/zones/:zoneId/execute-command', async (context) => {
			const parsedPayload = await parseJsonBodyWithSchema(
				context,
				controllerExecuteCommandRequestSchema,
				'invalid-execute-command-request',
			);
			if (!parsedPayload.ok) {
				return parsedPayload.response;
			}
			const payload = parsedPayload.data;
			try {
				return context.json(await execInZone(context.req.param('zoneId'), payload.command));
			} catch (error) {
				return context.json(
					{
						error: error instanceof Error ? error.message : 'zone-command-execution-failed',
					},
					500,
				);
			}
		});
	}

	if (operations.stopController) {
		const stopController = operations.stopController;
		app.post('/stop-controller', async (context) => context.json(await stopController()));
	}
}
