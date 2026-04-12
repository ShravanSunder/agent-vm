import { describe, expect, it } from "vitest";

import type {
  CodexClient,
  CodexRunResult,
  CodexThread,
  StructuredInput,
} from "../shared-types.js";
import { createPlannerAgent } from "./planner-agent.js";

class MockCodexThread implements CodexThread {
  constructor(
    private readonly threadId: string,
    private readonly runImpl: (
      input: StructuredInput[],
    ) => Promise<CodexRunResult>,
  ) {}

  async run(input: StructuredInput[]): Promise<CodexRunResult> {
    return this.runImpl(input);
  }

  getThreadId(): string {
    return this.threadId;
  }
}

class MockCodexClient implements CodexClient {
  private threadCounter = 0;
  private readonly runHistory: { threadId: string; input: StructuredInput[] }[] =
    [];

  startThread(): CodexThread {
    this.threadCounter += 1;
    const threadId = `thread-${this.threadCounter}`;

    return new MockCodexThread(threadId, async (input) => {
      this.runHistory.push({ threadId, input });
      return {
        finalResponse: `Response for ${threadId}`,
        usage: { output_tokens: 1000 },
      };
    });
  }

  resumeThread(): CodexThread {
    throw new Error("resumeThread should not be called by planner");
  }

  getHistory(): readonly { threadId: string; input: StructuredInput[] }[] {
    return this.runHistory;
  }
}

describe("planner-agent", () => {
  it("plan creates a thread and returns the result", async () => {
    const client = new MockCodexClient();
    const agent = createPlannerAgent({ model: "gpt-5.4-mini" }, client);

    const result = await agent.plan([{ type: "text", text: "Plan this task" }]);

    expect(result.response).toBe("Response for thread-1");
    expect(result.threadId).toBe("thread-1");
    expect(agent.getThreadId()).toBe("thread-1");
  });

  it("revise uses the same thread after plan", async () => {
    const client = new MockCodexClient();
    const agent = createPlannerAgent({ model: "gpt-5.4-mini" }, client);

    await agent.plan([{ type: "text", text: "Initial plan" }]);
    const result = await agent.revise([
      { type: "text", text: "Revise the plan" },
    ]);

    expect(result.threadId).toBe("thread-1");
    expect(client.getHistory().map((entry) => entry.threadId)).toEqual([
      "thread-1",
      "thread-1",
    ]);
  });

  it("getThreadId returns null before planning", () => {
    const client = new MockCodexClient();
    const agent = createPlannerAgent({ model: "gpt-5.4-mini" }, client);

    expect(agent.getThreadId()).toBe(null);
  });
});
