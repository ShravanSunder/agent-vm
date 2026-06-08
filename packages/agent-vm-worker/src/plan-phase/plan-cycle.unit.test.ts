import { describe, expect, test, vi } from 'vitest';

import type { PersistentThread } from '../work-executor/persistent-thread.js';
import { runPlanCycle } from './plan-cycle.js';

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

describe('runPlanCycle', () => {
	test('maxReviewLoops=0 runs one plan turn and no reviewer turn', async () => {
		const planThread = buildThread([JSON.stringify({ plan: 'plan-v0' })]);
		const reviewThread = buildThread([]);
		const events: Array<{ readonly kind: string; readonly cycle: number }> = [];

		const result = await runPlanCycle({
			spec: 'do work',
			repos: [],
			repoSummary: null,
			context: {},
			cycle: { kind: 'noReview' },
			planThread,
			reviewThread,
			systemPromptPlanAgent: 'PLAN SYSTEM',
			systemPromptPlanReviewer: 'REVIEW SYSTEM',
			onPlanAgentTurn: (cycle) => {
				events.push({ kind: 'plan-agent', cycle });
			},
			onPlanReviewerTurn: (cycle) => {
				events.push({ kind: 'plan-reviewer', cycle });
			},
		});

		expect(planThread.send).toHaveBeenCalledTimes(1);
		expect(reviewThread.send).toHaveBeenCalledTimes(0);
		expect(result).toEqual({ plan: 'plan-v0', review: null });
		expect(events).toEqual([{ kind: 'plan-agent', cycle: 0 }]);
	});

	test('maxReviewLoops=2 runs initial plan plus two review/revise cycles', async () => {
		const planThread = buildThread([
			JSON.stringify({ plan: 'plan-v0' }),
			JSON.stringify({ plan: 'plan-v1' }),
			JSON.stringify({ plan: 'plan-v2' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({ approved: false, summary: 'review 1', comments: [] }),
			JSON.stringify({ approved: false, summary: 'review 2', comments: [] }),
		]);

		const result = await runPlanCycle({
			spec: 'do work',
			repos: [],
			repoSummary: null,
			context: {},
			cycle: { kind: 'review', cycleCount: 2 },
			planThread,
			reviewThread,
			systemPromptPlanAgent: 'PLAN SYSTEM',
			systemPromptPlanReviewer: 'REVIEW SYSTEM',
			onPlanAgentTurn: () => {},
			onPlanReviewerTurn: () => {},
		});

		expect(planThread.send).toHaveBeenCalledTimes(3);
		expect(reviewThread.send).toHaveBeenCalledTimes(2);
		expect(result.plan).toBe('plan-v2');
		expect(result.review?.summary).toBe('review 2');
	});

	test('maxReviewLoops=1 runs plan review revise in order', async () => {
		const planThread = buildThread([
			JSON.stringify({ plan: 'plan-v0' }),
			JSON.stringify({ plan: 'plan-v1' }),
		]);
		const reviewThread = buildThread([
			JSON.stringify({ approved: false, summary: 'review 1', comments: [] }),
		]);
		const agentTurns: number[] = [];
		const reviewerTurns: number[] = [];

		const result = await runPlanCycle({
			spec: 'do work',
			repos: [],
			repoSummary: null,
			context: {},
			cycle: { kind: 'review', cycleCount: 1 },
			planThread,
			reviewThread,
			systemPromptPlanAgent: 'PLAN SYSTEM',
			systemPromptPlanReviewer: 'REVIEW SYSTEM',
			onPlanAgentTurn: (cycle) => {
				agentTurns.push(cycle);
			},
			onPlanReviewerTurn: (cycle) => {
				reviewerTurns.push(cycle);
			},
		});

		expect(planThread.send).toHaveBeenCalledTimes(2);
		expect(reviewThread.send).toHaveBeenCalledTimes(1);
		expect(agentTurns).toEqual([0, 1]);
		expect(reviewerTurns).toEqual([1]);
		expect(result.plan).toBe('plan-v1');
		expect(result.review?.summary).toBe('review 1');
	});

	test('first send on each thread includes system prompt', async () => {
		const planInputs: string[] = [];
		const reviewInputs: string[] = [];
		const planThread: PersistentThread = {
			send: vi.fn(async (input: string) => {
				planInputs.push(input);
				return { response: JSON.stringify({ plan: 'plan' }), tokenCount: 1, threadId: 'p' };
			}),
			threadId: () => 'p',
		};
		const reviewThread: PersistentThread = {
			send: vi.fn(async (input: string) => {
				reviewInputs.push(input);
				return {
					response: JSON.stringify({ approved: true, summary: 'ok', comments: [] }),
					tokenCount: 1,
					threadId: 'r',
				};
			}),
			threadId: () => 'r',
		};

		await runPlanCycle({
			spec: 'do work',
			repos: [],
			repoSummary: null,
			context: {},
			cycle: { kind: 'review', cycleCount: 1 },
			planThread,
			reviewThread,
			systemPromptPlanAgent: 'PLAN SYSTEM',
			systemPromptPlanReviewer: 'REVIEW SYSTEM',
			onPlanAgentTurn: () => {},
			onPlanReviewerTurn: () => {},
		});

		expect(planInputs[0]).toContain('PLAN SYSTEM');
		expect(reviewInputs[0]).toContain('REVIEW SYSTEM');
		expect(planInputs[1]).not.toContain('PLAN SYSTEM');
	});

	test('malformed plan JSON throws', async () => {
		const planThread = buildThread(['not json']);
		const reviewThread = buildThread([]);

		await expect(
			runPlanCycle({
				spec: 'do work',
				repos: [],
				repoSummary: null,
				context: {},
				cycle: { kind: 'noReview' },
				planThread,
				reviewThread,
				systemPromptPlanAgent: 'PLAN SYSTEM',
				systemPromptPlanReviewer: 'REVIEW SYSTEM',
				onPlanAgentTurn: () => {},
				onPlanReviewerTurn: () => {},
			}),
		).rejects.toThrow(/plan-agent response is not valid JSON/);
	});
});
