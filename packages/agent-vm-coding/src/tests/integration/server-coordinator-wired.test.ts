import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoderAgent } from "../../agents/coder/coder-agent.js";
import type { CodeReviewerAgent } from "../../agents/code-reviewer/code-reviewer-agent.js";
import type { PlannerAgent } from "../../agents/planner/planner-agent.js";
import type { PlanReviewerAgent } from "../../agents/plan-reviewer/plan-reviewer-agent.js";
import type { ReviewResult } from "../../agents/review-result.js";
import type { AgentRunResult, StructuredInput } from "../../agents/shared-types.js";
import type { CodingGatewayConfig } from "../../config.js";
import { createCoordinator } from "../../coordinator/coordinator.js";
import { createApp } from "../../server.js";

vi.mock("../../git/git-operations.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../git/git-operations.js")>();
  return {
    ...actual,
    configureGit: vi.fn(async (): Promise<void> => undefined),
    createBranch: vi.fn(async (): Promise<void> => undefined),
    stageAndCommit: vi.fn(async (): Promise<void> => undefined),
    pushBranch: vi.fn(async (): Promise<void> => undefined),
    createPullRequest: vi.fn(
      async (): Promise<string> => "https://github.com/test/repo/pull/42",
    ),
    getDiff: vi.fn(async (): Promise<string> => "diff --git"),
    getDiffStat: vi.fn(async (): Promise<string> => "1 file changed"),
  };
});

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

function createPlannerAgent(
  planResponse: string = "Implementation plan",
  revisedResponse: string = "Revised plan",
): PlannerAgent {
  let threadId: string | null = null;

  return {
    async plan(_input: readonly StructuredInput[]): Promise<AgentRunResult> {
      threadId = "planner-thread-1";
      return createAgentRunResult(planResponse, threadId);
    },
    async revise(_input: readonly StructuredInput[]): Promise<AgentRunResult> {
      return createAgentRunResult(
        revisedResponse,
        threadId ?? "planner-thread-1",
      );
    },
    getThreadId(): string | null {
      return threadId;
    },
  };
}

function createPlanReviewer(
  responses: readonly ReviewResult[] = [
    { approved: true, comments: [], summary: "Looks good" },
  ],
): PlanReviewerAgent {
  let index = 0;

  return {
    async review(_input: readonly StructuredInput[]): Promise<ReviewResult> {
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!response) {
        throw new Error("missing plan review response");
      }
      return response;
    },
  };
}

function createCoderAgent(
  callbacks?: {
    readonly onImplement?: () => Promise<void> | void;
    readonly onFix?: () => Promise<void> | void;
  },
): CoderAgent {
  let threadId: string | null = null;

  return {
    async implement(_input: readonly StructuredInput[]): Promise<AgentRunResult> {
      threadId = "coder-thread-1";
      await callbacks?.onImplement?.();
      return createAgentRunResult("Implemented", threadId);
    },
    async fix(_input: readonly StructuredInput[]): Promise<AgentRunResult> {
      await callbacks?.onFix?.();
      return createAgentRunResult("Fixed", threadId ?? "coder-thread-1");
    },
    async resumeOrRebuild(
      _threadId: string | null,
      _context: readonly StructuredInput[],
    ): Promise<void> {
      threadId = "coder-thread-resumed";
    },
    getThreadId(): string | null {
      return threadId;
    },
  };
}

function createCodeReviewer(
  responses: readonly ReviewResult[] = [
    { approved: true, comments: [], summary: "Looks good" },
  ],
): CodeReviewerAgent {
  let index = 0;

  return {
    async review(_input: readonly StructuredInput[]): Promise<ReviewResult> {
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (!response) {
        throw new Error("missing code review response");
      }
      return response;
    },
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
    testCommand: "echo tests-ok",
    lintCommand: "echo lint-ok",
    branchPrefix: "agent/",
    commitCoAuthor: "agent-vm-coding <noreply@agent-vm>",
    idleTimeoutMs: 1_800_000,
    stateDir,
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Task ${taskId} did not reach ${expectedStatus}. Last status: ${coordinator.getTaskState(taskId)?.status ?? "unknown"}`,
  );
}

describe("server + coordinator wired integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("POST /tasks runs through to awaiting-followup", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "coordinator-wired-"));
    const workspaceDir = join(baseDir, "workspace");
    const stateDir = join(baseDir, "state");
    tempDirs.push(baseDir);

    await mkdir(workspaceDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(workspaceDir, "README.md"), "# test\n", "utf-8");

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewer(),
      coderAgent: createCoderAgent(),
      codeReviewerAgent: createCodeReviewer(),
      config: createConfig(stateDir),
      workspaceDir,
    });
    const app = createApp({
      getActiveTaskId: () => coordinator.getActiveTaskId(),
      getTaskState: (taskId: string) => coordinator.getTaskState(taskId),
      submitTask: async (input) => coordinator.submitTask(input),
      submitFollowup: async (taskId: string, prompt: string) =>
        coordinator.submitFollowup(taskId, prompt),
      closeTask: async (taskId: string) => coordinator.closeTask(taskId),
    });

    const createResponse = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Implement feature X",
        repoUrl: "test/repo",
        baseBranch: "main",
        testCommand: "echo tests-ok",
        lintCommand: "echo lint-ok",
      }),
    });
    const createData = (await createResponse.json()) as {
      taskId: string;
      status: string;
    };

    expect(createResponse.status).toBe(201);
    expect(createData.status).toBe("accepted");

    await waitForStatus(coordinator, createData.taskId, "awaiting-followup");

    const getResponse = await app.request(`/tasks/${createData.taskId}`);
    const taskState = (await getResponse.json()) as { status: string; prUrl: string };

    expect(getResponse.status).toBe(200);
    expect(taskState.status).toBe("awaiting-followup");
    expect(taskState.prUrl).toBe("https://github.com/test/repo/pull/42");
  });

  it("close endpoint transitions awaiting-followup to completed", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "coordinator-close-"));
    const workspaceDir = join(baseDir, "workspace");
    const stateDir = join(baseDir, "state");
    tempDirs.push(baseDir);

    await mkdir(workspaceDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(workspaceDir, "README.md"), "# test\n", "utf-8");

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewer(),
      coderAgent: createCoderAgent(),
      codeReviewerAgent: createCodeReviewer(),
      config: createConfig(stateDir),
      workspaceDir,
    });
    const app = createApp({
      getActiveTaskId: () => coordinator.getActiveTaskId(),
      getTaskState: (taskId: string) => coordinator.getTaskState(taskId),
      submitTask: async (input) => coordinator.submitTask(input),
      submitFollowup: async (taskId: string, prompt: string) =>
        coordinator.submitFollowup(taskId, prompt),
      closeTask: async (taskId: string) => coordinator.closeTask(taskId),
    });

    const createResponse = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Implement feature X",
        repoUrl: "test/repo",
        testCommand: "echo tests-ok",
        lintCommand: "echo lint-ok",
      }),
    });
    const createData = (await createResponse.json()) as { taskId: string };

    await waitForStatus(coordinator, createData.taskId, "awaiting-followup");

    const closeResponse = await app.request(`/tasks/${createData.taskId}/close`, {
      method: "POST",
    });
    const closeData = (await closeResponse.json()) as { status: string };

    expect(closeResponse.status).toBe(200);
    expect(closeData.status).toBe("closed");
    expect(coordinator.getTaskState(createData.taskId)?.status).toBe("completed");
  });

  it("revises the plan when the first plan review rejects it", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "coordinator-plan-review-"));
    const workspaceDir = join(baseDir, "workspace");
    const stateDir = join(baseDir, "state");
    tempDirs.push(baseDir);

    await mkdir(workspaceDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(workspaceDir, "README.md"), "# test\n", "utf-8");

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent("Plan v1", "Plan v2"),
      planReviewerAgent: createPlanReviewer([
        { approved: false, comments: [], summary: "Revise the plan" },
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      coderAgent: createCoderAgent(),
      codeReviewerAgent: createCodeReviewer(),
      config: createConfig(stateDir),
      workspaceDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature X",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "echo tests-ok",
      lintCommand: "echo lint-ok",
    });

    await waitForStatus(coordinator, taskId, "awaiting-followup");

    expect(coordinator.getTaskState(taskId)?.plan).toBe("Plan v2");
    expect(coordinator.getTaskState(taskId)?.planReviewLoop).toBe(2);
  });

  it("applies code review feedback and ships after a second review passes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "coordinator-code-review-"));
    const workspaceDir = join(baseDir, "workspace");
    const stateDir = join(baseDir, "state");
    tempDirs.push(baseDir);

    await mkdir(workspaceDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(workspaceDir, "README.md"), "# test\n", "utf-8");

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewer(),
      coderAgent: createCoderAgent(),
      codeReviewerAgent: createCodeReviewer([
        { approved: false, comments: [], summary: "Fix the implementation" },
        { approved: true, comments: [], summary: "Looks good" },
      ]),
      config: createConfig(stateDir),
      workspaceDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature X",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "echo tests-ok",
      lintCommand: "echo lint-ok",
    });

    await waitForStatus(coordinator, taskId, "awaiting-followup");

    expect(coordinator.getTaskState(taskId)?.codeReviewLoop).toBe(1);
  });

  it("recovers from a real sanity failure after coder fix updates the workspace", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "coordinator-sanity-retry-"));
    const workspaceDir = join(baseDir, "workspace");
    const stateDir = join(baseDir, "state");
    tempDirs.push(baseDir);

    await mkdir(workspaceDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(workspaceDir, "README.md"), "# test\n", "utf-8");
    await writeFile(join(workspaceDir, "status.txt"), "fail\n", "utf-8");
    await writeFile(
      join(workspaceDir, "verify.mjs"),
      [
        "import { readFileSync } from 'node:fs';",
        "const status = readFileSync(new URL('./status.txt', import.meta.url), 'utf-8').trim();",
        "if (status !== 'pass') {",
        "  console.error('status is not pass');",
        "  process.exit(7);",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const coordinator = createCoordinator({
      plannerAgent: createPlannerAgent(),
      planReviewerAgent: createPlanReviewer(),
      coderAgent: createCoderAgent({
        onFix: async () => {
          await writeFile(join(workspaceDir, "status.txt"), "pass\n", "utf-8");
        },
      }),
      codeReviewerAgent: createCodeReviewer(),
      config: createConfig(stateDir),
      workspaceDir,
    });

    const { taskId } = await coordinator.submitTask({
      prompt: "Implement feature X",
      repoUrl: "test/repo",
      baseBranch: "main",
      testCommand: "node verify.mjs",
      lintCommand: "echo lint-ok",
    });

    await waitForStatus(coordinator, taskId, "awaiting-followup");

    expect(coordinator.getTaskState(taskId)?.sanityCheckAttempt).toBe(1);
    expect(coordinator.getTaskState(taskId)?.lastTestExitCode).toBe(7);
  });
});
