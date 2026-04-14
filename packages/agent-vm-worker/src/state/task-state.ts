import fs from 'node:fs/promises';
import { join } from 'node:path';

import { writeStderr } from '../shared/stderr.js';
import { replayEvents } from './event-log.js';
import type {
	TaskConfig,
	TaskEvent,
	PhaseName,
	TaskStatus,
	VerificationCommandResult,
	WrapupActionResult,
} from './task-event-types.js';
import { TERMINAL_STATUSES } from './task-event-types.js';

export interface TaskState {
	readonly taskId: string;
	readonly status: TaskStatus;
	readonly config: TaskConfig;
	readonly plan: string | null;
	readonly lastContextError: string | null;
	readonly lastDiffError: string | null;
	readonly plannerThreadId: string | null;
	readonly workThreadId: string | null;
	readonly planReviewLoop: number;
	readonly workReviewLoop: number;
	readonly verificationAttempt: number;
	readonly lastReviewSummary: string | null;
	readonly lastVerificationResults: readonly VerificationCommandResult[] | null;
	readonly wrapupResults: readonly WrapupActionResult[] | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

const terminalStatusSet = new Set<string>(TERMINAL_STATUSES);

const phaseStatusMap = {
	plan: 'planning',
	'plan-review': 'reviewing-plan',
	work: 'working',
	verification: 'verifying',
	'work-review': 'reviewing-work',
	wrapup: 'wrapping-up',
} as const satisfies Record<PhaseName, TaskStatus>;

export function createInitialState(taskId: string, config: TaskConfig): TaskState {
	const now = new Date().toISOString();

	return {
		taskId,
		status: 'pending',
		config,
		plan: null,
		lastContextError: null,
		lastDiffError: null,
		plannerThreadId: null,
		workThreadId: null,
		planReviewLoop: 0,
		workReviewLoop: 0,
		verificationAttempt: 0,
		lastReviewSummary: null,
		lastVerificationResults: null,
		wrapupResults: null,
		createdAt: now,
		updatedAt: now,
	};
}

export function applyEvent(state: TaskState, event: TaskEvent): TaskState {
	const updatedAt = new Date().toISOString();

	switch (event.event) {
		case 'task-accepted':
			return { ...state, status: 'pending', updatedAt };
		case 'context-gather-failed':
			return { ...state, lastContextError: event.reason, updatedAt };
		case 'phase-started': {
			return { ...state, status: phaseStatusMap[event.phase], updatedAt };
		}
		case 'phase-completed':
			return { ...state, updatedAt };
		case 'plan-created':
			return {
				...state,
				plan: event.plan,
				plannerThreadId: event.threadId,
				updatedAt,
			};
		case 'work-started':
			return {
				...state,
				workThreadId: event.threadId,
				verificationAttempt: 0,
				updatedAt,
			};
		case 'review-result':
			if (event.phase === 'plan-review') {
				return {
					...state,
					planReviewLoop: event.loop,
					lastReviewSummary: event.approved ? null : event.summary,
					updatedAt,
				};
			}
			return {
				...state,
				workReviewLoop: event.loop,
				lastReviewSummary: event.approved ? null : event.summary,
				updatedAt,
			};
		case 'diff-read-failed':
			return { ...state, lastDiffError: event.reason, updatedAt };
		case 'verification-result': {
			const allPassed = event.results.every((result) => result.passed);
			return {
				...state,
				verificationAttempt: allPassed ? state.verificationAttempt : state.verificationAttempt + 1,
				lastVerificationResults: event.results,
				updatedAt,
			};
		}
		case 'fix-applied':
			return { ...state, updatedAt };
		case 'wrapup-result':
			return {
				...state,
				wrapupResults: event.actions.map((action) => ({
					key: action.key,
					type: action.type,
					success: action.success,
					...(action.artifact !== undefined ? { artifact: action.artifact } : {}),
				})),
				updatedAt,
			};
		case 'task-completed':
			return { ...state, status: 'completed', updatedAt };
		case 'task-failed':
			return { ...state, status: 'failed', updatedAt };
		case 'task-closed':
			return { ...state, status: 'closed', updatedAt };
		default: {
			const exhaustiveCheck: never = event;
			throw new Error(`Unhandled task event: ${JSON.stringify(exhaustiveCheck)}`);
		}
	}
}

export function isTerminal(state: TaskState): boolean {
	return terminalStatusSet.has(state.status);
}

export async function hydrateTaskStates(stateDir: string): Promise<Map<string, TaskState>> {
	const tasksDir = join(stateDir, 'tasks');
	const taskStates = new Map<string, TaskState>();

	try {
		const files = await fs.readdir(tasksDir);
		for (const file of files) {
			if (!file.endsWith('.jsonl')) {
				continue;
			}
			const filePath = join(tasksDir, file);
			// Replay stays sequential so stderr warnings and corruption errors point at one file at a time.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const events = await replayEvents(filePath);
			if (events.length === 0) {
				continue;
			}

			const firstEvent = events[0];
			if (!firstEvent || firstEvent.data.event !== 'task-accepted') {
				writeStderr(`Skipping ${file}: first event is not task-accepted`);
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
