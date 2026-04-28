import fs from 'node:fs/promises';
import { join } from 'node:path';

import type { ReviewResult } from '../shared/review-result.js';
import { writeStderr } from '../shared/stderr.js';
import { replayEvents } from './event-log.js';
import type {
	PhaseName,
	TaskConfig,
	TaskEvent,
	TaskStatus,
	VerificationCommandResult,
} from './task-event-types.js';
import { TERMINAL_STATUSES } from './task-event-types.js';

export interface ControllerGitPushState {
	readonly repoUrl: string;
	readonly branch: string;
	readonly status: 'started' | 'retrying' | 'succeeded' | 'failed';
	readonly attempts: number;
	readonly message: string | null;
	readonly retryDelaySeconds: number | null;
	readonly retryAfterSeconds: number | null;
	readonly localHead: string | null;
	readonly remoteBranchHead: string | null;
}

export interface ControllerGitPullState {
	readonly repoUrl: string;
	readonly status: 'started' | 'retrying' | 'succeeded' | 'failed';
	readonly attempts: number;
	readonly message: string | null;
	readonly retryDelaySeconds: number | null;
	readonly retryAfterSeconds: number | null;
	readonly defaultBranch: string | null;
	readonly remoteDefaultHead: string | null;
	readonly localDefaultHead: string | null;
}

export interface TaskState {
	readonly taskId: string;
	readonly status: TaskStatus;
	readonly config: TaskConfig;
	readonly failureReason: string | null;
	readonly plan: string | null;
	readonly lastContextError: string | null;
	readonly planAgentThreadId: string | null;
	readonly planReviewerThreadId: string | null;
	readonly workAgentThreadId: string | null;
	readonly workReviewerThreadId: string | null;
	readonly wrapupThreadId: string | null;
	readonly planReviewCycle: number;
	readonly workReviewCycle: number;
	readonly currentCycle: number;
	readonly currentMaxCycles: number;
	readonly lastPlanReview: ReviewResult | null;
	readonly lastWorkReview: ReviewResult | null;
	readonly lastValidationResults: readonly VerificationCommandResult[] | null;
	readonly wrapupResult: {
		readonly prUrl: string | null;
		readonly branchName: string | null;
		readonly pushedCommits: readonly string[];
	} | null;
	readonly controllerOperations: {
		readonly gitPushes: readonly ControllerGitPushState[];
		readonly gitPulls: readonly ControllerGitPullState[];
	};
	readonly createdAt: string;
	readonly updatedAt: string;
}

const terminalStatusSet = new Set<string>(TERMINAL_STATUSES);

const phaseStatusMap = {
	plan: 'plan-agent',
	work: 'work-agent',
	wrapup: 'wrapup',
} as const satisfies Record<PhaseName, TaskStatus>;

export function createInitialState(taskId: string, config: TaskConfig): TaskState {
	const now = new Date().toISOString();

	return {
		taskId,
		status: 'pending',
		config,
		failureReason: null,
		plan: null,
		lastContextError: null,
		planAgentThreadId: null,
		planReviewerThreadId: null,
		workAgentThreadId: null,
		workReviewerThreadId: null,
		wrapupThreadId: null,
		planReviewCycle: 0,
		workReviewCycle: 0,
		currentCycle: 0,
		currentMaxCycles: 0,
		lastPlanReview: null,
		lastWorkReview: null,
		lastValidationResults: null,
		wrapupResult: null,
		controllerOperations: {
			gitPushes: [],
			gitPulls: [],
		},
		createdAt: now,
		updatedAt: now,
	};
}

function maxCyclesForPhase(state: TaskState, phase: PhaseName): number {
	switch (phase) {
		case 'plan': {
			const planCycle = state.config.effectiveConfig.phases.plan.cycle;
			return planCycle.kind === 'review' ? planCycle.cycleCount : 0;
		}
		case 'work':
			return state.config.effectiveConfig.phases.work.cycle.cycleCount;
		case 'wrapup':
			return 0;
	}
	const exhaustivePhase: never = phase;
	throw new Error(`Unhandled phase '${String(exhaustivePhase)}'.`);
}

function upsertGitPushState(state: TaskState, nextPushState: ControllerGitPushState): TaskState {
	const gitPushes = state.controllerOperations.gitPushes.filter(
		(pushState) =>
			pushState.repoUrl !== nextPushState.repoUrl || pushState.branch !== nextPushState.branch,
	);
	return {
		...state,
		controllerOperations: {
			...state.controllerOperations,
			gitPushes: [...gitPushes, nextPushState],
		},
	};
}

function upsertGitPullState(state: TaskState, nextPullState: ControllerGitPullState): TaskState {
	const gitPulls = state.controllerOperations.gitPulls.filter(
		(pullState) => pullState.repoUrl !== nextPullState.repoUrl,
	);
	return {
		...state,
		controllerOperations: {
			...state.controllerOperations,
			gitPulls: [...gitPulls, nextPullState],
		},
	};
}

export function applyEvent(state: TaskState, event: TaskEvent): TaskState {
	const updatedAt = new Date().toISOString();

	switch (event.event) {
		case 'task-accepted':
			// Controller may persist this before VM boot, and the worker may replay it when accepted.
			return { ...state, status: 'pending', updatedAt };
		case 'context-gather-failed':
			return { ...state, lastContextError: event.reason, updatedAt };
		case 'phase-started':
			return {
				...state,
				status: phaseStatusMap[event.phase],
				currentCycle: 0,
				currentMaxCycles: maxCyclesForPhase(state, event.phase),
				updatedAt,
			};
		case 'phase-completed':
			return { ...state, updatedAt };
		case 'plan-agent-turn':
			return {
				...state,
				status: 'plan-agent',
				planAgentThreadId: event.threadId,
				currentCycle: event.cycle,
				updatedAt,
			};
		case 'plan-reviewer-turn':
			return {
				...state,
				status: 'plan-reviewer',
				planReviewerThreadId: event.threadId,
				planReviewCycle: event.cycle,
				currentCycle: event.cycle,
				lastPlanReview: event.review,
				updatedAt,
			};
		case 'plan-finalized':
			return { ...state, plan: event.plan, updatedAt };
		case 'work-agent-turn':
			return {
				...state,
				status: 'work-agent',
				workAgentThreadId: event.threadId,
				currentCycle: event.cycle,
				updatedAt,
			};
		case 'work-reviewer-turn':
			return {
				...state,
				status: 'work-reviewer',
				workReviewerThreadId: event.threadId,
				workReviewCycle: event.cycle,
				currentCycle: event.cycle,
				lastWorkReview: event.review,
				lastValidationResults: event.validationResults,
				updatedAt,
			};
		case 'wrapup-turn':
			return {
				...state,
				status: 'wrapup',
				wrapupThreadId: event.threadId,
				updatedAt,
			};
		case 'wrapup-result':
			return {
				...state,
				wrapupResult: {
					prUrl: event.prUrl,
					branchName: event.branchName,
					pushedCommits: event.pushedCommits,
				},
				updatedAt,
			};
		case 'controller-git-push-started':
			return {
				...upsertGitPushState(state, {
					repoUrl: event.repoUrl,
					branch: event.branch,
					status: 'started',
					attempts: 0,
					message: null,
					retryDelaySeconds: null,
					retryAfterSeconds: null,
					localHead: null,
					remoteBranchHead: null,
				}),
				updatedAt,
			};
		case 'controller-git-push-retry':
			return {
				...upsertGitPushState(state, {
					repoUrl: event.repoUrl,
					branch: event.branch,
					status: 'retrying',
					attempts: event.attempts,
					message: event.message,
					retryDelaySeconds: event.retryDelaySeconds,
					retryAfterSeconds: null,
					localHead: null,
					remoteBranchHead: null,
				}),
				updatedAt,
			};
		case 'controller-git-push-succeeded':
			return {
				...upsertGitPushState(state, {
					repoUrl: event.repoUrl,
					branch: event.branch,
					status: 'succeeded',
					attempts: event.attempts,
					message: null,
					retryDelaySeconds: null,
					retryAfterSeconds: null,
					localHead: event.localHead ?? null,
					remoteBranchHead: event.remoteBranchHead ?? null,
				}),
				updatedAt,
			};
		case 'controller-git-push-failed':
			return {
				...upsertGitPushState(state, {
					repoUrl: event.repoUrl,
					branch: event.branch,
					status: 'failed',
					attempts: event.attempts,
					message: event.message,
					retryDelaySeconds: null,
					retryAfterSeconds: event.retryAfterSeconds ?? null,
					localHead: null,
					remoteBranchHead: null,
				}),
				updatedAt,
			};
		case 'controller-git-pull-started':
			return {
				...upsertGitPullState(state, {
					repoUrl: event.repoUrl,
					status: 'started',
					attempts: 0,
					message: null,
					retryDelaySeconds: null,
					retryAfterSeconds: null,
					defaultBranch: null,
					remoteDefaultHead: null,
					localDefaultHead: null,
				}),
				updatedAt,
			};
		case 'controller-git-pull-retry':
			return {
				...upsertGitPullState(state, {
					repoUrl: event.repoUrl,
					status: 'retrying',
					attempts: event.attempts,
					message: event.message,
					retryDelaySeconds: event.retryDelaySeconds,
					retryAfterSeconds: null,
					defaultBranch: null,
					remoteDefaultHead: null,
					localDefaultHead: null,
				}),
				updatedAt,
			};
		case 'controller-git-pull-succeeded':
			return {
				...upsertGitPullState(state, {
					repoUrl: event.repoUrl,
					status: 'succeeded',
					attempts: event.attempts,
					message: null,
					retryDelaySeconds: null,
					retryAfterSeconds: null,
					defaultBranch: event.defaultBranch,
					remoteDefaultHead: event.remoteDefaultHead ?? null,
					localDefaultHead: event.localDefaultHead ?? null,
				}),
				updatedAt,
			};
		case 'controller-git-pull-failed':
			return {
				...upsertGitPullState(state, {
					repoUrl: event.repoUrl,
					status: 'failed',
					attempts: event.attempts,
					message: event.message,
					retryDelaySeconds: null,
					retryAfterSeconds: event.retryAfterSeconds ?? null,
					defaultBranch: null,
					remoteDefaultHead: null,
					localDefaultHead: null,
				}),
				updatedAt,
			};
		case 'task-completed':
			return { ...state, status: 'completed', updatedAt };
		case 'task-failed':
			return { ...state, status: 'failed', failureReason: event.reason, updatedAt };
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

export async function loadTaskStateFromLog(filePath: string): Promise<TaskState | null> {
	const events = await replayEvents(filePath);
	if (events.length === 0) {
		return null;
	}

	const firstEvent = events[0];
	if (!firstEvent || firstEvent.data.event !== 'task-accepted') {
		writeStderr(`Skipping ${filePath}: first event is not task-accepted`);
		return null;
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

	return state;
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
			const state = await loadTaskStateFromLog(filePath);
			if (state) {
				taskStates.set(state.taskId, state);
			}
		}
		return taskStates;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return new Map();
		}
		throw error;
	}
}
