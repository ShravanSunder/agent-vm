import { describe, expect, test } from 'vitest';

import {
	buildInitialPlanMessage,
	buildInitialWorkMessage,
	buildPlanReviewMessage,
	buildPlanReviseMessage,
	buildWorkReviewMessage,
	buildWorkReviseMessage,
} from './message-builders.js';

describe('message builders', () => {
	test('buildInitialPlanMessage includes spec, repos, context, and repo summary', () => {
		const message = buildInitialPlanMessage({
			spec: 'add feature X',
			repos: [{ repoUrl: 'https://example.com/repo', baseBranch: 'main', workspacePath: '/w/r' }],
			repoSummary: 'summary text',
			context: { ticket: 'ABC-123' },
		});

		expect(message).toContain('add feature X');
		expect(message).toContain('/w/r');
		expect(message).toContain('summary text');
		expect(message).toContain('ABC-123');
	});

	test('buildInitialPlanMessage omits repo summary when null', () => {
		const message = buildInitialPlanMessage({
			spec: 'task',
			repos: [],
			repoSummary: null,
			context: {},
		});

		expect(message.toLowerCase()).not.toContain('repo summary');
	});

	test('buildPlanReviewMessage labels plan with cycle number', () => {
		expect(buildPlanReviewMessage({ spec: 's', plan: 'p', cycle: 2 })).toContain('Plan v2');
	});

	test('buildPlanReviseMessage includes summary and comments', () => {
		const message = buildPlanReviseMessage({
			cycle: 1,
			review: {
				approved: false,
				summary: 'needs work',
				comments: [{ file: 'plan', severity: 'critical', comment: 'missing X' }],
			},
		});

		expect(message).toContain('cycle 1');
		expect(message).toContain('needs work');
		expect(message).toContain('missing X');
	});

	test('buildInitialWorkMessage includes plan, review, and validation list', () => {
		const message = buildInitialWorkMessage({
			spec: 's',
			plan: 'my plan',
			planReview: { approved: true, summary: 'plan review', comments: [] },
			validationCommandList: [{ name: 'test', command: 'npm test' }],
		});

		expect(message).toContain('my plan');
		expect(message).toContain('plan review');
		expect(message).toContain('npm test');
	});

	test('buildInitialWorkMessage renders empty validation list', () => {
		const message = buildInitialWorkMessage({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [],
		});

		expect(message.toLowerCase()).toContain('none');
	});

	test('buildWorkReviewMessage includes validation directive', () => {
		const message = buildWorkReviewMessage({
			spec: 's',
			plan: 'p',
			diff: 'd',
			cycle: 1,
			validationCommandList: [{ name: 'test', command: 'npm test' }],
		});

		expect(message).toContain('MUST');
		expect(message).toContain('run_validation');
		expect(message).toContain('npm test');
	});

	test('buildWorkReviseMessage includes validation results and comments', () => {
		const message = buildWorkReviseMessage({
			cycle: 1,
			review: {
				approved: false,
				summary: 'broken',
				comments: [{ file: 'src/x.ts', line: 10, severity: 'critical', comment: 'bug' }],
			},
			validationResults: [{ name: 'test', passed: false, exitCode: 1, output: 'err' }],
		});

		expect(message).toContain('bug');
		expect(message).toContain('src/x.ts:10');
		expect(message).toContain('exitCode=1');
	});
});
