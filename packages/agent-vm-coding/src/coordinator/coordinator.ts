import { randomUUID } from 'node:crypto';

import { getDiff } from '../git/git-operations.js';
import {
	createInitialState,
	hydrateTaskStates,
	isTerminal,
	type TaskState,
} from '../state/task-state.js';
import {
	buildTaskConfig,
	createTaskEventRecorder,
	sanitizeErrorMessage,
} from './coordinator-helpers.js';
import type { Coordinator, CoordinatorDeps, CreateTaskInput } from './coordinator-types.js';
import {
	buildCodeReviewPrompt,
	buildCoderFixPrompt,
	buildCoderImplementPrompt,
	buildPlannerPrompt,
	buildPlanReviewPrompt,
	buildPlanRevisionPrompt,
} from './prompt-builder.js';
import { runSanityRetries } from './run-sanity-retries.js';
import { gatherTaskContext, setupGitForTask } from './task-setup.js';
import { shipTask } from './task-ship.js';
export type { Coordinator, CoordinatorDeps, CreateTaskInput } from './coordinator-types.js';

async function runTask(
	taskId: string,
	deps: CoordinatorDeps,
	workspaceDir: string,
	tasks: Map<string, TaskState>,
	eventRecorder: ReturnType<typeof createTaskEventRecorder>,
	onTaskFinished: () => void,
): Promise<void> {
	try {
		const initialState = tasks.get(taskId);
		if (!initialState || eventRecorder.isClosed(taskId)) {
			return;
		}

		const branchName = `${deps.config.branchPrefix}${taskId}`;
		// eslint-disable-next-line no-console
		console.log(`[coordinator] task ${taskId}: gathering context`);
		const context = gatherTaskContext(workspaceDir);
		eventRecorder.emit(taskId, {
			event: 'context-gathered',
			fileCount: context.fileCount,
		});

		let currentPlan = initialState.plan ?? '';
		if (initialState.followupPrompt === null) {
			// eslint-disable-next-line no-console
			console.log(
				`[coordinator] task ${taskId}: planning (loop 1/${initialState.config.maxPlanReviewLoops})`,
			);
			const planResult = await deps.plannerAgent.plan(
				buildPlannerPrompt({
					taskPrompt: initialState.config.prompt,
					context,
					skills: initialState.config.plannerSkills,
				}),
			);
			eventRecorder.emit(taskId, {
				event: 'plan-created',
				plannerThreadId: planResult.threadId,
				plan: planResult.response,
				tokenCount: planResult.tokenCount,
			});
			currentPlan = planResult.response;

			for (let loop = 1; loop <= initialState.config.maxPlanReviewLoops; loop += 1) {
				eventRecorder.emit(taskId, { event: 'plan-review-started', loop });
				const review = await deps.planReviewerAgent.review(
					buildPlanReviewPrompt(
						initialState.config.prompt,
						currentPlan,
						context,
						initialState.config.planReviewerSkills,
					),
				);

				if (review.approved) {
					// eslint-disable-next-line no-console
					console.log(`[coordinator] task ${taskId}: plan approved`);
					eventRecorder.emit(taskId, { event: 'plan-approved', loop });
					break;
				}

				eventRecorder.emit(taskId, {
					event: 'plan-revision-requested',
					loop,
					comments: review.summary,
				});

				if (loop === initialState.config.maxPlanReviewLoops) {
					eventRecorder.recordTaskFailure(taskId, 'Plan review loop exhausted');
					return;
				}

				const revisedPlan = await deps.plannerAgent.revise(
					buildPlanRevisionPrompt({
						reviewSummary: review.summary,
						skills: initialState.config.plannerSkills,
					}),
				);
				currentPlan = revisedPlan.response;
				eventRecorder.emit(taskId, {
					event: 'plan-revised',
					plan: currentPlan,
					tokenCount: revisedPlan.tokenCount,
				});
			}
		} else {
			currentPlan = [
				initialState.plan ?? '',
				'',
				`Follow-up request: ${initialState.followupPrompt}`,
			].join('\n');
		}

		// eslint-disable-next-line no-console
		console.log(`[coordinator] task ${taskId}: implementing`);
		const implementResult = await deps.coderAgent.implement(
			buildCoderImplementPrompt({
				plan: currentPlan,
				skills: initialState.config.coderSkills,
			}),
		);
		eventRecorder.emit(taskId, {
			event: 'implementation-started',
			coderThreadId: implementResult.threadId,
		});
		eventRecorder.emit(taskId, {
			event: 'implementation-complete',
			tokenCount: implementResult.tokenCount,
		});

		// eslint-disable-next-line no-console
		console.log(
			`[coordinator] task ${taskId}: sanity check 1/${initialState.config.maxSanityRetries}`,
		);
		const initialSanityPassed = await runSanityRetries(
			taskId,
			deps,
			workspaceDir,
			tasks,
			eventRecorder,
		);
		if (!initialSanityPassed || eventRecorder.isClosed(taskId)) {
			return;
		}

		for (let loop = 1; loop <= initialState.config.maxCodeReviewLoops; loop += 1) {
			const currentState = tasks.get(taskId);
			if (!currentState || eventRecorder.isClosed(taskId)) {
				return;
			}

			// eslint-disable-next-line no-console
			console.log(
				`[coordinator] task ${taskId}: code review (loop ${loop}/${initialState.config.maxCodeReviewLoops})`,
			);
			eventRecorder.emit(taskId, { event: 'code-review-started', loop });
			const review = await deps.codeReviewerAgent.review(
				buildCodeReviewPrompt({
					taskPrompt: currentState.config.prompt,
					diff: await getDiff(workspaceDir),
					skills: currentState.config.codeReviewerSkills,
				}),
			);

			if (review.approved) {
				// eslint-disable-next-line no-console
				console.log(`[coordinator] task ${taskId}: code approved, shipping`);
				eventRecorder.emit(taskId, { event: 'code-approved' });
				break;
			}

			eventRecorder.emit(taskId, {
				event: 'code-revision-requested',
				loop,
				comments: review.summary,
			});

			if (loop === currentState.config.maxCodeReviewLoops) {
				eventRecorder.recordTaskFailure(taskId, 'Code review loop exhausted');
				return;
			}

			const fixResult = await deps.coderAgent.fix(
				buildCoderFixPrompt({
					reviewSummary: review.summary,
					skills: currentState.config.coderSkills,
				}),
			);
			eventRecorder.emit(taskId, {
				event: 'code-fix-complete',
				tokenCount: fixResult.tokenCount,
			});

			// eslint-disable-next-line no-console
			console.log(
				`[coordinator] task ${taskId}: sanity check ${loop + 1}/${initialState.config.maxSanityRetries}`,
			);
			const retryPassed = await runSanityRetries(taskId, deps, workspaceDir, tasks, eventRecorder);
			if (!retryPassed || eventRecorder.isClosed(taskId)) {
				return;
			}
		}

		const shippableState = tasks.get(taskId);
		if (!shippableState || eventRecorder.isClosed(taskId)) {
			return;
		}

		await setupGitForTask(branchName, workspaceDir);
		const prUrl = await shipTask({
			branchName,
			commitCoAuthor: deps.config.commitCoAuthor,
			workspaceDir,
			taskState: { ...shippableState, plan: currentPlan },
		});

		// eslint-disable-next-line no-console
		console.log(`[coordinator] task ${taskId}: PR created: ${prUrl}`);
		eventRecorder.emit(taskId, {
			event: 'pr-created',
			url: prUrl,
			branch: branchName,
		});
	} catch (error) {
		const reason = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
		// eslint-disable-next-line no-console
		console.log(`[coordinator] task ${taskId}: failed: ${reason}`);

		try {
			eventRecorder.recordTaskFailure(taskId, reason);
		} catch (emitError) {
			// eslint-disable-next-line no-console
			console.error(
				`[coordinator] Failed to persist task-failed for ${taskId}:`,
				emitError instanceof Error ? emitError.message : String(emitError),
			);
			// Force in-memory state to failed even without disk persistence
			const current = tasks.get(taskId);
			if (current && !isTerminal(current)) {
				tasks.set(taskId, { ...current, status: 'failed', updatedAt: new Date().toISOString() });
			}
		}
	} finally {
		onTaskFinished();
	}
}

export function createCoordinator(deps: CoordinatorDeps): Coordinator {
	const workspaceDir = deps.workspaceDir ?? '/workspace';
	const tasks = hydrateTaskStates(deps.config.stateDir);
	const closedTaskIds = new Set<string>();
	const eventRecorder = createTaskEventRecorder(deps.config.stateDir, tasks, closedTaskIds);
	let activeTaskId: string | null = null;

	function finishActiveTask(taskId: string): void {
		if (activeTaskId === taskId) {
			activeTaskId = null;
		}
	}

	return {
		async submitTask(input: CreateTaskInput): Promise<{ taskId: string; status: 'accepted' }> {
			if (activeTaskId !== null) {
				throw new Error(`Another task is already active: ${activeTaskId}`);
			}

			const taskId = randomUUID().slice(0, 8);
			const taskConfig = buildTaskConfig(input, deps.config);
			tasks.set(taskId, createInitialState(taskId, taskConfig));
			eventRecorder.emit(taskId, {
				event: 'task-accepted',
				taskId,
				config: taskConfig,
			});

			activeTaskId = taskId;
			void runTask(taskId, deps, workspaceDir, tasks, eventRecorder, () =>
				finishActiveTask(taskId),
			);

			return { taskId, status: 'accepted' };
		},

		getActiveTaskId(): string | null {
			return activeTaskId;
		},

		getTaskState(taskId: string): TaskState | undefined {
			return tasks.get(taskId);
		},

		async submitFollowup(taskId: string, prompt: string): Promise<{ status: 'accepted' }> {
			if (activeTaskId !== null) {
				throw new Error(
					`Task ${activeTaskId} is still active. Wait for it to complete before sending a followup.`,
				);
			}

			const state = tasks.get(taskId);
			if (!state) {
				throw new Error(`Task not found: ${taskId}`);
			}
			if (state.status !== 'awaiting-followup') {
				throw new Error(`Task ${taskId} is not awaiting followup: ${state.status}`);
			}

			eventRecorder.emit(taskId, { event: 'followup-accepted', prompt });
			activeTaskId = taskId;
			void runTask(taskId, deps, workspaceDir, tasks, eventRecorder, () =>
				finishActiveTask(taskId),
			);

			return { status: 'accepted' };
		},

		async closeTask(taskId: string): Promise<{ status: 'closed' }> {
			const state = tasks.get(taskId);
			if (!state) {
				throw new Error(`Task not found: ${taskId}`);
			}
			if (isTerminal(state)) {
				throw new Error(`Task ${taskId} is terminal: ${state.status}`);
			}

			closedTaskIds.add(taskId);
			eventRecorder.emit(taskId, { event: 'task-closed' });
			finishActiveTask(taskId);

			return { status: 'closed' };
		},
	};
}
