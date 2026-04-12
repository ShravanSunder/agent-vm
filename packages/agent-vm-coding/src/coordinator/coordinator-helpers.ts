import { join } from "node:path";

import type { CodingGatewayConfig } from "../config.js";
import { appendEvent } from "../state/event-log.js";
import type {
  RetryPromptContext,
  TaskConfig,
  TaskEvent,
} from "../state/task-event-types.js";
import { applyEvent, type TaskState } from "../state/task-state.js";

import type { CreateTaskInput } from "./coordinator-types.js";

export function sanitizeErrorMessage(message: string): string {
  return message.replace(
    /https:\/\/x-access-token:[^@]*@/g,
    "https://x-access-token:***@",
  );
}

export function buildTaskConfig(
  input: CreateTaskInput,
  config: CodingGatewayConfig,
): TaskConfig {
  return {
    prompt: input.prompt,
    repoUrl: input.repoUrl,
    baseBranch: input.baseBranch,
    testCommand: input.testCommand,
    lintCommand: input.lintCommand,
    model: config.model,
    reviewModel: config.reviewModel,
    plannerSkills: config.plannerSkills,
    planReviewerSkills: config.planReviewerSkills,
    coderSkills: config.coderSkills,
    codeReviewerSkills: config.codeReviewerSkills,
    maxPlanReviewLoops: config.maxPlanReviewLoops,
    maxCodeReviewLoops: config.maxCodeReviewLoops,
    maxSanityRetries: config.maxSanityRetries,
  };
}

export function createRetryContext(
  state: TaskState,
  filesChanged: string,
): RetryPromptContext {
  return {
    sanityCheckAttempt: state.sanityCheckAttempt + 1,
    maxSanityRetries: state.config.maxSanityRetries,
    testOutput: state.lastTestOutput ?? "",
    testExitCode: state.lastTestExitCode ?? 1,
    lintOutput: state.lastLintOutput ?? "",
    lintExitCode: state.lastLintExitCode ?? 1,
    filesChanged,
    originalPrompt: state.config.prompt,
  };
}

export function createTaskEventRecorder(
  stateDir: string,
  tasks: Map<string, TaskState>,
  closedTaskIds: Set<string>,
): {
  readonly emit: (taskId: string, event: TaskEvent) => void;
  readonly isClosed: (taskId: string) => boolean;
  readonly recordTaskFailure: (taskId: string, reason: string) => void;
} {
  function logPath(taskId: string): string {
    return join(stateDir, "tasks", `${taskId}.jsonl`);
  }

  function emit(taskId: string, event: TaskEvent): void {
    if (closedTaskIds.has(taskId) && event.event !== "task-closed") {
      console.warn(`Dropping event for closed task ${taskId}: ${event.event}`);
      return;
    }

    appendEvent(logPath(taskId), event);
    const current = tasks.get(taskId);
    if (current) {
      tasks.set(taskId, applyEvent(current, event));
    }
  }

  function recordTaskFailure(taskId: string, reason: string): void {
    try {
      emit(taskId, {
        event: "task-failed",
        reason,
      });
    } catch (error) {
      console.error(
        `Failed to persist task failure for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const current = tasks.get(taskId);
      if (current) {
        tasks.set(
          taskId,
          applyEvent(current, {
            event: "task-failed",
            reason,
          }),
        );
      }
    }
  }

  return {
    emit,
    isClosed(taskId: string): boolean {
      return closedTaskIds.has(taskId);
    },
    recordTaskFailure,
  };
}
