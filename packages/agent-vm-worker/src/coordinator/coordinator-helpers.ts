import { join } from 'node:path';

import { getLogger } from '@logtape/logtape';

import type { WorkerConfig } from '../config/worker-config.js';
import { toSafeWorkerLogProperties } from '../shared/process-logging.js';
import { appendEvent } from '../state/event-log.js';
import type { TaskConfig, TaskEvent } from '../state/task-event-types.js';
import { applyEvent, type TaskState } from '../state/task-state.js';
import type { CreateTaskInput } from './coordinator-types.js';

const coordinatorLogger = getLogger(['agent-vm', 'worker', 'coordinator']);

export function sanitizeErrorMessage(message: string): string {
	return message
		.replace(/https:\/\/x-access-token:[^@]*@/g, 'https://x-access-token:***@')
		.replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
		.replace(/ghp_[A-Za-z0-9_]{20,}/g, 'ghp_***')
		.replace(/ghs_[A-Za-z0-9_]{20,}/g, 'ghs_***')
		.replace(/Bearer [A-Za-z0-9._-]+/giu, 'Bearer ***')
		.replace(/OPENAI_API_KEY=[^\s]+/gu, 'OPENAI_API_KEY=***');
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

function collectErrorMessages(error: unknown, seen: Set<unknown>): readonly string[] {
	if (error === undefined || seen.has(error)) {
		return [];
	}
	seen.add(error);

	if (error instanceof AggregateError) {
		const childMessages = error.errors.flatMap((innerError: unknown) =>
			collectErrorMessages(innerError, seen),
		);
		const causeMessages = collectErrorMessages(error.cause, seen);
		return [error.message, ...childMessages, ...causeMessages];
	}
	if (error instanceof Error) {
		return [error.message, ...collectErrorMessages(error.cause, seen)];
	}
	return [formatNonErrorDetail(error)];
}

export function formatTaskFailureReason(error: unknown): string {
	const messages = collectErrorMessages(error, new Set<unknown>());
	return sanitizeErrorMessage(messages.length > 0 ? messages.join('\nCaused by: ') : String(error));
}

export function buildTaskConfig(input: CreateTaskInput, config: WorkerConfig): TaskConfig {
	return {
		taskId: input.taskId,
		prompt: input.prompt,
		repos: [...(input.repos ?? [])],
		context: input.context ?? {},
		effectiveConfig: config,
	};
}

export function createTaskEventRecorder(
	stateDir: string,
	tasks: Map<string, TaskState>,
	closedTaskIds: Set<string>,
): TaskEventRecorder {
	function logPath(taskId: string): string {
		return join(stateDir, 'tasks', `${taskId}.jsonl`);
	}

	async function emit(taskId: string, event: TaskEvent): Promise<void> {
		if (closedTaskIds.has(taskId) && event.event !== 'task-closed') {
			return;
		}

		await appendEvent(logPath(taskId), event);
		const current = tasks.get(taskId);
		if (current) {
			tasks.set(taskId, applyEvent(current, event));
		}
	}

	async function recordTaskFailure(taskId: string, reason: string): Promise<void> {
		try {
			await emit(taskId, { event: 'task-failed', reason });
		} catch (error) {
			coordinatorLogger.error(
				'Worker task failure event could not be persisted.',
				toSafeWorkerLogProperties({
					event: 'task-failure-persistence-failed',
					failureClass: 'persistence-failed',
					error,
				}),
			);
			coordinatorLogger.error(
				'Worker task failure persistence is fatal.',
				toSafeWorkerLogProperties({
					event: 'task-failure-persistence-fatal',
					failureClass: 'fatal',
					error,
				}),
			);
			process.exitCode = 1;
			setImmediate(() => {
				process.exit(1);
			});
		}
	}

	return {
		emit,
		isClosed(taskId: string): boolean {
			return closedTaskIds.has(taskId);
		},
		recordTaskFailure,
	};
}

export interface TaskEventRecorder {
	readonly emit: (taskId: string, event: TaskEvent) => Promise<void>;
	readonly isClosed: (taskId: string) => boolean;
	readonly recordTaskFailure: (taskId: string, reason: string) => Promise<void>;
}
