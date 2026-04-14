import { describe, expect, it } from 'vitest';

import { workerConfigSchema } from '../config/worker-config.js';
import type { TaskConfig } from './task-event-types.js';
import { applyEvent, createInitialState, isTerminal } from './task-state.js';

const TEST_CONFIG: TaskConfig = {
	taskId: 'task-1',
	prompt: 'fix bug',
	repos: [],
	context: {},
	effectiveConfig: workerConfigSchema.parse({}),
};

describe('task-state reducer', () => {
	it('maps phase-started events to the expected statuses', () => {
		const state = createInitialState('task-1', TEST_CONFIG);

		expect(applyEvent(state, { event: 'phase-started', phase: 'plan' }).status).toBe('planning');
		expect(
			applyEvent(state, { event: 'phase-started', phase: 'plan-review', loop: 1 }).status,
		).toBe('reviewing-plan');
		expect(applyEvent(state, { event: 'phase-started', phase: 'work' }).status).toBe('working');
		expect(applyEvent(state, { event: 'phase-started', phase: 'verification' }).status).toBe(
			'verifying',
		);
		expect(
			applyEvent(state, { event: 'phase-started', phase: 'work-review', loop: 1 }).status,
		).toBe('reviewing-work');
		expect(applyEvent(state, { event: 'phase-started', phase: 'wrapup' }).status).toBe(
			'wrapping-up',
		);
	});

	it('increments verification attempts only when verification fails', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const failedVerificationState = applyEvent(state, {
			event: 'verification-result',
			results: [{ name: 'test', passed: false, exitCode: 1, output: 'failed' }],
		});
		const passedVerificationState = applyEvent(failedVerificationState, {
			event: 'verification-result',
			results: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
		});

		expect(failedVerificationState.verificationAttempt).toBe(1);
		expect(passedVerificationState.verificationAttempt).toBe(1);
	});

	it('stores wrapup results without marking the task completed', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const nextState = applyEvent(state, {
			event: 'wrapup-result',
			actions: [{ key: 'git-pr:0', type: 'git-pr', success: true, artifact: 'https://example/pr' }],
		});

		expect(nextState.status).toBe('pending');
		expect(nextState.wrapupResults).toEqual([
			{ key: 'git-pr:0', type: 'git-pr', success: true, artifact: 'https://example/pr' },
		]);
	});

	it('tracks degraded context and diff reads without changing terminal state', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const contextErrorState = applyEvent(state, {
			event: 'context-gather-failed',
			reason: 'workspace not readable',
		});
		const diffErrorState = applyEvent(contextErrorState, {
			event: 'diff-read-failed',
			reason: 'git diff failed',
			loop: 1,
		});

		expect(contextErrorState.lastContextError).toBe('workspace not readable');
		expect(diffErrorState.lastDiffError).toBe('git diff failed');
		expect(diffErrorState.status).toBe('pending');
	});

	it('treats task-closed as a distinct terminal status', () => {
		const state = createInitialState('task-1', TEST_CONFIG);
		const closedState = applyEvent(state, { event: 'task-closed' });

		expect(closedState.status).toBe('closed');
		expect(isTerminal(closedState)).toBe(true);
	});
});
