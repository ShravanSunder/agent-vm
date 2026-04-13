import { describe, expect, it } from 'vitest';

import {
	buildCodeReviewPrompt,
	buildCoderFixPrompt,
	buildCoderImplementPrompt,
	buildCoderRetryPrompt,
	buildPlannerPrompt,
	buildPlanReviewPrompt,
	buildPlanRevisionPrompt,
} from './prompt-builder.js';

const context = {
	fileCount: 2,
	summary: 'Repository summary',
	claudeMd: null,
	packageJson: null,
};

describe('prompt-builder', () => {
	it('builds planner prompt with skills', () => {
		const prompt = buildPlannerPrompt({
			taskPrompt: 'Add feature',
			context,
			skills: ['writing-plans', 'brainstorming'],
		});

		expect(prompt[0]).toEqual({
			type: 'text',
			text: expect.stringContaining('Task: Add feature'),
		});
		expect(prompt[1]).toEqual({
			type: 'skill',
			name: 'writing-plans',
			path: '~/.agents/skills/writing-plans/SKILL.md',
		});
	});

	it('builds all prompt types without skills when empty', () => {
		expect(
			buildPlanRevisionPrompt({
				reviewSummary: 'feedback',
				skills: [],
			}),
		).toEqual([{ type: 'text', text: expect.any(String) }]);

		expect(
			buildCoderImplementPrompt({
				plan: 'approved plan',
				skills: [],
			}),
		).toEqual([{ type: 'text', text: expect.any(String) }]);

		expect(
			buildCoderFixPrompt({
				reviewSummary: 'review feedback',
				skills: [],
			}),
		).toEqual([{ type: 'text', text: expect.any(String) }]);
	});

	it('builds retry and review prompts with expected text', () => {
		const retryPrompt = buildCoderRetryPrompt(
			{
				sanityCheckAttempt: 1,
				maxSanityRetries: 3,
				testOutput: 'test output',
				testExitCode: 1,
				lintOutput: 'lint output',
				lintExitCode: 1,
				filesChanged: 'src/file.ts',
				originalPrompt: 'Fix the bug',
			},
			['systematic-debugging'],
		);
		const planReviewPrompt = buildPlanReviewPrompt('Do the task', 'Plan text', context, [
			'generic-plan-review',
		]);
		const codeReviewPrompt = buildCodeReviewPrompt({
			taskPrompt: 'Do the task',
			diff: 'diff --git',
			skills: ['generic-code-review'],
		});

		expect(retryPrompt[0]).toEqual({
			type: 'text',
			text: expect.stringContaining('Sanity verification failed'),
		});
		expect(planReviewPrompt[0]).toEqual({
			type: 'text',
			text: expect.stringContaining('Plan to review:'),
		});
		expect(codeReviewPrompt[0]).toEqual({
			type: 'text',
			text: expect.stringContaining('Diff to review:'),
		});
	});
});
