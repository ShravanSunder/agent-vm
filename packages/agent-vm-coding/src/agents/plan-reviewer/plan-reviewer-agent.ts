import { reviewResultSchema, type ReviewResult } from '../review-result.js';
import type { CodexClient, StructuredInput } from '../shared-types.js';

export interface PlanReviewerAgentConfig {
	readonly model: string;
}

export interface PlanReviewerAgent {
	review(input: readonly StructuredInput[]): Promise<ReviewResult>;
}

export function createPlanReviewerAgent(
	config: PlanReviewerAgentConfig,
	codexClient: CodexClient,
): PlanReviewerAgent {
	return {
		async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
			const thread = codexClient.startThread({ model: config.model });
			const result = await thread.run(input);
			const response = result.finalResponse ?? '';

			// Parse JSON
			let parsed: unknown;
			try {
				parsed = JSON.parse(response);
			} catch {
				throw new Error(`Review response is not valid JSON. Raw: ${response.slice(0, 200)}`);
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
