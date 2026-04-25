import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workerConfigSchema } from '../config/worker-config.js';
import { appendEvent } from './event-log.js';
import type { TaskConfig } from './task-event-types.js';
import { applyEvent, createInitialState, isTerminal, loadTaskStateFromLog } from './task-state.js';

const TEST_CONFIG: TaskConfig = {
	taskId: 'task-1',
	prompt: 'fix bug',
	repos: [],
	context: {},
	effectiveConfig: workerConfigSchema.parse({
		defaults: { provider: 'codex', model: 'latest-medium' },
		phases: {
			plan: {
				cycle: { kind: 'review', cycleCount: 1 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			work: {
				cycle: { kind: 'review', cycleCount: 2 },
				agentInstructions: null,
				reviewerInstructions: null,
				skills: [],
			},
			wrapup: { instructions: null, skills: [] },
		},
	}),
};

const REVIEW = { approved: false, summary: 'needs work', comments: [] };

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-state-test-'));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('task-state reducer', () => {
	it('maps phase-started events to active role statuses', () => {
		const state = createInitialState('task-1', TEST_CONFIG);

		const planning = applyEvent(state, { event: 'phase-started', phase: 'plan' });
		const working = applyEvent(state, { event: 'phase-started', phase: 'work' });
		const wrapping = applyEvent(state, { event: 'phase-started', phase: 'wrapup' });

		expect(planning.status).toBe('plan-agent');
		expect(planning.currentCycle).toBe(0);
		expect(planning.currentMaxCycles).toBe(1);
		expect(working.status).toBe('work-agent');
		expect(working.currentMaxCycles).toBe(2);
		expect(wrapping.status).toBe('wrapup');
		expect(wrapping.currentMaxCycles).toBe(0);
	});

	it('tracks plan agent and reviewer turns', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const started = applyEvent(state, { event: 'phase-started', phase: 'plan' });
		const afterPlan = applyEvent(started, {
			event: 'plan-agent-turn',
			cycle: 1,
			threadId: 'plan-thread',
			tokenCount: 10,
		});
		const afterReview = applyEvent(afterPlan, {
			event: 'plan-reviewer-turn',
			cycle: 1,
			threadId: 'review-thread',
			tokenCount: 11,
			review: REVIEW,
		});

		expect(afterPlan.status).toBe('plan-agent');
		expect(afterPlan.planAgentThreadId).toBe('plan-thread');
		expect(afterPlan.currentCycle).toBe(1);
		expect(afterPlan.currentMaxCycles).toBe(1);
		expect(afterReview.status).toBe('plan-reviewer');
		expect(afterReview.planReviewerThreadId).toBe('review-thread');
		expect(afterReview.planReviewCycle).toBe(1);
		expect(afterReview.lastPlanReview).toEqual(REVIEW);
	});

	it('stores finalized plan', () => {
		const state = createInitialState('task-1', TEST_CONFIG);

		expect(applyEvent(state, { event: 'plan-finalized', plan: 'final plan' }).plan).toBe(
			'final plan',
		);
	});

	it('tracks work reviewer validation results', () => {
		const state = applyEvent(createInitialState('task-1', TEST_CONFIG), {
			event: 'phase-started',
			phase: 'work',
		});
		const afterWorkTurn = applyEvent(state, {
			event: 'work-agent-turn',
			cycle: 1,
			threadId: 'work-thread',
			tokenCount: 10,
		});
		const next = applyEvent(afterWorkTurn, {
			event: 'work-reviewer-turn',
			cycle: 1,
			threadId: 'work-review-thread',
			tokenCount: 12,
			review: REVIEW,
			validationResults: [{ name: 'test', passed: false, exitCode: 1, output: 'failed' }],
			validationSkipped: false,
		});

		expect(afterWorkTurn.currentCycle).toBe(1);
		expect(afterWorkTurn.currentMaxCycles).toBe(2);
		expect(next.status).toBe('work-reviewer');
		expect(next.workReviewerThreadId).toBe('work-review-thread');
		expect(next.workReviewCycle).toBe(1);
		expect(next.lastWorkReview).toEqual(REVIEW);
		expect(next.lastValidationResults).toEqual([
			{ name: 'test', passed: false, exitCode: 1, output: 'failed' },
		]);
	});

	it('stores wrapup results without marking the task completed', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const nextState = applyEvent(state, {
			event: 'wrapup-result',
			prUrl: 'https://example.com/pr/1',
			branchName: 'agent/task-1',
			pushedCommits: ['abc123'],
		});

		expect(nextState.status).toBe('pending');
		expect(nextState.wrapupResult).toEqual({
			prUrl: 'https://example.com/pr/1',
			branchName: 'agent/task-1',
			pushedCommits: ['abc123'],
		});
	});

	it('stores context errors without changing status', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const next = applyEvent(state, {
			event: 'context-gather-failed',
			reason: 'workspace not readable',
		});

		expect(next.lastContextError).toBe('workspace not readable');
		expect(next.status).toBe('pending');
	});

	it('stores terminal failure reason', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const failedState = applyEvent(state, {
			event: 'task-failed',
			reason: 'tool crashed',
		});

		expect(failedState.status).toBe('failed');
		expect(failedState.failureReason).toBe('tool crashed');
	});

	it('treats task-closed as terminal', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const closedState = applyEvent(state, { event: 'task-closed' });

		expect(closedState.status).toBe('closed');
		expect(isTerminal(closedState)).toBe(true);
	});
});

describe('loadTaskStateFromLog', () => {
	it('returns null for a missing file', async () => {
		const state = await loadTaskStateFromLog(path.join(tmpDir, 'missing.jsonl'));
		expect(state).toBeNull();
	});

	it('rebuilds TaskState from a task-accepted + task-completed sequence', async () => {
		const filePath = path.join(tmpDir, 'abc.jsonl');
		await appendEvent(filePath, {
			event: 'task-accepted',
			taskId: 'abc',
			config: { ...TEST_CONFIG, taskId: 'abc', prompt: 'hello' },
		});
		await appendEvent(filePath, { event: 'task-completed' });

		const state = await loadTaskStateFromLog(filePath);
		expect(state?.taskId).toBe('abc');
		expect(state?.status).toBe('completed');
	});
});
