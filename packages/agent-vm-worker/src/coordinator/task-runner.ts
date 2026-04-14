/* oxlint-disable eslint/no-await-in-loop -- coordinator phases are intentionally sequential and stateful */
import { resolvePhaseExecutor } from '../config/worker-config.js';
import { gatherContext } from '../context/gather-context.js';
import { getDiff } from '../git/git-operations.js';
import { createPlanReviewer } from '../planner/plan-reviewer.js';
import { createPlanner } from '../planner/planner.js';
import { assemblePrompt } from '../prompt/prompt-assembler.js';
import { writeStderr } from '../shared/stderr.js';
import type { TaskState } from '../state/task-state.js';
import { createWorkExecutor } from '../work-executor/executor-factory.js';
import {
	allVerificationsPassed,
	buildVerificationFailureSummary,
	runVerification,
} from '../work-reviewer/verification-runner.js';
import { reviewWork } from '../work-reviewer/work-reviewer.js';
import { buildWrapupTools, getWrapupActionConfigs } from '../wrapup/wrapup-action-registry.js';
import { findMissingRequiredActions } from '../wrapup/wrapup-types.js';
import type { TaskEventRecorder } from './coordinator-helpers.js';
import { sanitizeErrorMessage } from './coordinator-helpers.js';
import type { CoordinatorDeps } from './coordinator-types.js';

function getPrimaryRepoWorkspace(
	config: { readonly repos: readonly { readonly workspacePath: string }[] },
	workspaceRoot: string,
): string {
	return config.repos[0]?.workspacePath ?? workspaceRoot;
}

export async function runTask(
	taskId: string,
	deps: CoordinatorDeps,
	workspaceDir: string,
	tasks: Map<string, TaskState>,
	eventRecorder: TaskEventRecorder,
	onTaskFinished: () => void,
): Promise<void> {
	try {
		const initialState = tasks.get(taskId);
		if (!initialState || eventRecorder.isClosed(taskId)) {
			return;
		}

		const config = deps.config;
		const primaryWorkspaceDir = getPrimaryRepoWorkspace(initialState.config, workspaceDir);
		let latestWorkOutput: string | null = null;
		let repoSummary: string | null = null;
		try {
			const repoContext = await gatherContext(workspaceDir);
			repoSummary = repoContext.summary;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await eventRecorder.emit(taskId, { event: 'context-gather-failed', reason: message });
			writeStderr(`[coordinator] Failed to gather repo context for task ${taskId}: ${message}`);
			repoSummary = null;
		}

		await eventRecorder.emit(taskId, { event: 'phase-started', phase: 'plan' });

		const planExecutorConfig = resolvePhaseExecutor(config, config.phases.plan);
		const planExecutor = createWorkExecutor(
			planExecutorConfig.provider,
			planExecutorConfig.model,
			{ mcpServers: config.mcpServers, tools: [] },
			primaryWorkspaceDir,
		);
		const planner = createPlanner(planExecutor);

		const planResult = await planner.plan(
			await assemblePrompt({
				phase: 'plan',
				phaseInstructions: config.phases.plan.instructions,
				taskPrompt: initialState.config.prompt,
				repos: initialState.config.repos,
				context: initialState.config.context,
				repoSummary,
				skills: config.phases.plan.skills,
			}),
		);
		let currentPlan = planResult.plan;

		await eventRecorder.emit(taskId, {
			event: 'plan-created',
			plan: currentPlan,
			threadId: planResult.threadId,
		});
		await eventRecorder.emit(taskId, {
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

			await eventRecorder.emit(taskId, {
				event: 'phase-started',
				phase: 'plan-review',
				loop,
			});

			const reviewExecutorConfig = resolvePhaseExecutor(config, config.phases.planReview);
			const reviewExecutor = createWorkExecutor(
				reviewExecutorConfig.provider,
				reviewExecutorConfig.model,
				{ mcpServers: config.mcpServers, tools: [] },
				primaryWorkspaceDir,
			);
			const reviewer = createPlanReviewer(reviewExecutor);
			const review = await reviewer.review(
				await assemblePrompt({
					phase: 'plan-review',
					phaseInstructions: config.phases.planReview.instructions,
					taskPrompt: initialState.config.prompt,
					repos: initialState.config.repos,
					context: initialState.config.context,
					repoSummary,
					plan: currentPlan,
					skills: config.phases.planReview.skills,
				}),
			);

			await eventRecorder.emit(taskId, {
				event: 'review-result',
				phase: 'plan-review',
				approved: review.approved,
				summary: review.summary,
				loop,
			});
			await eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'plan-review' });

			if (review.approved) {
				break;
			}

			if (loop === initialState.config.effectiveConfig.phases.plan.maxReviewLoops) {
				await eventRecorder.recordTaskFailure(taskId, 'Plan review loop exhausted');
				return;
			}

			const revised = await planner.revise(
				await assemblePrompt({
					phase: 'plan',
					taskPrompt: initialState.config.prompt,
					failureContext: `Plan review feedback:\n\n${review.summary}`,
					skills: config.phases.plan.skills,
					repoSummary,
				}),
			);
			currentPlan = revised.plan;
			await eventRecorder.emit(taskId, {
				event: 'plan-created',
				plan: currentPlan,
				threadId: revised.threadId,
			});
			await eventRecorder.emit(taskId, {
				event: 'phase-completed',
				phase: 'plan',
				tokenCount: revised.tokenCount,
			});
		}

		if (eventRecorder.isClosed(taskId)) return;

		await eventRecorder.emit(taskId, { event: 'phase-started', phase: 'work' });
		const workExecutorConfig = resolvePhaseExecutor(config, config.phases.work);
		const workExecutor = createWorkExecutor(
			workExecutorConfig.provider,
			workExecutorConfig.model,
			{ mcpServers: config.mcpServers, tools: [] },
			primaryWorkspaceDir,
		);
		const workResult = await workExecutor.execute(
			await assemblePrompt({
				phase: 'work',
				phaseInstructions: config.phases.work.instructions,
				taskPrompt: initialState.config.prompt,
				repos: initialState.config.repos,
				context: initialState.config.context,
				repoSummary,
				plan: currentPlan,
				skills: config.phases.work.skills,
			}),
		);
		latestWorkOutput = workResult.response;
		await eventRecorder.emit(taskId, {
			event: 'work-started',
			threadId: workResult.threadId,
		});
		await eventRecorder.emit(taskId, {
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

			await eventRecorder.emit(taskId, { event: 'phase-started', phase: 'verification' });
			const verifyResults = await runVerification({
				commands: config.verification,
				cwd: primaryWorkspaceDir,
				timeoutMs: config.verificationTimeoutMs,
			});
			await eventRecorder.emit(taskId, {
				event: 'verification-result',
				results: [...verifyResults],
			});
			await eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'verification' });

			if (allVerificationsPassed(verifyResults)) {
				break;
			}

			if (
				verifyAttempt === initialState.config.effectiveConfig.phases.work.maxVerificationRetries
			) {
				await eventRecorder.recordTaskFailure(
					taskId,
					`Verification failed after ${verifyAttempt} attempts`,
				);
				return;
			}

			const fixResult = await workExecutor.fix(
				await assemblePrompt({
					phase: 'work',
					taskPrompt: initialState.config.prompt,
					failureContext: buildVerificationFailureSummary(verifyResults),
					skills: config.phases.work.skills,
					repoSummary,
				}),
			);
			latestWorkOutput = fixResult.response;
			await eventRecorder.emit(taskId, { event: 'fix-applied', tokenCount: fixResult.tokenCount });
		}

		for (
			let reviewLoop = 1;
			reviewLoop <= initialState.config.effectiveConfig.phases.work.maxReviewLoops;
			reviewLoop += 1
		) {
			if (eventRecorder.isClosed(taskId)) return;

			await eventRecorder.emit(taskId, {
				event: 'phase-started',
				phase: 'work-review',
				loop: reviewLoop,
			});

			const workReviewExecutorConfig = resolvePhaseExecutor(config, config.phases.workReview);
			const workReviewExecutor = createWorkExecutor(
				workReviewExecutorConfig.provider,
				workReviewExecutorConfig.model,
				{ mcpServers: config.mcpServers, tools: [] },
				primaryWorkspaceDir,
			);

			let diff = '';
			try {
				diff = await getDiff(primaryWorkspaceDir);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await eventRecorder.emit(taskId, {
					event: 'diff-read-failed',
					reason: message,
					loop: reviewLoop,
				});
				writeStderr(`[coordinator] Failed to read diff for task ${taskId}: ${message}`);
				diff = '';
			}

			const workReviewResult = await reviewWork(workReviewExecutor, {
				reviewPrompt: await assemblePrompt({
					phase: 'work-review',
					phaseInstructions: config.phases.workReview.instructions,
					taskPrompt: initialState.config.prompt,
					repos: initialState.config.repos,
					repoSummary,
					plan: currentPlan,
					failureContext: diff ? `Current diff:\n${diff}` : null,
					skills: config.phases.workReview.skills,
				}),
				verificationOptions: {
					commands: config.verification,
					cwd: primaryWorkspaceDir,
					timeoutMs: config.verificationTimeoutMs,
				},
			});

			await eventRecorder.emit(taskId, {
				event: 'review-result',
				phase: 'work-review',
				approved: workReviewResult.review?.approved ?? false,
				summary: workReviewResult.review?.summary ?? 'Verification failed before review.',
				loop: reviewLoop,
			});
			await eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'work-review' });

			if (workReviewResult.review?.approved) {
				break;
			}

			if (reviewLoop === initialState.config.effectiveConfig.phases.work.maxReviewLoops) {
				await eventRecorder.recordTaskFailure(taskId, 'Work review loop exhausted');
				return;
			}

			const fixResult = await workExecutor.fix(
				await assemblePrompt({
					phase: 'work',
					taskPrompt: initialState.config.prompt,
					failureContext: `Work review feedback:\n\n${workReviewResult.review?.summary ?? 'Verification failed.'}`,
					skills: config.phases.work.skills,
					repoSummary,
				}),
			);
			await eventRecorder.emit(taskId, { event: 'fix-applied', tokenCount: fixResult.tokenCount });
		}

		if (eventRecorder.isClosed(taskId)) return;

		await eventRecorder.emit(taskId, { event: 'phase-started', phase: 'wrapup' });
		const wrapupRegistry = buildWrapupTools({
			config,
			taskId,
			taskPrompt: initialState.config.prompt,
			plan: currentPlan,
			repos: initialState.config.repos,
		});
		const wrapupExecutorConfig = resolvePhaseExecutor(config, config.phases.wrapup);
		const wrapupExecutor = createWorkExecutor(
			wrapupExecutorConfig.provider,
			wrapupExecutorConfig.model,
			{ mcpServers: config.mcpServers, tools: wrapupRegistry.tools },
			primaryWorkspaceDir,
		);
		const wrapupResult = await wrapupExecutor.execute(
			await assemblePrompt({
				phase: 'wrapup',
				phaseInstructions: config.phases.wrapup.instructions,
				taskPrompt: initialState.config.prompt,
				repos: initialState.config.repos,
				repoSummary,
				plan: currentPlan,
				extraContext: [
					latestWorkOutput ? `Work output:\n${latestWorkOutput}` : null,
					initialState.config.effectiveConfig.wrapupActions.length > 0
						? `Configured wrapup actions:\n${initialState.config.effectiveConfig.wrapupActions
								.map(
									(action, index) =>
										`- ${action.type}:${index} (${'required' in action && action.required ? 'required' : 'optional'})`,
								)
								.join('\n')}`
						: 'Configured wrapup actions: none',
					tasks.get(taskId)?.lastVerificationResults
						? `Verification results:\n${tasks
								.get(taskId)
								?.lastVerificationResults?.map(
									(result) =>
										`- ${result.name}: ${result.passed ? 'passed' : 'failed'} (exit ${result.exitCode})`,
								)
								.join('\n')}`
						: null,
				]
					.filter((value): value is string => value !== null)
					.join('\n\n'),
				skills: config.phases.wrapup.skills,
			}),
		);

		const actionResults = wrapupRegistry.getResults();
		await eventRecorder.emit(taskId, { event: 'wrapup-result', actions: [...actionResults] });

		const missing = findMissingRequiredActions(getWrapupActionConfigs(config), actionResults);
		if (missing.length > 0) {
			await eventRecorder.recordTaskFailure(
				taskId,
				`Required wrapup actions not completed: ${missing.join(', ')}`,
			);
			return;
		}

		await eventRecorder.emit(taskId, {
			event: 'phase-completed',
			phase: 'wrapup',
			tokenCount: wrapupResult.tokenCount,
		});
		await eventRecorder.emit(taskId, { event: 'task-completed' });
	} catch (error) {
		const reason = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
		await eventRecorder.recordTaskFailure(taskId, reason);
	} finally {
		onTaskFinished();
	}
}
