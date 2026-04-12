import { getDiffStat } from "../git/git-operations.js";
import type { TaskState } from "../state/task-state.js";
import { verify } from "../verification.js";
import { buildCoderRetryPrompt } from "./prompt-builder.js";
import { createRetryContext } from "./coordinator-helpers.js";
import type { CoordinatorDeps } from "./coordinator-types.js";

export async function runSanityRetries(
  taskId: string,
  deps: CoordinatorDeps,
  workspaceDir: string,
  tasks: Map<string, TaskState>,
  eventRecorder: {
    readonly emit: (taskId: string, event: import("../state/task-event-types.js").TaskEvent) => void;
    readonly isClosed: (taskId: string) => boolean;
    readonly recordTaskFailure: (taskId: string, reason: string) => void;
  },
): Promise<boolean> {
  const state = tasks.get(taskId);
  if (!state) {
    return false;
  }

  for (let attempt = 1; attempt <= state.config.maxSanityRetries; attempt += 1) {
    if (eventRecorder.isClosed(taskId)) {
      return false;
    }

    const verifyResult = await verify({
      testCommand: state.config.testCommand,
      lintCommand: state.config.lintCommand,
      cwd: workspaceDir,
      timeoutMs: deps.config.verificationTimeoutMs,
    });

    const passed =
      verifyResult.testStatus === "passed" &&
      verifyResult.lintStatus === "passed";

    if (passed) {
      eventRecorder.emit(taskId, { event: "sanity-check-passed" });
      return true;
    }

    eventRecorder.emit(taskId, {
      event: "sanity-check-failed",
      testExitCode: verifyResult.testExitCode,
      testOutput: verifyResult.testOutput,
      lintExitCode: verifyResult.lintExitCode,
      lintOutput: verifyResult.lintOutput,
    });

    if (attempt === state.config.maxSanityRetries) {
      eventRecorder.recordTaskFailure(
        taskId,
        `Sanity check failed after ${attempt} attempts`,
      );
      return false;
    }

    const filesChanged = await getDiffStat(workspaceDir);
    const updatedState = tasks.get(taskId);
    if (!updatedState) {
      return false;
    }

    const retryResult = await deps.coderAgent.fix(
      buildCoderRetryPrompt(
        createRetryContext(updatedState, filesChanged),
        updatedState.config.coderSkills,
      ),
    );

    eventRecorder.emit(taskId, {
      event: "code-fix-complete",
      tokenCount: retryResult.tokenCount,
    });
  }

  return false;
}
