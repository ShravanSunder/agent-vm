import { Codex, type UserInput } from "@openai/codex-sdk";

import type {
  CodexClient,
  CodexRunResult,
  CodexThread,
  StructuredInput,
} from "./shared-types.js";

function mapStructuredInputToSdkInput(
  input: readonly StructuredInput[],
): UserInput[] {
  return input.map((item) => {
    if (item.type === "text") {
      return {
        type: "text",
        text: item.text,
      };
    }

    return {
      type: "text",
      text: `Load skill '${item.name}' from ${item.path} and follow it.`,
    };
  });
}

export function createCodexClientFromSdk(
  apiKey: string,
  workingDirectory: string,
): CodexClient {
  const codex = new Codex({ apiKey });

  function wrapThread(
    sdkThread: ReturnType<typeof codex.startThread>,
  ): CodexThread {
    return {
      async run(input: readonly StructuredInput[]): Promise<CodexRunResult> {
        const result = await sdkThread.run(mapStructuredInputToSdkInput(input));
        return {
          finalResponse: result.finalResponse,
          ...(result.usage
            ? { usage: { output_tokens: result.usage.output_tokens } }
            : {}),
        };
      },
      getThreadId(): string {
        return sdkThread.id ?? "";
      },
    };
  }

  return {
    startThread(options) {
      return wrapThread(
        codex.startThread({
          model: options.model,
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
          workingDirectory,
          networkAccessEnabled: true,
        }),
      );
    },

    resumeThread(threadId, options) {
      return wrapThread(
        codex.resumeThread(threadId, {
          ...(options?.model ? { model: options.model } : {}),
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
          workingDirectory,
          networkAccessEnabled: true,
        }),
      );
    },
  };
}
