import type { CoderAgent } from "../../agents/coder/coder-agent.js";
import type { CodeReviewerAgent } from "../../agents/code-reviewer/code-reviewer-agent.js";
import type { PlannerAgent } from "../../agents/planner/planner-agent.js";
import type { PlanReviewerAgent } from "../../agents/plan-reviewer/plan-reviewer-agent.js";
import type { ReviewResult } from "../../agents/review-result.js";
import type { AgentRunResult, StructuredInput } from "../../agents/shared-types.js";
import type { Coordinator } from "../../coordinator/coordinator-types.js";

export interface MockPlannerAgent
  extends PlannerAgent {
  readonly planCalls: StructuredInput[][];
  readonly reviseCalls: StructuredInput[][];
}

export interface MockCoderAgent
  extends CoderAgent {
  readonly implementCalls: StructuredInput[][];
  readonly fixCalls: StructuredInput[][];
}

export interface MockReviewerAgent {
  readonly calls: StructuredInput[][];
}

export interface MockCoderCallbacks {
  readonly onImplement?: () => Promise<void> | void;
  readonly onFix?: () => Promise<void> | void;
  readonly onResumeOrRebuild?: (
    threadId: string | null,
    context: readonly StructuredInput[],
  ) => Promise<void> | void;
}

export function createAgentRunResult(
  response: string,
  threadId: string,
): AgentRunResult {
  return {
    response,
    tokenCount: 100,
    threadId,
  };
}

export function createPlannerAgent(
  options?: {
    readonly planResponse?: string;
    readonly revisedResponse?: string;
    readonly overrides?: Partial<PlannerAgent>;
  },
): MockPlannerAgent {
  const planCalls: StructuredInput[][] = [];
  const reviseCalls: StructuredInput[][] = [];
  const planResponse = options?.planResponse ?? "Plan v1";
  const revisedResponse = options?.revisedResponse ?? "Plan v2";

  return {
    async plan(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      planCalls.push([...input]);
      return createAgentRunResult(planResponse, "planner-thread-1");
    },
    async revise(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      reviseCalls.push([...input]);
      return createAgentRunResult(revisedResponse, "planner-thread-1");
    },
    getThreadId(): string | null {
      return "planner-thread-1";
    },
    planCalls,
    reviseCalls,
    ...options?.overrides,
  };
}

export function createPlanReviewer(
  responses: readonly ReviewResult[] = [
    { approved: true, comments: [], summary: "Looks good" },
  ],
): PlanReviewerAgent & MockReviewerAgent {
  const calls: StructuredInput[][] = [];
  let index = 0;

  return {
    async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
      calls.push([...input]);
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!response) {
        throw new Error("missing plan review response");
      }
      return response;
    },
    calls,
  };
}

export function createCoderAgent(
  options?: {
    readonly callbacks?: MockCoderCallbacks;
    readonly implementResponse?: string;
    readonly fixResponse?: string;
    readonly overrides?: Partial<CoderAgent>;
  },
): MockCoderAgent {
  const implementCalls: StructuredInput[][] = [];
  const fixCalls: StructuredInput[][] = [];
  let threadId: string | null = null;

  return {
    async implement(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      implementCalls.push([...input]);
      threadId = "coder-thread-1";
      await options?.callbacks?.onImplement?.();
      return createAgentRunResult(
        options?.implementResponse ?? "Implemented",
        threadId,
      );
    },
    async fix(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      fixCalls.push([...input]);
      await options?.callbacks?.onFix?.();
      return createAgentRunResult(
        options?.fixResponse ?? "Fixed",
        threadId ?? "coder-thread-1",
      );
    },
    async resumeOrRebuild(
      currentThreadId: string | null,
      context: readonly StructuredInput[],
    ): Promise<void> {
      await options?.callbacks?.onResumeOrRebuild?.(currentThreadId, context);
      threadId = "coder-thread-resumed";
    },
    getThreadId(): string | null {
      return threadId;
    },
    implementCalls,
    fixCalls,
    ...options?.overrides,
  };
}

export function createCodeReviewer(
  responses: readonly ReviewResult[] = [
    { approved: true, comments: [], summary: "Looks good" },
  ],
): CodeReviewerAgent & MockReviewerAgent {
  const calls: StructuredInput[][] = [];
  let index = 0;

  return {
    async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
      calls.push([...input]);
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!response) {
        throw new Error("missing code review response");
      }
      return response;
    },
    calls,
  };
}

export async function waitForStatus(
  coordinator: Coordinator,
  taskId: string,
  expectedStatus: string,
  timeoutMs: number = 5000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (coordinator.getTaskState(taskId)?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `Task ${taskId} did not reach ${expectedStatus}. Last status: ${coordinator.getTaskState(taskId)?.status ?? "unknown"}`,
  );
}
