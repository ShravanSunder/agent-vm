import { describe, expect, test, vi } from 'vitest';

import type { PersistentThread } from '../work-executor/persistent-thread.js';
import { runWorkCycle } from './work-cycle.js';

function buildThread(responses: readonly string[]): PersistentThread {
	let responseIndex = 0;
	return {
		send: vi.fn(async () => ({
			response: responses[responseIndex++] ?? '',
			tokenCount: 10,
			threadId: 'thread-1',
		})),
		threadId: () => 'thread-1',
	};
}

describe('runWorkCycle', () => {
	test('cycleCount=1 runs work → review → work (always revises after review)', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
			JSON.stringify({ summary: 'w1', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({
				approved: false,
				summary: 'reviewed',
				comments: [],
				validationResults: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
			}),
		]);

		const result = await runWorkCycle({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [{ name: 'test', command: 'npm test' }],
			cycle: { kind: 'review', cycleCount: 1 },
			workThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			onWorkAgentTurn: () => {},
			onWorkReviewerTurn: () => {},
		});

		// 1 initial work turn + 1 revise = 2 work sends
		expect(workThread.send).toHaveBeenCalledTimes(2);
		expect(reviewThread.send).toHaveBeenCalledTimes(1);
		expect(result.review.summary).toBe('reviewed');
		expect(result.validationResults).toHaveLength(1);
	});

	test('cycleCount=2 runs 3 work turns and 2 review turns', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
			JSON.stringify({ summary: 'w1', commitShas: [], remainingConcerns: '' }),
			JSON.stringify({ summary: 'w2', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({ approved: false, summary: 'r1', comments: [], validationResults: [] }),
			JSON.stringify({ approved: false, summary: 'r2', comments: [], validationResults: [] }),
		]);

		const result = await runWorkCycle({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [],
			cycle: { kind: 'review', cycleCount: 2 },
			workThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			onWorkAgentTurn: () => {},
			onWorkReviewerTurn: () => {},
		});

		// 1 initial + 2 revises = 3 work sends; 2 reviews
		expect(workThread.send).toHaveBeenCalledTimes(3);
		expect(reviewThread.send).toHaveBeenCalledTimes(2);
		expect(result.review.summary).toBe('r2');
	});

	test('nudges reviewer once when validation results are missing', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({ approved: false, summary: 'forgot', comments: [], validationResults: [] }),
			JSON.stringify({
				approved: false,
				summary: 'with validation',
				comments: [],
				validationResults: [{ name: 'test', passed: false, exitCode: 1, output: 'err' }],
			}),
		]);

		const result = await runWorkCycle({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [{ name: 'test', command: 'npm test' }],
			cycle: { kind: 'review', cycleCount: 1 },
			workThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			onWorkAgentTurn: () => {},
			onWorkReviewerTurn: () => {},
		});

		expect(reviewThread.send).toHaveBeenCalledTimes(2);
		expect(result.review.summary).toBe('with validation');
		expect(result.validationResults).toHaveLength(1);
		expect(result.validationSkipped).toBe(false);
	});

	test('proceeds with validationSkipped when reviewer still omits validation after nudge', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({ approved: true, summary: 'first', comments: [], validationResults: [] }),
			JSON.stringify({ approved: true, summary: 'second', comments: [], validationResults: [] }),
		]);
		const reviewerTurns: boolean[] = [];

		const result = await runWorkCycle({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [{ name: 'test', command: 'npm test' }],
			cycle: { kind: 'review', cycleCount: 1 },
			workThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			onWorkAgentTurn: () => {},
			onWorkReviewerTurn: (_cycle, _result, _review, _validationResults, validationSkipped) => {
				reviewerTurns.push(validationSkipped);
			},
		});

		expect(reviewThread.send).toHaveBeenCalledTimes(2);
		expect(reviewerTurns).toEqual([true]);
		expect(result.validationResults).toEqual([]);
		expect(result.validationSkipped).toBe(true);
	});

	test('nudges once when reviewer comments are malformed', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({
				approved: false,
				summary: 'malformed',
				comments: [{ file: 'README.md', severity: 'suggestion' }],
				validationResults: [],
			}),
			JSON.stringify({
				approved: true,
				summary: 'fixed',
				comments: [],
				validationResults: [],
			}),
		]);

		const result = await runWorkCycle({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [],
			cycle: { kind: 'review', cycleCount: 1 },
			workThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			onWorkAgentTurn: () => {},
			onWorkReviewerTurn: () => {},
		});

		expect(reviewThread.send).toHaveBeenCalledTimes(2);
		expect(result.review.summary).toBe('fixed');
	});

	test('throws when validationResults items are malformed', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({
				approved: true,
				summary: 'bad validation',
				comments: [],
				validationResults: [{ name: 'test', passed: 1, exitCode: '1', output: '' }],
			}),
		]);

		await expect(
			runWorkCycle({
				spec: 's',
				plan: 'p',
				planReview: null,
				validationCommandList: [],
				cycle: { kind: 'review', cycleCount: 1 },
				workThread,
				reviewThread,
				systemPromptWorkAgent: 'WORK SYSTEM',
				systemPromptWorkReviewer: 'REVIEW SYSTEM',
				getDiff: async () => 'diff',
				onWorkAgentTurn: () => {},
				onWorkReviewerTurn: () => {},
			}),
		).rejects.toThrow(/malformed validationResults/);
	});

	test('normalizes run_validation tool envelope into validation results', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({
				approved: true,
				summary: 'tool called',
				comments: [],
				validationResults: [
					{
						tool: 'run_validation',
						result: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
					},
				],
			}),
		]);

		const result = await runWorkCycle({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [{ name: 'test', command: 'npm test' }],
			cycle: { kind: 'review', cycleCount: 1 },
			workThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			onWorkAgentTurn: () => {},
			onWorkReviewerTurn: () => {},
		});

		expect(result.validationResults).toEqual([
			{ name: 'test', passed: true, exitCode: 0, output: '' },
		]);
		expect(result.validationSkipped).toBe(false);
	});

	test('normalizes nested run_validation result array', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({
				approved: true,
				summary: 'tool called',
				comments: [],
				validationResults: [[{ name: 'test', passed: true, exitCode: 0, output: '' }]],
			}),
		]);

		const result = await runWorkCycle({
			spec: 's',
			plan: 'p',
			planReview: null,
			validationCommandList: [{ name: 'test', command: 'npm test' }],
			cycle: { kind: 'review', cycleCount: 1 },
			workThread,
			reviewThread,
			systemPromptWorkAgent: 'WORK SYSTEM',
			systemPromptWorkReviewer: 'REVIEW SYSTEM',
			getDiff: async () => 'diff',
			onWorkAgentTurn: () => {},
			onWorkReviewerTurn: () => {},
		});

		expect(result.validationResults).toEqual([
			{ name: 'test', passed: true, exitCode: 0, output: '' },
		]);
	});

	test('malformed reviewer JSON throws', async () => {
		const workThread = buildThread([
			JSON.stringify({ summary: 'w0', commitShas: [], remainingConcerns: '' }),
		]);
		const reviewThread = buildThread(['not json']);

		await expect(
			runWorkCycle({
				spec: 's',
				plan: 'p',
				planReview: null,
				validationCommandList: [],
				cycle: { kind: 'review', cycleCount: 1 },
				workThread,
				reviewThread,
				systemPromptWorkAgent: 'WORK SYSTEM',
				systemPromptWorkReviewer: 'REVIEW SYSTEM',
				getDiff: async () => 'diff',
				onWorkAgentTurn: () => {},
				onWorkReviewerTurn: () => {},
			}),
		).rejects.toThrow(/work-reviewer response is not valid JSON/);
	});
});
