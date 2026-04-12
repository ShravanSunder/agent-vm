import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CoderAgent } from "../agents/coder/coder-agent.js";
import type { CodeReviewerAgent } from "../agents/code-reviewer/code-reviewer-agent.js";
import type { PlannerAgent } from "../agents/planner/planner-agent.js";
import type { PlanReviewerAgent } from "../agents/plan-reviewer/plan-reviewer-agent.js";
import type { ReviewResult } from "../agents/review-result.js";
import type { AgentRunResult, StructuredInput } from "../agents/shared-types.js";
import type { CodingGatewayConfig } from "../config.js";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  gatherTaskContext: vi.fn(),
  setupGitForTask: vi.fn(),
  shipTask: vi.fn(),
  getDiff: vi.fn(),
  getDiffStat: vi.fn(),
}));

vi.mock("../verification.js", () => ({
  verify: mocks.verify,
}));

vi.mock("./task-setup.js", () => ({
  gatherTaskContext: mocks.gatherTaskContext,
  setupGitForTask: mocks.setupGitForTask,
}));

vi.mock("./task-ship.js", () => ({
  shipTask: mocks.shipTask,
}));

vi.mock("../git/git-operations.js", () => ({
  getDiff: mocks.getDiff,
  getDiffStat: mocks.getDiffStat,
}));

import { createCoordinator } from "./coordinator.js";

function createAgentRunResult(
  response: string,
  threadId: string,
): AgentRunResult {
  return {
    response,
    tokenCount: 100,
    threadId,
  };
}

function createConfig(stateDir: string): CodingGatewayConfig {
  return {
    model: "gpt-5.4-mini",
    reviewModel: "gpt-5.4-mini",
    plannerSkills: ["writing-plans", "brainstorming"],
    planReviewerSkills: ["generic-plan-review"],
    coderSkills: [
      "test-driven-development",
      "verification-before-completion",
    ],
    codeReviewerSkills: ["generic-code-review"],
    maxPlanReviewLoops: 2,
    maxCodeReviewLoops: 3,
    maxSanityRetries: 3,
    verificationTimeoutMs: 30_000,
    testCommand: "npm test",
    lintCommand: "npm run lint",
    branchPrefix: "agent/",
    commitCoAuthor: "agent-vm-coding <noreply@agent-vm>",
    idleTimeoutMs: 1_800_000,
    stateDir,
  };
}

function createPlannerAgent(
  overrides?: Partial<PlannerAgent>,
): PlannerAgent & {
  readonly planCalls: StructuredInput[][];
  readonly reviseCalls: StructuredInput[][];
} {
  const planCalls: StructuredInput[][] = [];
  const reviseCalls: StructuredInput[][] = [];

  return {
    async plan(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      planCalls.push([...input]);
      return createAgentRunResult("Plan v1", "planner-thread-1");
    },
    async revise(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      reviseCalls.push([...input]);
      return createAgentRunResult("Plan v2", "planner-thread-1");
    },
    getThreadId(): string | null {
      return "planner-thread-1";
    },
    planCalls,
    reviseCalls,
    ...overrides,
  };
}

function createPlanReviewerAgent(
  responses: readonly ReviewResult[],
): PlanReviewerAgent & { readonly calls: StructuredInput[][] } {
  const calls: StructuredInput[][] = [];
  let index = 0;

  return {
    async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
      calls.push([...input]);
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!response) {
        throw new Error("missing review response");
      }
      return response;
    },
    calls,
  };
}

function createCoderAgent(
  overrides?: Partial<CoderAgent>,
): CoderAgent & {
  readonly implementCalls: StructuredInput[][];
  readonly fixCalls: StructuredInput[][];
} {
  const implementCalls: StructuredInput[][] = [];
  const fixCalls: StructuredInput[][] = [];

  return {
    async implement(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      implementCalls.push([...input]);
      return createAgentRunResult("Implemented", "coder-thread-1");
    },
    async fix(input: readonly StructuredInput[]): Promise<AgentRunResult> {
      fixCalls.push([...input]);
      return createAgentRunResult("Fixed", "coder-thread-1");
    },
    async resumeOrRebuild(): Promise<void> {
      return;
    },
    getThreadId(): string | null {
      return "coder-thread-1";
    },
    implementCalls,
    fixCalls,
    ...overrides,
  };
}

function createCodeReviewerAgent(
  responses: readonly ReviewResult[],
): CodeReviewerAgent & { readonly calls: StructuredInput[][] } {
  const calls: StructuredInput[][] = [];
  let index = 0;

  return {
    async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
      calls.push([...input]);
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!response) {
        throw new Error("missing review response");
      }
      return response;
    },
    calls,
  };
}

async function waitForStatus(
  coordinator: ReturnType<typeof createCoordinator>,
  taskId: string,
  expectedStatus: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (coordinator.getTaskState(taskId)?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(
    `Task ${taskId} did not reach ${expectedStatus}. Last status: ${coordinator.getTaskState(taskId)?.status ?? "unknown"}`,
  );
}

describe("coordinator", () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coordinator-test-"));
    stateDir = join(tempDir, "state");
    await mkdir(stateDir, { recursive: true });

    mocks.gatherTaskContext.mockReturnValue({
      fileCount: 2,
      summary: "Repository summary",
      claudeMd: null,
      packageJson: null,
    });
    mocks.setupGitForTask.mockResolvedValue(undefined);
    mocks.shipTask.mockResolvedValue("https://github.com/test/repo/pull/42");
    mocks.getDiff.mockResolvedValue("diff --git");
    mocks.getDiffStat.mockResolvedValue("1 file changed");
    mocks.verify.mockResolvedValue({
      testStatus: "passed",
      testOutput: "",
      testExitCode: 0,
      lintStatus: "passed",
      lintOutput: "",
      lintExitCode: 0,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("revises the plan once when the first plan review fails", async () => {
    const plannerAgent = createPlannerAgent();
    const coordinator = createCoordinator({
      plannerAgent,
      planReviewerAgent: createPlanReviewerAgent([
        {
          approved: false,
          comments: [],
          summary: "Need a better plan",
        },
        {
          approved: true,
          comments: [],
          summary: "Looks good",
        },
      ]),
      coderAgent: createCoderAgent(),
      codeReviewerAgent: createCodeReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "npm test",
      lintCommand: "npm run lint",
    });

    await waitForStatus(coordinator, taskId, "awaiting-followup");

    expect(plannerAgent.reviseCalls).toHaveLength(1);
    expect(coordinator.getTaskState(taskId)?.plan).toBe("Plan v2");
    expect(coordinator.getTaskState(taskId)?.planReviewLoop).toBe(2);
  });

  it("retries after sanity failure and preserves the actual exit codes in retry context", async () => {
    const coderAgent = createCoderAgent();
    mocks.verify
      .mockResolvedValueOnce({
        testStatus: "failed",
        testOutput: "test failed",
        testExitCode: 7,
        lintStatus: "failed",
        lintOutput: "lint failed",
        lintExitCode: 9,
      })
      .mockResolvedValueOnce({
        testStatus: "passed",
        testOutput: "",
        testExitCode: 0,
        lintStatus: "passed",
        lintOutput: "",
        lintExitCode: 0,
      });

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      coderAgent,
      codeReviewerAgent: createCodeReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "npm test",
      lintCommand: "npm run lint",
    });

    await waitForStatus(coordinator, taskId, "awaiting-followup");

    expect(coderAgent.fixCalls).toHaveLength(1);
    const retryPrompt = coderAgent.fixCalls[0]?.find(
      (item) => item.type === "text",
    );
    expect(retryPrompt).toBeDefined();
    if (retryPrompt?.type === "text") {
      expect(retryPrompt.text).toContain("Test exit code: 7");
      expect(retryPrompt.text).toContain("Lint exit code: 9");
    }
  });

  it("applies code review feedback once and then ships", async () => {
    const coderAgent = createCoderAgent();
    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      coderAgent,
      codeReviewerAgent: createCodeReviewerAgent([
        { approved: false, comments: [], summary: "Fix the issue" },
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "npm test",
      lintCommand: "npm run lint",
    });

    await waitForStatus(coordinator, taskId, "awaiting-followup");

    expect(coderAgent.fixCalls).toHaveLength(1);
    expect(coordinator.getTaskState(taskId)?.codeReviewLoop).toBe(1);
  });

  it("fails the task when sanity retries are exhausted", async () => {
    mocks.verify.mockResolvedValue({
      testStatus: "failed",
      testOutput: "test failed",
      testExitCode: 2,
      lintStatus: "failed",
      lintOutput: "lint failed",
      lintExitCode: 3,
    });

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      coderAgent: createCoderAgent(),
      codeReviewerAgent: createCodeReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "npm test",
      lintCommand: "npm run lint",
    });

    await waitForStatus(coordinator, taskId, "failed");

    expect(coordinator.getTaskState(taskId)?.sanityCheckAttempt).toBe(3);
  });

  it("skips the plan phase for followups", async () => {
    const plannerAgent = createPlannerAgent();
    const coderAgent = createCoderAgent();
    const coordinator = createCoordinator({
      plannerAgent,
      planReviewerAgent: createPlanReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      coderAgent,
      codeReviewerAgent: createCodeReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "npm test",
      lintCommand: "npm run lint",
    });

    await waitForStatus(coordinator, taskId, "awaiting-followup");
    await coordinator.submitFollowup(taskId, "One more change");
    await waitForStatus(coordinator, taskId, "awaiting-followup");

    expect(plannerAgent.planCalls).toHaveLength(1);
    expect(coderAgent.implementCalls).toHaveLength(2);
  });

  it("sanitizes token-bearing failures before persisting task-failed", async () => {
    mocks.shipTask.mockRejectedValueOnce(
      new Error("push failed: https://x-access-token:secret@github.com/org/repo"),
    );

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      coderAgent: createCoderAgent(),
      codeReviewerAgent: createCodeReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "npm test",
      lintCommand: "npm run lint",
    });

    await waitForStatus(coordinator, taskId, "failed");

    const logContents = readFileSync(
      join(stateDir, "tasks", `${taskId}.jsonl`),
      "utf-8",
    );
    expect(logContents).not.toContain("x-access-token:secret");
    expect(logContents).toContain("x-access-token:***");
  });

  it("close-while-running stops the task and transitions to completed", async () => {
    // Coder implement takes 500ms — gives us time to close mid-flight
    const coderAgent = createCoderAgent();
    const slowImplement = async (
      _input: readonly import("../agents/shared-types.js").StructuredInput[],
    ): Promise<import("../agents/shared-types.js").AgentRunResult> => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return createAgentRunResult("Implemented", "coder-thread-1");
    };
    coderAgent.implement = slowImplement;

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      coderAgent,
      codeReviewerAgent: createCodeReviewerAgent([
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir: tempDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "npm test",
      lintCommand: "npm run lint",
    });

    // Close while the coder is still implementing (500ms delay)
    await new Promise((resolve) => setTimeout(resolve, 100));
    await coordinator.closeTask(taskId);

    // Wait for the task to settle
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(coordinator.getTaskState(taskId)?.status).toBe("completed");
    expect(coordinator.getActiveTaskId()).toBeNull();

    // shipTask should NOT have been called (closed before shipping)
    expect(mocks.shipTask).not.toHaveBeenCalled();
  });
});
