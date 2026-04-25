import { join } from 'node:path';

import { execa } from 'execa';

import { resolvePhaseExecutor, type WorkerConfig } from '../config/worker-config.js';
import { gatherContext } from '../context/gather-context.js';
import { getDiff } from '../git/git-operations.js';
import { runPlanCycle } from '../plan-phase/plan-cycle.js';
import { buildRoleSystemPrompt } from '../prompt/prompt-assembler.js';
import { writeStderr } from '../shared/stderr.js';
import type { VerificationCommandResult } from '../state/task-event-types.js';
import type { TaskState } from '../state/task-state.js';
import { createWorkExecutor } from '../work-executor/executor-factory.js';
import {
	createPersistentThread,
	type PersistentThread,
} from '../work-executor/persistent-thread.js';
import { createGitPullDefaultTool } from '../work-phase/controller-tools/git-pull-default-tool.js';
import { createGitPushTool } from '../work-phase/controller-tools/git-push-tool.js';
import { buildValidationTool } from '../work-phase/validation-tool.js';
import { runWorkCycle } from '../work-phase/work-cycle.js';
import { runWrapup } from '../wrapup-phase/wrapup-runner.js';
import type { TaskEventRecorder } from './coordinator-helpers.js';
import { sanitizeErrorMessage } from './coordinator-helpers.js';
import type { CoordinatorDeps } from './coordinator-types.js';

class TaskClosedError extends Error {
	constructor(taskId: string) {
		super(`Task ${taskId} was closed.`);
	}
}

function getPrimaryRepoWorkspace(
	config: { readonly repos: readonly { readonly workspacePath: string }[] },
	workspaceRoot: string,
): string {
	return config.repos[0]?.workspacePath ?? workspaceRoot;
}

function throwIfClosed(taskId: string, eventRecorder: TaskEventRecorder): void {
	if (eventRecorder.isClosed(taskId)) {
		throw new TaskClosedError(taskId);
	}
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
	const result = await execa('git', [...args], {
		cwd,
		reject: false,
		timeout: 10_000,
	});
	if ((result.exitCode ?? 0) !== 0) {
		return `${result.stdout}\n${result.stderr}`.trim();
	}
	return result.stdout.trim();
}

async function buildWrapupGitContext(cwd: string, defaultBranch: string): Promise<string> {
	const currentBranch = await gitOutput(cwd, ['branch', '--show-current']);
	const status = await gitOutput(cwd, ['status', '--short']);
	const defaultRef = `origin/${defaultBranch}`;
	const log = await gitOutput(cwd, ['log', '--oneline', `${defaultRef}..HEAD`]);
	const diffStat = await gitOutput(cwd, ['diff', '--stat', `${defaultRef}...HEAD`]);
	return [
		`Current branch: ${currentBranch || '(detached)'}`,
		`Default branch: ${defaultBranch}`,
		`git status --short:\n${status || '(clean)'}`,
		`git log ${defaultRef}..HEAD:\n${log || '(no branch commits)'}`,
		`git diff --stat ${defaultRef}...HEAD:\n${diffStat || '(no diff)'}`,
	].join('\n\n');
}

function buildWorkSummaryRequest(props: {
	readonly spec: string;
	readonly plan: string;
	readonly validationResults: readonly VerificationCommandResult[];
	readonly validationSkipped: boolean;
}): string {
	return [
		'You are still the WORK agent. Do not edit files, do not commit, and do not call tools in this turn.',
		'Summarize in detail the work you completed for handoff to a separate wrapup agent.',
		'Return JSON only with this shape:',
		'{ "summary": "...", "filesChanged": [], "commits": [], "validation": "...", "reviewNotes": "...", "knownRisks": [], "suggestedPrTitle": "...", "suggestedPrBody": "..." }',
		`Original task:\n${props.spec}`,
		`Final plan:\n${props.plan}`,
		`Validation results:\n${JSON.stringify(props.validationResults, null, 2)}`,
		`Validation skipped: ${String(props.validationSkipped)}`,
	].join('\n\n');
}

function createThreadForPhase(props: {
	readonly config: WorkerConfig;
	readonly phase: { readonly provider?: string | undefined; readonly model?: string | undefined };
	readonly tools: Parameters<typeof createWorkExecutor>[2]['tools'];
	readonly cwd: string;
	readonly turnTimeoutMs: number;
}): PersistentThread {
	const executorConfig = resolvePhaseExecutor(props.config, props.phase);
	const executor = createWorkExecutor(
		executorConfig.provider,
		executorConfig.model,
		{ mcpServers: props.config.mcpServers, tools: props.tools },
		props.cwd,
		executorConfig.reasoningEffort,
	);
	return createPersistentThread({ executor, turnTimeoutMs: props.turnTimeoutMs });
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
		const taskConfig = initialState.config;
		const controllerBaseUrl = process.env.CONTROLLER_BASE_URL ?? 'http://controller.vm.host:18800';
		const zoneId = process.env.AGENT_VM_ZONE_ID ?? 'unknown-zone';
		const primaryWorkspaceDir = getPrimaryRepoWorkspace(taskConfig, workspaceDir);
		const taskLogsDir = join(config.stateDir, 'tasks', taskId, 'logs');

		let repoSummary: string | null = null;
		try {
			const repoContext = await gatherContext(workspaceDir);
			repoSummary = repoContext.summary;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await eventRecorder.emit(taskId, { event: 'context-gather-failed', reason: message });
			writeStderr(`[coordinator] Failed to gather repo context for task ${taskId}: ${message}`);
		}

		await eventRecorder.emit(taskId, { event: 'phase-started', phase: 'plan' });
		const planAgentSystem = await buildRoleSystemPrompt({
			role: 'plan-agent',
			baseInstructionsOverride: config.instructions ?? null,
			roleInstructionsOverride: config.phases.plan.agentInstructions,
			branchPrefix: config.branchPrefix,
			skills: config.phases.plan.skills,
		});
		const planReviewerSystem = await buildRoleSystemPrompt({
			role: 'plan-reviewer',
			baseInstructionsOverride: config.instructions ?? null,
			roleInstructionsOverride: config.phases.plan.reviewerInstructions,
			branchPrefix: config.branchPrefix,
			skills: config.phases.plan.skills,
		});
		const planThread = createThreadForPhase({
			config,
			phase: config.phases.plan,
			tools: [],
			cwd: primaryWorkspaceDir,
			turnTimeoutMs: config.phases.plan.agentTurnTimeoutMs,
		});
		const planReviewThread = createThreadForPhase({
			config,
			phase: config.phases.plan,
			tools: [],
			cwd: primaryWorkspaceDir,
			turnTimeoutMs: config.phases.plan.reviewerTurnTimeoutMs,
		});
		const planResult = await runPlanCycle({
			spec: taskConfig.prompt,
			repos: taskConfig.repos,
			repoSummary,
			context: taskConfig.context,
			cycle: config.phases.plan.cycle,
			planThread,
			reviewThread: config.phases.plan.cycle.kind === 'review' ? planReviewThread : null,
			systemPromptPlanAgent: planAgentSystem,
			systemPromptPlanReviewer:
				config.phases.plan.cycle.kind === 'review' ? planReviewerSystem : null,
			isClosed: () => eventRecorder.isClosed(taskId),
			onPlanAgentTurn: async (cycle, result) => {
				await eventRecorder.emit(taskId, {
					event: 'plan-agent-turn',
					cycle,
					threadId: result.threadId,
					tokenCount: result.tokenCount,
				});
				throwIfClosed(taskId, eventRecorder);
			},
			onPlanReviewerTurn: async (cycle, result, review) => {
				await eventRecorder.emit(taskId, {
					event: 'plan-reviewer-turn',
					cycle,
					threadId: result.threadId,
					tokenCount: result.tokenCount,
					review,
				});
				throwIfClosed(taskId, eventRecorder);
			},
		});
		await eventRecorder.emit(taskId, { event: 'plan-finalized', plan: planResult.plan });
		await eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'plan' });

		if (eventRecorder.isClosed(taskId)) return;

		await eventRecorder.emit(taskId, { event: 'phase-started', phase: 'work' });
		const validationTool = buildValidationTool({
			commands: config.verification,
			cwd: primaryWorkspaceDir,
			timeoutMs: config.verificationTimeoutMs,
			rawLogDir: taskLogsDir,
			attemptLabelPrefix: 'verify',
		});
		const controllerTools = [
			createGitPushTool({
				controllerBaseUrl,
				zoneId,
				taskId,
				repos: taskConfig.repos,
			}),
			createGitPullDefaultTool({
				controllerBaseUrl,
				zoneId,
				taskId,
				repos: taskConfig.repos,
			}),
		];
		const workAgentSystem = await buildRoleSystemPrompt({
			role: 'work-agent',
			baseInstructionsOverride: config.instructions ?? null,
			roleInstructionsOverride: config.phases.work.agentInstructions,
			branchPrefix: config.branchPrefix,
			skills: config.phases.work.skills,
		});
		const workReviewerSystem = await buildRoleSystemPrompt({
			role: 'work-reviewer',
			baseInstructionsOverride: config.instructions ?? null,
			roleInstructionsOverride: config.phases.work.reviewerInstructions,
			branchPrefix: config.branchPrefix,
			skills: config.phases.work.skills,
		});
		const workThread = createThreadForPhase({
			config,
			phase: config.phases.work,
			tools: [validationTool, ...controllerTools],
			cwd: primaryWorkspaceDir,
			turnTimeoutMs: config.phases.work.agentTurnTimeoutMs,
		});
		const workReviewThread = createThreadForPhase({
			config,
			phase: config.phases.work,
			tools: [validationTool],
			cwd: primaryWorkspaceDir,
			turnTimeoutMs: config.phases.work.reviewerTurnTimeoutMs,
		});
		const workResult = await runWorkCycle({
			spec: taskConfig.prompt,
			plan: planResult.plan,
			planReview: planResult.review,
			validationCommandList: config.verification,
			cycle: config.phases.work.cycle,
			workThread,
			reviewThread: workReviewThread,
			systemPromptWorkAgent: workAgentSystem,
			systemPromptWorkReviewer: workReviewerSystem,
			getDiff: async () => await getDiff(primaryWorkspaceDir),
			isClosed: () => eventRecorder.isClosed(taskId),
			onWorkAgentTurn: async (cycle, result) => {
				await eventRecorder.emit(taskId, {
					event: 'work-agent-turn',
					cycle,
					threadId: result.threadId,
					tokenCount: result.tokenCount,
				});
				throwIfClosed(taskId, eventRecorder);
			},
			onWorkReviewerTurn: async (cycle, result, review, validationResults, validationSkipped) => {
				await eventRecorder.emit(taskId, {
					event: 'work-reviewer-turn',
					cycle,
					threadId: result.threadId,
					tokenCount: result.tokenCount,
					review,
					validationResults: [...validationResults],
					validationSkipped,
				});
				throwIfClosed(taskId, eventRecorder);
			},
		});
		const workSummaryResult = await workThread.send(
			buildWorkSummaryRequest({
				spec: taskConfig.prompt,
				plan: planResult.plan,
				validationResults: workResult.validationResults,
				validationSkipped: workResult.validationSkipped,
			}),
		);
		await eventRecorder.emit(taskId, {
			event: 'work-agent-turn',
			cycle: config.phases.work.cycle.cycleCount + 1,
			threadId: workSummaryResult.threadId,
			tokenCount: workSummaryResult.tokenCount,
		});
		await eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'work' });

		if (eventRecorder.isClosed(taskId)) return;

		await eventRecorder.emit(taskId, { event: 'phase-started', phase: 'wrapup' });
		const wrapupSystem = await buildRoleSystemPrompt({
			role: 'wrapup',
			baseInstructionsOverride: config.instructions ?? null,
			roleInstructionsOverride: config.phases.wrapup.instructions,
			branchPrefix: config.branchPrefix,
			skills: config.phases.wrapup.skills,
		});
		const wrapupThread = createThreadForPhase({
			config,
			phase: config.phases.wrapup,
			tools: controllerTools,
			cwd: primaryWorkspaceDir,
			turnTimeoutMs: config.phases.wrapup.turnTimeoutMs,
		});
		const wrapupResult = await runWrapup({
			wrapupThread,
			systemPromptWrapup: wrapupSystem,
			spec: taskConfig.prompt,
			plan: planResult.plan,
			workSummary: workSummaryResult.response,
			gitContext: await buildWrapupGitContext(
				primaryWorkspaceDir,
				taskConfig.repos[0]?.baseBranch ?? 'main',
			),
			validationResults: workResult.validationResults,
			validationSkipped: workResult.validationSkipped,
			onWrapupTurn: async (result) => {
				await eventRecorder.emit(taskId, {
					event: 'wrapup-turn',
					threadId: result.threadId,
					tokenCount: result.tokenCount,
				});
				throwIfClosed(taskId, eventRecorder);
			},
		});
		await eventRecorder.emit(taskId, {
			event: 'wrapup-result',
			prUrl: wrapupResult.prUrl ?? null,
			branchName: wrapupResult.branchName ?? null,
			pushedCommits: [...wrapupResult.pushedCommits],
		});
		await eventRecorder.emit(taskId, { event: 'phase-completed', phase: 'wrapup' });
		await eventRecorder.emit(taskId, { event: 'task-completed' });
	} catch (error) {
		if (error instanceof TaskClosedError) {
			return;
		}
		const reason = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
		await eventRecorder.recordTaskFailure(taskId, reason);
	} finally {
		onTaskFinished();
	}
}
