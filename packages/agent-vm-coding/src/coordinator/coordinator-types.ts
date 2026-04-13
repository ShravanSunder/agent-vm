import type { CodeReviewerAgent } from '../agents/code-reviewer/code-reviewer-agent.js';
import type { CoderAgent } from '../agents/coder/coder-agent.js';
import type { PlanReviewerAgent } from '../agents/plan-reviewer/plan-reviewer-agent.js';
import type { PlannerAgent } from '../agents/planner/planner-agent.js';
import type { CodingGatewayConfig } from '../config.js';
import type { TaskState } from '../state/task-state.js';

export interface CreateTaskInput {
	readonly prompt: string;
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly testCommand: string;
	readonly lintCommand: string;
}

export interface Coordinator {
	submitTask(input: CreateTaskInput): Promise<{ taskId: string; status: 'accepted' }>;
	getActiveTaskId(): string | null;
	getTaskState(taskId: string): TaskState | undefined;
	submitFollowup(taskId: string, prompt: string): Promise<{ status: 'accepted' }>;
	closeTask(taskId: string): Promise<{ status: 'closed' }>;
}

export interface CoordinatorDeps {
	readonly plannerAgent: PlannerAgent;
	readonly planReviewerAgent: PlanReviewerAgent;
	readonly coderAgent: CoderAgent;
	readonly codeReviewerAgent: CodeReviewerAgent;
	readonly config: CodingGatewayConfig;
	readonly workspaceDir?: string;
}
