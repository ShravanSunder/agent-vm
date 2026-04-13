import { reviewResultSchema, type ReviewResult } from '../shared/review-result.js';
import type { StructuredInput, WorkExecutor } from '../work-executor/executor-interface.js';

export interface PlanReviewer {
	review(input: readonly StructuredInput[]): Promise<ReviewResult>;
}

export function createPlanReviewer(executor: WorkExecutor): PlanReviewer {
	return {
		async review(input: readonly StructuredInput[]): Promise<ReviewResult> {
			const response = (await executor.execute(input)).response;

			let parsed: unknown;
			try {
				parsed = JSON.parse(response);
			} catch {
				throw new Error(`Review response is not valid JSON. Raw: ${response.slice(0, 200)}`);
			}

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
