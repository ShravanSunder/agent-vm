import { describe, expect, it, vi } from "vitest";

import type { CodexClient, CodexThread } from "../shared-types.js";
import { createCodeReviewerAgent } from "./code-reviewer-agent.js";

describe("code-reviewer-agent", () => {
  it("parses a valid JSON review", async () => {
    const thread: CodexThread = {
      run: vi.fn().mockResolvedValue({
        finalResponse: JSON.stringify({
          approved: false,
          comments: [
            {
              file: "src/file.ts",
              severity: "critical",
              comment: "Bug found",
            },
          ],
          summary: "Needs work",
        }),
      }),
      getThreadId: vi.fn().mockReturnValue("thread-1"),
    };
    const client: CodexClient = {
      startThread: vi.fn().mockReturnValue(thread),
      resumeThread: vi.fn(),
    };

    const agent = createCodeReviewerAgent({ model: "gpt-5.4-mini" }, client);
    const result = await agent.review([{ type: "text", text: "Review diff" }]);

    expect(result.approved).toBe(false);
    expect(result.summary).toBe("Needs work");
  });

  it("throws when JSON parsing fails", async () => {
    const thread: CodexThread = {
      run: vi.fn().mockResolvedValue({
        finalResponse: "plain text response",
      }),
      getThreadId: vi.fn().mockReturnValue("thread-1"),
    };
    const client: CodexClient = {
      startThread: vi.fn().mockReturnValue(thread),
      resumeThread: vi.fn(),
    };

    const agent = createCodeReviewerAgent({ model: "gpt-5.4-mini" }, client);
    await expect(
      agent.review([{ type: "text", text: "Review diff" }]),
    ).rejects.toThrow("Review response is not valid JSON");
  });

  it("creates a fresh thread for each review", async () => {
    const thread: CodexThread = {
      run: vi.fn().mockResolvedValue({
        finalResponse: JSON.stringify({
          approved: true,
          comments: [],
          summary: "Looks good",
        }),
      }),
      getThreadId: vi.fn().mockReturnValue("thread-1"),
    };
    const client: CodexClient = {
      startThread: vi.fn().mockReturnValue(thread),
      resumeThread: vi.fn(),
    };

    const agent = createCodeReviewerAgent({ model: "gpt-5.4-mini" }, client);
    await agent.review([{ type: "text", text: "Review one" }]);
    await agent.review([{ type: "text", text: "Review two" }]);

    expect(client.startThread).toHaveBeenCalledTimes(2);
  });
});
