import type { CodingGatewayConfig } from "../../config.js";
import type { TaskConfig } from "../../state/task-event-types.js";
import type { TaskState } from "../../state/task-state.js";

export function createTaskConfigFixture(): TaskConfig {
  return {
    prompt: "test prompt",
    repoUrl: "https://github.com/test/repo",
    baseBranch: "main",
    testCommand: "npm test",
    lintCommand: "npm run lint",
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
  };
}

export function createTaskStateFixture(
  overrides?: Partial<TaskState>,
): TaskState {
  return {
    taskId: "task-123",
    status: "accepted",
    config: createTaskConfigFixture(),
    plannerThreadId: null,
    coderThreadId: null,
    planReviewLoop: 0,
    codeReviewLoop: 0,
    sanityCheckAttempt: 0,
    plan: null,
    lastPlanReviewComments: null,
    lastCodeReviewComments: null,
    lastTestOutput: null,
    lastTestExitCode: null,
    lastLintOutput: null,
    lastLintExitCode: null,
    followupPrompt: null,
    prUrl: null,
    prBranch: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function createGatewayConfigFixture(
  stateDir: string,
  overrides?: Partial<CodingGatewayConfig>,
): CodingGatewayConfig {
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
    ...overrides,
  };
}
