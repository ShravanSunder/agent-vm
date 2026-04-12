import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stageAndCommit: vi.fn(),
  pushBranch: vi.fn(),
  createPullRequest: vi.fn(),
}));

vi.mock("../git/git-operations.js", () => ({
  stageAndCommit: mocks.stageAndCommit,
  pushBranch: mocks.pushBranch,
  createPullRequest: mocks.createPullRequest,
}));

import { shipTask } from "./task-ship.js";
import { createTaskStateFixture } from "../tests/support/task-fixtures.js";

describe("task-ship", () => {
  it("truncates the PR body to 2000 characters", async () => {
    mocks.stageAndCommit.mockResolvedValue(undefined);
    mocks.pushBranch.mockResolvedValue(undefined);
    mocks.createPullRequest.mockResolvedValue("https://github.com/test/repo/pull/42");

    await shipTask({
      branchName: "agent/task-123",
      commitCoAuthor: "agent-vm-coding <noreply@agent-vm>",
      workspaceDir: "/tmp/workspace",
      taskState: createTaskStateFixture({
        plan: "x".repeat(2500),
      }),
    });

    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "x".repeat(2000),
      }),
      "/tmp/workspace",
    );
  });
});
