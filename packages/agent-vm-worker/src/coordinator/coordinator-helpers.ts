import { join } from 'node:path';

import type { WorkerConfig } from '../config/worker-config.js';
import { appendEvent } from '../state/event-log.js';
import type { TaskConfig, TaskEvent } from '../state/task-event-types.js';
import { applyEvent, type TaskState } from '../state/task-state.js';
import type { CreateTaskInput } from './coordinator-types.js';

export function sanitizeErrorMessage(message: string): string {
	return message.replace(/https:\/\/x-access-token:[^@]*@/g, 'https://x-access-token:***@');
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
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
): {
	readonly emit: (taskId: string, event: TaskEvent) => Promise<void>;
	readonly isClosed: (taskId: string) => boolean;
	readonly recordTaskFailure: (taskId: string, reason: string) => Promise<void>;
} {
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
