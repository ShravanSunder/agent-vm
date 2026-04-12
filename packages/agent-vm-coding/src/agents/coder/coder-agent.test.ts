import { describe, expect, it } from "vitest";

import type {
  CodexClient,
  CodexRunResult,
  CodexThread,
  StructuredInput,
} from "../shared-types.js";
import { createCoderAgent } from "./coder-agent.js";

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
  private readonly threads = new Map<string, MockCodexThread>();
  private readonly runHistory: { threadId: string; input: StructuredInput[] }[] =
    [];

  public resumeWillFail = false;
  public resumeError: Error | null = null;

  startThread(): CodexThread {
    this.threadCounter += 1;
    const threadId = `thread-${this.threadCounter}`;
    const thread = new MockCodexThread(threadId, async (input) => {
      this.runHistory.push({ threadId, input });
      return {
        finalResponse: `Response for ${threadId}`,
        usage: { output_tokens: 1000 },
      };
    });

    this.threads.set(threadId, thread);

    return thread;
  }

  resumeThread(threadId: string): CodexThread {
    if (this.resumeError) {
      throw this.resumeError;
    }
    if (this.resumeWillFail) {
      throw new Error(`Thread ${threadId} expired`);
    }

    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    return thread;
  }

  getHistory(): readonly { threadId: string; input: StructuredInput[] }[] {
    return this.runHistory;
  }
}

describe("coder-agent", () => {
  it("implement creates a thread and returns the result", async () => {
    const client = new MockCodexClient();
    const agent = createCoderAgent({ model: "gpt-5.4-mini" }, client);

    const result = await agent.implement([
      { type: "text", text: "Implement this feature" },
    ]);

    expect(result.response).toBe("Response for thread-1");
    expect(result.threadId).toBe("thread-1");
    expect(agent.getThreadId()).toBe("thread-1");
  });

  it("fix reuses the same thread", async () => {
    const client = new MockCodexClient();
    const agent = createCoderAgent({ model: "gpt-5.4-mini" }, client);

    await agent.implement([{ type: "text", text: "Implement" }]);
    const result = await agent.fix([{ type: "text", text: "Fix issues" }]);

    expect(result.threadId).toBe("thread-1");
    expect(client.getHistory().map((entry) => entry.threadId)).toEqual([
      "thread-1",
      "thread-1",
    ]);
  });

  it("resumeOrRebuild resumes the existing thread when possible", async () => {
    const client = new MockCodexClient();
    const agent = createCoderAgent({ model: "gpt-5.4-mini" }, client);

    await agent.implement([{ type: "text", text: "Implement" }]);
    await agent.resumeOrRebuild("thread-1", [
      { type: "text", text: "Resume context" },
    ]);
    const result = await agent.fix([{ type: "text", text: "Continue" }]);

    expect(result.threadId).toBe("thread-1");
  });

  it("resumeOrRebuild rebuilds when resume fails", async () => {
    const client = new MockCodexClient();
    const agent = createCoderAgent({ model: "gpt-5.4-mini" }, client);

    await agent.implement([{ type: "text", text: "Implement" }]);
    client.resumeWillFail = true;

    await agent.resumeOrRebuild("thread-1", [
      { type: "text", text: "Replay context" },
    ]);
    const result = await agent.fix([{ type: "text", text: "Continue" }]);

    expect(result.threadId).toBe("thread-2");
    expect(client.getHistory().map((entry) => entry.threadId)).toEqual([
      "thread-1",
      "thread-2",
      "thread-2",
    ]);
  });

  it("resumeOrRebuild rethrows unexpected resume errors", async () => {
    const client = new MockCodexClient();
    const agent = createCoderAgent({ model: "gpt-5.4-mini" }, client);

    await agent.implement([{ type: "text", text: "Implement" }]);
    client.resumeError = new Error("authentication failed");

    await expect(
      agent.resumeOrRebuild("thread-1", [
        { type: "text", text: "Replay context" },
      ]),
    ).rejects.toThrow("authentication failed");
  });
});
