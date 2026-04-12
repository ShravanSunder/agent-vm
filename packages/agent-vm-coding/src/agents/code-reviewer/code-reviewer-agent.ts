import type { CodexClient, StructuredInput } from "../shared-types.js";
import { reviewResultSchema, type ReviewResult } from "../review-result.js";

export interface CodeReviewerAgentConfig {
  readonly model: string;
}

export interface CodeReviewerAgent {
  review(input: readonly StructuredInput[]): Promise<ReviewResult>;
}

export function createCodeReviewerAgent(
  config: CodeReviewerAgentConfig,
  codexClient: CodexClient,
): CodeReviewerAgent {
  return {
    async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
      const thread = codexClient.startThread({ model: config.model });
      const result = await thread.run(input);
      const response = result.finalResponse ?? "";

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(response);
      } catch {
        throw new Error(
          `Review response is not valid JSON. Raw: ${response.slice(0, 200)}`,
        );
      }

      // Validate schema
      const parseResult = reviewResultSchema.safeParse(parsed);
      if (!parseResult.success) {
        throw new Error(
          `Review JSON doesn't match schema: ${parseResult.error.message}. Raw: ${response.slice(0, 200)}`,
        );
      }
      return parseResult.data;
    },
  };
}
