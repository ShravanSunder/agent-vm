import { type Context, type Hono } from 'hono';

import { PushBranchesValidationError } from '../git-push-operations.js';
import type { ControllerRouteOperations } from './controller-http-route-support.js';
import {
	controllerDestroyZoneRequestSchema,
	controllerExecuteCommandRequestSchema,
	controllerPushBranchesRequestSchema,
	controllerWorkerTaskRequestSchema,
} from './controller-request-schemas.js';

async function parseJsonBody(context: Context): Promise<unknown> {
	try {
		return await context.req.json();
	} catch {
		throw new PushBranchesValidationError('Request body must be valid JSON.');
	}
}

function writeControllerRouteLog(message: string): void {
	process.stderr.write(`[controller-zone-operation-routes] ${message}\n`);
}

export function registerControllerZoneOperationRoutes(
	app: Hono,
	operations: ControllerRouteOperations,
): void {
	app.get('/controller-status', async (context) => context.json(await operations.getStatus()));
	app.get('/zones/:zoneId/logs', async (context) =>
		context.json(await operations.getZoneLogs(context.req.param('zoneId'))),
	);
	app.post('/zones/:zoneId/credentials/refresh', async (context) =>
		context.json(await operations.refreshZoneCredentials(context.req.param('zoneId'))),
	);
	app.post('/zones/:zoneId/destroy', async (context) => {
		const parsedPayload = controllerDestroyZoneRequestSchema.safeParse(await context.req.json());
		if (!parsedPayload.success) {
			return context.json(
				{
					error: 'invalid-destroy-request',
					issues: parsedPayload.error.issues,
				},
				400,
			);
		}
		const payload = parsedPayload.data;
		return context.json(
			await operations.destroyZone(context.req.param('zoneId'), payload.purge === true),
		);
	});
	app.post('/zones/:zoneId/upgrade', async (context) =>
		context.json(await operations.upgradeZone(context.req.param('zoneId'))),
	);

	if (operations.runWorkerTask) {
		const runWorkerTask = operations.runWorkerTask;
		app.post('/zones/:zoneId/worker-tasks', async (context) => {
			const parsedPayload = controllerWorkerTaskRequestSchema.safeParse(
				await parseJsonBody(context),
			);
			if (!parsedPayload.success) {
				return context.json(
					{
						error: 'invalid-worker-task-request',
						issues: parsedPayload.error.issues,
					},
					400,
				);
			}
			try {
				const taskInput = parsedPayload.data;
				return context.json(
					await runWorkerTask(context.req.param('zoneId'), {
						prompt: taskInput.prompt,
						repos: taskInput.repos,
						context: taskInput.context,
					}),
				);
			} catch (error) {
				return context.json(
					{
						error: error instanceof Error ? error.message : 'worker-task-failed',
					},
					500,
				);
			}
		});
	}

	if (operations.pushTaskBranches) {
		const pushTaskBranches = operations.pushTaskBranches;
		app.post('/zones/:zoneId/tasks/:taskId/push-branches', async (context) => {
			const parsedPayload = controllerPushBranchesRequestSchema.safeParse(
				await parseJsonBody(context),
			);
			if (!parsedPayload.success) {
				return context.json(
					{
						error: 'invalid-push-branches-request',
						issues: parsedPayload.error.issues,
					},
					400,
				);
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
			const parsedPayload = controllerExecuteCommandRequestSchema.safeParse(
				await parseJsonBody(context),
			);
			if (!parsedPayload.success) {
				return context.json(
					{
						error: 'invalid-execute-command-request',
						issues: parsedPayload.error.issues,
					},
					400,
				);
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
