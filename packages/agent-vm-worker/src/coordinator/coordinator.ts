import type { WorkerConfig } from '../config/worker-config.js';
import { resolvePhaseExecutor } from '../config/worker-config.js';
import { gatherContext } from '../context/gather-context.js';
import { getDiff } from '../git/git-operations.js';
import { createPlanReviewer } from '../planner/plan-reviewer.js';
import { createPlanner } from '../planner/planner.js';
import { assemblePrompt } from '../prompt/prompt-assembler.js';
import {
	createInitialState,
	hydrateTaskStates,
	isTerminal,
	type TaskState,
} from '../state/task-state.js';
import { createWorkExecutor } from '../work-executor/executor-factory.js';
import {
	allVerificationsPassed,
	buildVerificationFailureSummary,
	runVerification,
} from '../work-reviewer/verification-runner.js';
import { reviewWork } from '../work-reviewer/work-reviewer.js';
import { buildWrapupTools, getWrapupActionConfigs } from '../wrapup/wrapup-action-registry.js';
import { findMissingRequiredActions } from '../wrapup/wrapup-types.js';
import {
	buildTaskConfig,
	createTaskEventRecorder,
	sanitizeErrorMessage,
} from './coordinator-helpers.js';
import type { Coordinator, CreateTaskInput } from './coordinator-types.js';

export type { Coordinator, CreateTaskInput } from './coordinator-types.js';

interface CoordinatorDeps {
	readonly config: WorkerConfig;
	readonly workspaceDir?: string;
}

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

		const config = deps.config;
		let repoSummary: string | null = null;
		try {
			const repoContext = await gatherContext(workspaceDir);
			repoSummary = repoContext.summary;
		} catch {
			repoSummary = null;
		}

		eventRecorder.emit(taskId, { event: 'phase-started', phase: 'plan' });

		const planExecutorConfig = resolvePhaseExecutor(config, config.phases.plan);
		const planExecutor = createWorkExecutor(
			planExecutorConfig.provider,
			planExecutorConfig.model,
			{ mcpServers: config.mcpServers, tools: [] },
			workspaceDir,
		);
		const planner = createPlanner(planExecutor);

		const planResult = await planner.plan(
			assemblePrompt({
				phase: 'plan',
				phaseInstructions: config.phases.plan.instructions,
				taskPrompt: initialState.config.prompt,
				repo: initialState.config.repo,
				context: initialState.config.context,
				repoSummary,
				skills: config.phases.plan.skills,
			}),
		);
		let currentPlan = planResult.plan;

		eventRecorder.emit(taskId, {
			event: 'plan-created',
			plan: currentPlan,
			threadId: planResult.threadId,
		});
		eventRecorder.emit(taskId, {
			event: 'phase-completed',
			phase: 'plan',
			tokenCount: planResult.tokenCount,
		});

		for (
			let loop = 1;
			loop <= initialState.config.effectiveConfig.phases.plan.maxReviewLoops;
			loop += 1
		) {
			if (eventRecorder.isClosed(taskId)) return;

			eventRecorder.emit(taskId, {
				event: 'phase-started',
				phase: 'plan-review',
				loop,
			});

			const reviewExecutorConfig = resolvePhaseExecutor(config, config.phases.planReview);
			const reviewExecutor = createWorkExecutor(
				reviewExecutorConfig.provider,
				reviewExecutorConfig.model,
				{ mcpServers: config.mcpServers, tools: [] },
				workspaceDir,
			);
			const reviewer = createPlanReviewer(reviewExecutor);
			// Plan review/revision is intentionally sequential because each iteration depends on prior feedback.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const review = await reviewer.review(
				assemblePrompt({
					phase: 'plan-review',
					phaseInstructions: config.phases.planReview.instructions,
					taskPrompt: initialState.config.prompt,
					repo: initialState.config.repo,
					context: initialState.config.context,
					repoSummary,
					plan: currentPlan,
					skills: config.phases.planReview.skills,
				}),
			);

			eventRecorder.emit(taskId, {
				event: 'review-result',
				phase: 'plan-review',
				approved: review.approved,
				summary: review.summary,
				loop,
			});
			eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'plan-review' });

			if (review.approved) {
				break;
			}

			if (loop === initialState.config.effectiveConfig.phases.plan.maxReviewLoops) {
				eventRecorder.recordTaskFailure(taskId, 'Plan review loop exhausted');
				return;
			}

			// Planner revisions must reuse the same thread in order, so these cannot run concurrently.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const revised = await planner.revise(
				assemblePrompt({
					phase: 'plan',
					taskPrompt: initialState.config.prompt,
					failureContext: `Plan review feedback:\n\n${review.summary}`,
					skills: config.phases.plan.skills,
					repoSummary,
				}),
			);
			currentPlan = revised.plan;
			eventRecorder.emit(taskId, {
				event: 'plan-created',
				plan: currentPlan,
				threadId: revised.threadId,
			});
			eventRecorder.emit(taskId, {
				event: 'phase-completed',
				phase: 'plan',
				tokenCount: revised.tokenCount,
			});
		}

		if (eventRecorder.isClosed(taskId)) return;

		eventRecorder.emit(taskId, { event: 'phase-started', phase: 'work' });
		const workExecutorConfig = resolvePhaseExecutor(config, config.phases.work);
		const workExecutor = createWorkExecutor(
			workExecutorConfig.provider,
			workExecutorConfig.model,
			{ mcpServers: config.mcpServers, tools: [] },
			workspaceDir,
		);
		const workResult = await workExecutor.execute(
			assemblePrompt({
				phase: 'work',
				phaseInstructions: config.phases.work.instructions,
				taskPrompt: initialState.config.prompt,
				repo: initialState.config.repo,
				context: initialState.config.context,
				repoSummary,
				plan: currentPlan,
				skills: config.phases.work.skills,
			}),
		);
		eventRecorder.emit(taskId, {
			event: 'work-started',
			threadId: workResult.threadId,
		});
		eventRecorder.emit(taskId, {
			event: 'phase-completed',
			phase: 'work',
			tokenCount: workResult.tokenCount,
		});

		for (
			let verifyAttempt = 1;
			verifyAttempt <= initialState.config.effectiveConfig.phases.work.maxVerificationRetries;
			verifyAttempt += 1
		) {
			if (eventRecorder.isClosed(taskId)) return;

			eventRecorder.emit(taskId, { event: 'phase-started', phase: 'verification' });
			// Verification attempts are a serial fix-and-retry loop by design.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const verifyResults = await runVerification({
				commands: config.verification,
				cwd: workspaceDir,
				timeoutMs: config.verificationTimeoutMs,
			});
			eventRecorder.emit(taskId, {
				event: 'verification-result',
				results: [...verifyResults],
			});
			eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'verification' });

			if (allVerificationsPassed(verifyResults)) {
				break;
			}

			if (
				verifyAttempt === initialState.config.effectiveConfig.phases.work.maxVerificationRetries
			) {
				eventRecorder.recordTaskFailure(
					taskId,
					`Verification failed after ${verifyAttempt} attempts`,
				);
				return;
			}

			// Each fix continues the same work thread after a failed verification attempt.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const fixResult = await workExecutor.fix(
				assemblePrompt({
					phase: 'work',
					taskPrompt: initialState.config.prompt,
					failureContext: buildVerificationFailureSummary(verifyResults),
					skills: config.phases.work.skills,
					repoSummary,
				}),
			);
			eventRecorder.emit(taskId, { event: 'fix-applied', tokenCount: fixResult.tokenCount });
		}

		for (
			let reviewLoop = 1;
			reviewLoop <= initialState.config.effectiveConfig.phases.work.maxReviewLoops;
			reviewLoop += 1
		) {
			if (eventRecorder.isClosed(taskId)) return;

			eventRecorder.emit(taskId, {
				event: 'phase-started',
				phase: 'work-review',
				loop: reviewLoop,
			});

			const workReviewExecutorConfig = resolvePhaseExecutor(config, config.phases.workReview);
			const workReviewExecutor = createWorkExecutor(
				workReviewExecutorConfig.provider,
				workReviewExecutorConfig.model,
				{ mcpServers: config.mcpServers, tools: [] },
				workspaceDir,
			);

			// Review iterations are serial because each loop may patch the same work tree and thread.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const diff = await getDiff(workspaceDir).catch(() => '');
			// Review is gated on the current diff, so it must run after the diff is captured for this loop.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const workReviewResult = await reviewWork(workReviewExecutor, {
				reviewPrompt: assemblePrompt({
					phase: 'work-review',
					phaseInstructions: config.phases.workReview.instructions,
					taskPrompt: initialState.config.prompt,
					repo: initialState.config.repo,
					repoSummary,
					plan: currentPlan,
					failureContext: diff ? `Current diff:\n${diff}` : null,
					skills: config.phases.workReview.skills,
				}),
				verificationOptions: {
					commands: config.verification,
					cwd: workspaceDir,
					timeoutMs: config.verificationTimeoutMs,
				},
			});

			eventRecorder.emit(taskId, {
				event: 'review-result',
				phase: 'work-review',
				approved: workReviewResult.review?.approved ?? false,
				summary: workReviewResult.review?.summary ?? 'Verification failed before review.',
				loop: reviewLoop,
			});
			eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'work-review' });

			if (workReviewResult.review?.approved) {
				break;
			}

			if (reviewLoop === initialState.config.effectiveConfig.phases.work.maxReviewLoops) {
				eventRecorder.recordTaskFailure(taskId, 'Work review loop exhausted');
				return;
			}

			// Follow-up fixes must happen in sequence on the same executor thread.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const fixResult = await workExecutor.fix(
				assemblePrompt({
					phase: 'work',
					taskPrompt: initialState.config.prompt,
					failureContext: `Work review feedback:\n\n${workReviewResult.review?.summary ?? 'Verification failed.'}`,
					skills: config.phases.work.skills,
					repoSummary,
				}),
			);
			eventRecorder.emit(taskId, { event: 'fix-applied', tokenCount: fixResult.tokenCount });
		}

		if (eventRecorder.isClosed(taskId)) return;

		eventRecorder.emit(taskId, { event: 'phase-started', phase: 'wrapup' });
		const wrapupRegistry = buildWrapupTools({
			config,
			taskId,
			taskPrompt: initialState.config.prompt,
			plan: currentPlan,
			repo: initialState.config.repo,
		});
		const wrapupExecutorConfig = resolvePhaseExecutor(config, config.phases.wrapup);
		const wrapupExecutor = createWorkExecutor(
			wrapupExecutorConfig.provider,
			wrapupExecutorConfig.model,
			{ mcpServers: config.mcpServers, tools: wrapupRegistry.tools },
			workspaceDir,
		);
		const wrapupResult = await wrapupExecutor.execute(
			assemblePrompt({
				phase: 'wrapup',
				phaseInstructions: config.phases.wrapup.instructions,
				taskPrompt: initialState.config.prompt,
				repo: initialState.config.repo,
				repoSummary,
				plan: currentPlan,
				skills: config.phases.wrapup.skills,
			}),
		);

		const actionResults = wrapupRegistry.getResults();
		eventRecorder.emit(taskId, { event: 'wrapup-result', actions: [...actionResults] });

		const missing = findMissingRequiredActions(getWrapupActionConfigs(config), actionResults);
		if (missing.length > 0) {
			eventRecorder.recordTaskFailure(
				taskId,
				`Required wrapup actions not completed: ${missing.join(', ')}`,
			);
			return;
		}

		eventRecorder.emit(taskId, {
			event: 'phase-completed',
			phase: 'wrapup',
			tokenCount: wrapupResult.tokenCount,
		});
		eventRecorder.emit(taskId, { event: 'task-completed' });
	} catch (error) {
		const reason = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));

		try {
			eventRecorder.recordTaskFailure(taskId, reason);
		} catch {
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

			const taskId = input.taskId;
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
