import { join } from 'node:path';

import type { WorkerConfig } from '../config/worker-config.js';
import { writeStderr } from '../shared/stderr.js';
import { appendEvent } from '../state/event-log.js';
import type { TaskConfig, TaskEvent } from '../state/task-event-types.js';
import { applyEvent, type TaskState } from '../state/task-state.js';
import type { CreateTaskInput } from './coordinator-types.js';

export function sanitizeErrorMessage(message: string): string {
	return message
		.replace(/https:\/\/x-access-token:[^@]*@/g, 'https://x-access-token:***@')
		.replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
		.replace(/ghp_[A-Za-z0-9_]{20,}/g, 'ghp_***')
		.replace(/ghs_[A-Za-z0-9_]{20,}/g, 'ghs_***')
		.replace(/Bearer [A-Za-z0-9._-]+/giu, 'Bearer ***')
		.replace(/OPENAI_API_KEY=[^\s]+/gu, 'OPENAI_API_KEY=***');
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
			const message = error instanceof Error ? error.message : String(error);
			writeStderr(`[task-event-recorder] Failed to append task-failed for ${taskId}: ${message}`);
			const current = tasks.get(taskId);
			if (current) {
				tasks.set(taskId, applyEvent(current, { event: 'task-failed', reason }));
			}
			writeStderr(
				`[task-event-recorder] Fatal: task-failed could not be persisted for ${taskId}; exiting to avoid state resurrection on restart.`,
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
