import { describe, expect, it } from 'vitest';

import type {
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from '../work-executor/executor-interface.js';
import { createPlanReviewer } from './plan-reviewer.js';

function createMockReviewExecutor(response: string): WorkExecutor {
	return {
		async execute(_input: readonly StructuredInput[]): Promise<ExecutorResult> {
			return {
				response,
				tokenCount: 50,
				threadId: 'review-thread-1',
			};
		},
		async fix(): Promise<ExecutorResult> {
			throw new Error('Reviewers are single-shot - fix() should not be called');
		},
		async resumeOrRebuild(): Promise<void> {},
		getThreadId(): string | null {
			return null;
		},
	};
}

describe('plan-reviewer', () => {
	it('parses a valid ReviewResult from executor response', async () => {
		const executor = createMockReviewExecutor(
			JSON.stringify({ approved: true, comments: [], summary: 'Plan looks solid.' }),
		);
		const reviewer = createPlanReviewer(executor);

		const result = await reviewer.review([{ type: 'text', text: 'Review this plan' }]);

		expect(result.approved).toBe(true);
		expect(result.summary).toBe('Plan looks solid.');
		expect(result.comments).toHaveLength(0);
	});

	it('parses rejection with comments', async () => {
		const executor = createMockReviewExecutor(
			JSON.stringify({
				approved: false,
				comments: [
					{
						file: 'src/index.ts',
						severity: 'critical',
						comment: 'Missing error handling',
					},
				],
				summary: 'Needs error handling.',
			}),
		);
		const reviewer = createPlanReviewer(executor);

		const result = await reviewer.review([{ type: 'text', text: 'Review' }]);
		expect(result.approved).toBe(false);
		expect(result.comments).toHaveLength(1);
		expect(result.comments[0]?.severity).toBe('critical');
	});

	it('throws on non-JSON response', async () => {
		const reviewer = createPlanReviewer(createMockReviewExecutor('This is not JSON'));

		await expect(reviewer.review([{ type: 'text', text: 'Review' }])).rejects.toThrow(
			'Review response is not valid JSON',
		);
	});

	it("throws on JSON that doesn't match ReviewResult schema", async () => {
		const reviewer = createPlanReviewer(
			createMockReviewExecutor(JSON.stringify({ approved: 'yes', comments: 'none' })),
		);

		await expect(reviewer.review([{ type: 'text', text: 'Review' }])).rejects.toThrow(
			"Review JSON doesn't match schema",
		);
	});
});
