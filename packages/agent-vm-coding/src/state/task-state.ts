import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { replayEvents } from './event-log.js';
import type { TaskConfig, TaskEvent, TaskStatus } from './task-event-types.js';
import { TERMINAL_STATUSES } from './task-event-types.js';

export interface TaskState {
	readonly taskId: string;
	readonly status: TaskStatus;
	readonly config: TaskConfig;
	readonly plannerThreadId: string | null;
	readonly coderThreadId: string | null;
	readonly planReviewLoop: number;
	readonly codeReviewLoop: number;
	readonly sanityCheckAttempt: number;
	readonly plan: string | null;
	readonly lastPlanReviewComments: string | null;
	readonly lastCodeReviewComments: string | null;
	readonly lastTestOutput: string | null;
	readonly lastTestExitCode: number | null;
	readonly lastLintOutput: string | null;
	readonly lastLintExitCode: number | null;
	readonly followupPrompt: string | null;
	readonly prUrl: string | null;
	readonly prBranch: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export function createInitialState(taskId: string, config: TaskConfig): TaskState {
	const now = new Date().toISOString();
	return {
		taskId,
		status: 'accepted',
		config,
		plannerThreadId: null,
		coderThreadId: null,
		planReviewLoop: 0,
		codeReviewLoop: 0,
		sanityCheckAttempt: 0,
		plan: null,
		lastPlanReviewComments: null,
		lastCodeReviewComments: null,
		lastTestOutput: null,
		lastTestExitCode: null,
		lastLintOutput: null,
		lastLintExitCode: null,
		followupPrompt: null,
		prUrl: null,
		prBranch: null,
		createdAt: now,
		updatedAt: now,
	};
}

export function applyEvent(state: TaskState, event: TaskEvent): TaskState {
	const updatedAt = new Date().toISOString();
	switch (event.event) {
		case 'task-accepted':
			return { ...state, status: 'accepted', updatedAt };
		case 'task-closed':
			return { ...state, status: 'completed', updatedAt };
		case 'context-gathered':
			return { ...state, status: 'planning', updatedAt };
		case 'plan-created':
			return {
				...state,
				status: 'planning',
				plan: event.plan,
				plannerThreadId: event.plannerThreadId,
				updatedAt,
			};
		case 'plan-review-started':
			return { ...state, status: 'planning', planReviewLoop: event.loop, updatedAt };
		case 'plan-approved':
			return {
				...state,
				status: 'implementing',
				planReviewLoop: event.loop,
				lastPlanReviewComments: null,
				updatedAt,
			};
		case 'plan-revision-requested':
			return {
				...state,
				status: 'planning',
				planReviewLoop: event.loop,
				lastPlanReviewComments: event.comments,
				updatedAt,
			};
		case 'plan-revised':
			return { ...state, status: 'planning', plan: event.plan, updatedAt };
		case 'implementation-started':
			return { ...state, status: 'implementing', coderThreadId: event.coderThreadId, updatedAt };
		case 'implementation-complete':
			return { ...state, status: 'implementing', updatedAt };
		case 'sanity-check-passed':
			return {
				...state,
				status: 'reviewing-code',
				lastTestOutput: null,
				lastTestExitCode: null,
				lastLintOutput: null,
				lastLintExitCode: null,
				updatedAt,
			};
		case 'sanity-check-failed':
			return {
				...state,
				status: 'implementing',
				sanityCheckAttempt: state.sanityCheckAttempt + 1,
				lastTestExitCode: event.testExitCode,
				lastTestOutput: event.testOutput,
				lastLintExitCode: event.lintExitCode,
				lastLintOutput: event.lintOutput,
				updatedAt,
			};
		case 'code-review-started':
			return { ...state, status: 'reviewing-code', codeReviewLoop: event.loop, updatedAt };
		case 'code-approved':
			return { ...state, status: 'awaiting-followup', lastCodeReviewComments: null, updatedAt };
		case 'code-revision-requested':
			return {
				...state,
				status: 'implementing',
				codeReviewLoop: event.loop,
				lastCodeReviewComments: event.comments,
				updatedAt,
			};
		case 'code-fix-complete':
			return { ...state, status: 'implementing', updatedAt };
		case 'pr-created':
			return {
				...state,
				status: 'awaiting-followup',
				prUrl: event.url,
				prBranch: event.branch,
				updatedAt,
			};
		case 'followup-accepted':
			return { ...state, status: 'accepted', followupPrompt: event.prompt, updatedAt };
		case 'task-failed':
			return { ...state, status: 'failed', updatedAt };
		default: {
			const exhaustiveCheck: never = event;
			throw new Error(`Unhandled task event: ${JSON.stringify(exhaustiveCheck)}`);
		}
	}
}

export function isTerminal(state: TaskState): boolean {
	return new Set<string>(TERMINAL_STATUSES).has(state.status);
}

export function hydrateTaskStates(stateDir: string): Map<string, TaskState> {
	const tasksDir = join(stateDir, 'tasks');
	const taskStates = new Map<string, TaskState>();

	try {
		const files = readdirSync(tasksDir);
		for (const file of files) {
			if (!file.endsWith('.jsonl')) {
				continue;
			}
			const events = replayEvents(join(tasksDir, file));
			if (events.length === 0) {
				continue;
			}

			const firstEvent = events[0];
			if (!firstEvent || firstEvent.data.event !== 'task-accepted') {
				console.warn(`Skipping ${file}: first event is not task-accepted`);
				continue;
			}

			let state = createInitialState(firstEvent.data.taskId, firstEvent.data.config);
			state = {
				...state,
				createdAt: firstEvent.ts,
				updatedAt: firstEvent.ts,
			};

			for (let index = 1; index < events.length; index += 1) {
				const event = events[index];
				if (!event) continue;
				state = applyEvent(state, event.data);
			}

			taskStates.set(state.taskId, state);
		}
		return taskStates;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return new Map();
		}
		throw error;
	}
}
