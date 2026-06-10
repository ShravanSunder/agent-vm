import { type Context, type Hono } from 'hono';
import type { z } from 'zod';

import { scrubGithubTokenFromOutput } from '../git-auth-support.js';
import { PullDefaultValidationError } from '../git-pull-default-operations.js';
import { PushBranchesValidationError } from '../git-push-operations.js';
import type { HealthEventStore } from '../health/health-event-store.js';
import { buildTaskConfigFromPreparedInput } from '../task-config-builder.js';
import { writeTaskFailureSentinel } from '../task-state-reader.js';
import { ZONE_GIT_CAPABILITY_HEADER } from '../zone-git/zone-git-capability-store.js';
import { ZoneGitConflictError } from '../zone-git/zone-git-operations.js';
import {
	ControllerZoneAdminAuthError,
	ControllerZoneConfigurationError,
	ControllerZoneNotFoundError,
	ControllerZoneOperationUnsupportedError,
	ControllerZoneTaskNotFoundError,
	ControllerZoneTaskNotReadyError,
	ControllerZoneWorkerCloseAggregateError,
	ControllerZoneWorkerCloseError,
	ControllerZoneRuntimeStartError,
	ControllerZoneRuntimeUnavailableError,
} from '../zone-runtimes/zone-runtime-errors.js';
import {
	ControllerRuntimeAtCapacityError,
	ControllerTaskNotReadyError,
	type ControllerRuntimeReadiness,
	type ControllerRouteOperations,
	type ExecInZoneOptions,
} from './controller-http-route-support.js';
import {
	controllerDestroyZoneRequestSchema,
	controllerEnableSshRequestSchema,
	controllerExecuteCommandRequestSchema,
	controllerPullDefaultRequestSchema,
	controllerPushBranchesRequestSchema,
	controllerWorkerTaskRequestSchema,
	controllerZoneGitPushRequestSchema,
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

function errorMessage(error: unknown, fallbackError: string): string {
	return error instanceof Error ? error.message : fallbackError;
}

function errorDetails(error: unknown): readonly string[] | undefined {
	if (!(error instanceof AggregateError)) {
		return undefined;
	}
	const details = collectErrorDetailMessages(error, new Set<unknown>());
	return details.length > 0 ? details : undefined;
}

function formatNonErrorDetail(error: unknown): string {
	if (typeof error === 'string') {
		return error;
	}
	if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
		return error.toString();
	}
	if (typeof error === 'symbol') {
		return error.description ?? 'Symbol';
	}
	if (error === null) {
		return 'null';
	}
	try {
		return JSON.stringify(error) ?? 'undefined';
	} catch {
		return 'unserializable non-error value';
	}
}

function collectErrorDetailMessages(error: unknown, seen: Set<unknown>): readonly string[] {
	if (seen.has(error)) {
		return [];
	}
	seen.add(error);

	if (error instanceof AggregateError) {
		const childMessages = error.errors.flatMap((innerError: unknown) =>
			collectErrorDetailMessages(innerError, seen),
		);
		const causeMessages = collectErrorDetailMessages(error.cause, seen);
		return [error.message, ...childMessages, ...causeMessages];
	}
	if (error instanceof Error) {
		const causeMessages = collectErrorDetailMessages(error.cause, seen);
		return causeMessages.length > 0 ? [error.message, ...causeMessages] : [error.message];
	}
	if (error === undefined) {
		return [];
	}
	return [formatNonErrorDetail(error)];
}

function buildErrorResponseBody(
	error: unknown,
	fallbackError: string,
): { readonly details?: readonly string[]; readonly error: string } {
	const details = errorDetails(error);
	return {
		error: errorMessage(error, fallbackError),
		...(details ? { details } : {}),
	};
}

function scrubErrorResponseBody(responseBody: {
	readonly details?: readonly string[];
	readonly error: string;
}): { readonly details?: readonly string[]; readonly error: string } {
	return {
		error: scrubGithubTokenFromOutput(responseBody.error),
		...(responseBody.details
			? { details: responseBody.details.map((detail) => scrubGithubTokenFromOutput(detail)) }
			: {}),
	};
}

function zoneRuntimeErrorStatus(
	error: unknown,
): 401 | 403 | 404 | 405 | 409 | 412 | 500 | 502 | 503 {
	if (error instanceof ControllerZoneAdminAuthError) {
		return error.httpStatus;
	}
	if (
		error instanceof ControllerZoneNotFoundError ||
		error instanceof ControllerZoneTaskNotFoundError
	) {
		return 404;
	}
	if (error instanceof ControllerZoneOperationUnsupportedError) {
		return 405;
	}
	if (error instanceof ControllerZoneRuntimeUnavailableError) {
		return 409;
	}
	if (error instanceof ControllerZoneTaskNotReadyError) {
		return 409;
	}
	if (
		error instanceof ControllerZoneWorkerCloseError ||
		error instanceof ControllerZoneWorkerCloseAggregateError
	) {
		return 502;
	}
	if (error instanceof ControllerZoneRuntimeStartError) {
		return 503;
	}
	if (error instanceof ControllerZoneConfigurationError) {
		return 412;
	}
	return 500;
}

function zoneRuntimeErrorBody(error: unknown):
	| {
			readonly code: 'zone-admin-auth-denied' | 'zone-admin-auth-required';
			readonly error: string;
			readonly zoneId: string;
	  }
	| {
			readonly error: string;
			readonly gatewayType: string;
			readonly operationName: string;
			readonly zoneId: string;
	  }
	| {
			readonly error: string;
			readonly kind: 'task-not-ready';
			readonly taskId: string | null;
			readonly zoneId: string;
	  }
	| {
			readonly body: string;
			readonly error: string;
			readonly httpStatus: number;
			readonly kind: 'worker-close-failed';
			readonly taskId: string;
			readonly zoneId: string;
	  }
	| {
			readonly error: string;
			readonly failures: readonly {
				readonly body: string;
				readonly httpStatus: number;
				readonly taskId: string;
			}[];
			readonly kind: 'worker-close-aggregate-failed';
			readonly zoneId: string;
	  }
	| { readonly error: string } {
	if (error instanceof ControllerZoneAdminAuthError) {
		return {
			code: error.code,
			error: error.message,
			zoneId: error.zoneId,
		};
	}
	if (error instanceof ControllerZoneOperationUnsupportedError) {
		return {
			error: error.message,
			gatewayType: error.gatewayType,
			operationName: error.operationName,
			zoneId: error.zoneId,
		};
	}
	if (error instanceof ControllerZoneTaskNotReadyError) {
		return {
			error: error.message,
			kind: 'task-not-ready',
			taskId: error.taskId,
			zoneId: error.zoneId,
		};
	}
	if (error instanceof ControllerZoneWorkerCloseError) {
		return {
			error: error.message,
			body: error.body,
			httpStatus: error.httpStatus,
			kind: 'worker-close-failed',
			taskId: error.taskId,
			zoneId: error.zoneId,
		};
	}
	if (error instanceof ControllerZoneWorkerCloseAggregateError) {
		return {
			error: error.message,
			failures: error.failures.map((failure) => ({
				body: failure.body,
				httpStatus: failure.httpStatus,
				taskId: failure.taskId,
			})),
			kind: 'worker-close-aggregate-failed',
			zoneId: error.zoneId,
		};
	}
	return buildErrorResponseBody(error, 'zone-operation-failed');
}

export function registerControllerZoneOperationRoutes(
	app: Hono,
	operations: ControllerRouteOperations,
	options: {
		readonly healthEventStore?: HealthEventStore;
		readonly now?: () => number;
		readonly runtimeReadiness?: () => ControllerRuntimeReadiness;
	} = {},
): void {
	const rejectIfRuntimeNotReady = (context: Context): Response | null => {
		const readiness = options.runtimeReadiness?.() ?? { ready: true, state: 'ready' as const };
		return readiness.ready
			? null
			: context.json(
					{
						error: 'controller-not-ready',
						state: readiness.state,
					},
					503,
				);
	};

	app.get('/controller-status', async (context) => context.json(await operations.getStatus()));
	app.get('/zones/:zoneId/status', async (context) => {
		try {
			return context.json(await operations.getZoneStatus(context.req.param('zoneId')));
		} catch (error) {
			return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
		}
	});
	app.get('/zones/:zoneId/health', async (context) => {
		if (!operations.getZoneHealth) {
			return context.json({ error: 'zone-health-unavailable' }, 405);
		}
		try {
			const health = await operations.getZoneHealth(context.req.param('zoneId'));
			return context.json(health, health.ok ? 200 : 503);
		} catch (error) {
			return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
		}
	});
	app.get('/zones/:zoneId/service-health', async (context) => {
		if (!operations.getZoneServiceHealth) {
			return context.json({ error: 'zone-service-health-unavailable' }, 405);
		}
		try {
			const health = await operations.getZoneServiceHealth(context.req.param('zoneId'));
			if (
				options.healthEventStore &&
				typeof health.path === 'string' &&
				typeof health.port === 'number'
			) {
				options.healthEventStore.record({
					kind: 'gateway-service-health',
					observedAtMs: options.now?.() ?? Date.now(),
					path: health.path,
					port: health.port,
					result: health.ok ? 'ok' : 'failed',
					...(typeof health.statusCode === 'number' ? { statusCode: health.statusCode } : {}),
					zoneId: context.req.param('zoneId'),
				});
			}
			return context.json(health, health.ok ? 200 : 503);
		} catch (error) {
			return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
		}
	});
	app.get('/zones/:zoneId/zone-git/status', async (context) => {
		if (!operations.getZoneGitStatus) {
			return context.json({ error: 'zone-git-status-unavailable' }, 405);
		}
		try {
			return context.json(await operations.getZoneGitStatus(context.req.param('zoneId')));
		} catch (error) {
			const runtimeStatus = zoneRuntimeErrorStatus(error);
			if (runtimeStatus !== 500) {
				return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
			}
			const responseBody = scrubErrorResponseBody(
				buildErrorResponseBody(error, 'zone-git-status-failed'),
			);
			writeControllerRouteLog(
				`zone-git-status failed for zone '${context.req.param('zoneId')}': ${responseBody.error}`,
			);
			return context.json(responseBody, 500);
		}
	});
	app.post('/zones/:zoneId/zone-git/push', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady(context);
		if (notReadyResponse) {
			return notReadyResponse;
		}
		if (!operations.pushZoneGit) {
			return context.json({ error: 'zone-git-push-unavailable' }, 405);
		}
		if (!operations.verifyZoneGitPushToken) {
			return context.json({ error: 'zone-git-push-auth-unavailable' }, 405);
		}
		const zoneId = context.req.param('zoneId');
		if (
			!operations.verifyZoneGitPushToken(zoneId, context.req.header(ZONE_GIT_CAPABILITY_HEADER))
		) {
			return context.json({ error: 'zone-git-push-forbidden' }, 403);
		}
		const parsedPayload = await parseJsonBodyWithSchema(
			context,
			controllerZoneGitPushRequestSchema,
			'invalid-zone-git-push-request',
		);
		if (!parsedPayload.ok) {
			return parsedPayload.response;
		}
		try {
			return context.json(await operations.pushZoneGit(zoneId, parsedPayload.data));
		} catch (error) {
			if (error instanceof ZoneGitConflictError) {
				return context.json(
					{
						error: 'zone-git-push-conflict',
						message: error.message,
					},
					409,
				);
			}
			const runtimeStatus = zoneRuntimeErrorStatus(error);
			if (runtimeStatus !== 500) {
				return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
			}
			const responseBody = scrubErrorResponseBody(
				buildErrorResponseBody(error, 'zone-git-push-failed'),
			);
			writeControllerRouteLog(
				`zone-git-push failed for zone '${context.req.param('zoneId')}': ${responseBody.error}`,
			);
			return context.json(responseBody, 500);
		}
	});
	app.get('/zones/:zoneId/logs', async (context) => {
		try {
			return context.json(await operations.getZoneLogs(context.req.param('zoneId')));
		} catch (error) {
			return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
		}
	});
	app.post('/zones/:zoneId/credentials/refresh', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady(context);
		if (notReadyResponse) {
			return notReadyResponse;
		}
		try {
			return context.json(await operations.refreshZoneCredentials(context.req.param('zoneId')));
		} catch (error) {
			return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
		}
	});
	app.post('/zones/:zoneId/destroy', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady(context);
		if (notReadyResponse) {
			return notReadyResponse;
		}
		const parsedPayload = await parseJsonBodyWithSchema(
			context,
			controllerDestroyZoneRequestSchema,
			'invalid-destroy-request',
		);
		if (!parsedPayload.ok) {
			return parsedPayload.response;
		}
		const payload = parsedPayload.data;
		try {
			return context.json(
				await operations.destroyZone(context.req.param('zoneId'), payload.purge === true),
			);
		} catch (error) {
			return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
		}
	});
	app.post('/zones/:zoneId/upgrade', async (context) => {
		const notReadyResponse = rejectIfRuntimeNotReady(context);
		if (notReadyResponse) {
			return notReadyResponse;
		}
		try {
			return context.json(await operations.upgradeZone(context.req.param('zoneId')));
		} catch (error) {
			return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
		}
	});

	if (operations.prepareWorkerTask && operations.executeWorkerTask) {
		const prepareWorkerTask = operations.prepareWorkerTask;
		const executeWorkerTask = operations.executeWorkerTask;
		app.post('/zones/:zoneId/worker-tasks', async (context) => {
			const notReadyResponse = rejectIfRuntimeNotReady(context);
			if (notReadyResponse) {
				return notReadyResponse;
			}
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
				const runtimeStatus = zoneRuntimeErrorStatus(error);
				if (runtimeStatus !== 500) {
					return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
				}
				if (error instanceof ControllerRuntimeAtCapacityError) {
					return context.json(
						{
							status: 'at-capacity',
							error: error.message,
						},
						409,
					);
				}
				return context.json(buildErrorResponseBody(error, 'worker-task-failed'), 500);
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
				const runtimeStatus = zoneRuntimeErrorStatus(error);
				if (runtimeStatus !== 500) {
					return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
				}
				return context.json(buildErrorResponseBody(error, 'get-task-state-failed'), 500);
			}
		});
	}

	if (operations.closeTaskForZone) {
		const closeTaskForZone = operations.closeTaskForZone;
		app.post('/zones/:zoneId/tasks/:taskId/close', async (context) => {
			const notReadyResponse = rejectIfRuntimeNotReady(context);
			if (notReadyResponse) {
				return notReadyResponse;
			}
			try {
				return context.json(
					await closeTaskForZone(context.req.param('zoneId'), context.req.param('taskId')),
				);
			} catch (error) {
				const runtimeStatus = zoneRuntimeErrorStatus(error);
				if (runtimeStatus !== 500) {
					return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
				}
				if (error instanceof ControllerTaskNotReadyError) {
					return context.json(
						{
							status: 'not-ready',
							...buildErrorResponseBody(error, 'close-task-failed'),
						},
						409,
					);
				}
				return context.json(buildErrorResponseBody(error, 'close-task-failed'), 500);
			}
		});
	}

	if (operations.pushTaskBranches) {
		const pushTaskBranches = operations.pushTaskBranches;
		app.post('/zones/:zoneId/tasks/:taskId/push-branches', async (context) => {
			const notReadyResponse = rejectIfRuntimeNotReady(context);
			if (notReadyResponse) {
				return notReadyResponse;
			}
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
				const runtimeStatus = zoneRuntimeErrorStatus(error);
				if (runtimeStatus !== 500) {
					return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
				}
				const responseBody = buildErrorResponseBody(error, 'push-branches-failed');
				writeControllerRouteLog(
					`push-branches failed for zone '${context.req.param('zoneId')}' task '${context.req.param('taskId')}': ${responseBody.error}`,
				);
				return context.json(responseBody, error instanceof PushBranchesValidationError ? 400 : 500);
			}
		});
	}

	if (operations.pullDefaultForTask) {
		const pullDefaultForTask = operations.pullDefaultForTask;
		app.post('/zones/:zoneId/tasks/:taskId/pull-default', async (context) => {
			const notReadyResponse = rejectIfRuntimeNotReady(context);
			if (notReadyResponse) {
				return notReadyResponse;
			}
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
				const runtimeStatus = zoneRuntimeErrorStatus(error);
				if (runtimeStatus !== 500) {
					return context.json(zoneRuntimeErrorBody(error), runtimeStatus);
				}
				const isValidationError = error instanceof PullDefaultValidationError;
				const logDetail = scrubGithubTokenFromOutput(
					error instanceof Error
						? isValidationError
							? error.message
							: (error.stack ?? error.message)
						: String(error),
				);
				writeControllerRouteLog(
					`pull-default failed for zone '${context.req.param('zoneId')}' task '${context.req.param('taskId')}': ${logDetail}`,
				);
				return context.json(
					scrubErrorResponseBody(buildErrorResponseBody(error, 'pull-default-failed')),
					isValidationError ? 400 : 500,
				);
			}
		});
	}

	if (operations.enableSshForZone) {
		const enableSshForZone = operations.enableSshForZone;
		app.post('/zones/:zoneId/enable-ssh', async (context) => {
			const notReadyResponse = rejectIfRuntimeNotReady(context);
			if (notReadyResponse) {
				return notReadyResponse;
			}
			const parsedPayload = await parseJsonBodyWithSchema(
				context,
				controllerEnableSshRequestSchema,
				'invalid-enable-ssh-request',
			);
			if (!parsedPayload.ok) {
				return parsedPayload.response;
			}
			try {
				const enableSshOptions = {
					...(parsedPayload.data.adminToken ? { adminToken: parsedPayload.data.adminToken } : {}),
					secretEnv: parsedPayload.data.secretEnv,
				};
				return context.json(await enableSshForZone(context.req.param('zoneId'), enableSshOptions));
			} catch (error) {
				return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
			}
		});
	}

	if (operations.execInZone) {
		const execInZone = operations.execInZone;
		app.post('/zones/:zoneId/execute-command', async (context) => {
			const notReadyResponse = rejectIfRuntimeNotReady(context);
			if (notReadyResponse) {
				return notReadyResponse;
			}
			const parsedPayload = await parseJsonBodyWithSchema(
				context,
				controllerExecuteCommandRequestSchema,
				'invalid-execute-command-request',
			);
			if (!parsedPayload.ok) {
				return parsedPayload.response;
			}
			const payload = parsedPayload.data;
			const execOptions: ExecInZoneOptions = payload.adminToken
				? { adminToken: payload.adminToken }
				: {};
			try {
				return context.json(
					await execInZone(context.req.param('zoneId'), payload.command, execOptions),
				);
			} catch (error) {
				return context.json(zoneRuntimeErrorBody(error), zoneRuntimeErrorStatus(error));
			}
		});
	}

	if (operations.stopController) {
		const stopController = operations.stopController;
		app.post('/stop-controller', async (context) => context.json(await stopController()));
	}
}
