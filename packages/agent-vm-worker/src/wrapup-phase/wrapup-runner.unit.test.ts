import { describe, expect, test, vi } from 'vitest';

import type { PersistentThread } from '../work-executor/persistent-thread.js';
import { runWrapup } from './wrapup-runner.js';

function buildThread(
	responses:
		| string
		| readonly string[] = '{"summary":"ok","prUrl":null,"branchName":"agent/task","pushedCommits":[]}',
): {
	readonly thread: PersistentThread;
	readonly inputs: string[];
} {
	const inputs: string[] = [];
	const queuedResponses = Array.isArray(responses) ? [...responses] : [responses];
	return {
		inputs,
		thread: {
			send: vi.fn(async (input: string) => {
				inputs.push(input);
				return {
					response: queuedResponses.shift() ?? '',
					tokenCount: 10,
					threadId: 'wrapup-thread',
				};
			}),
			threadId: () => 'wrapup-thread',
		},
	};
}

describe('runWrapup', () => {
	test('sends wrapup prompt and parses final answer', async () => {
		const { thread, inputs } = buildThread(
			JSON.stringify({
				summary: 'pushed and opened PR',
				prUrl: 'https://github.com/org/repo/pull/1',
				branchName: 'agent/task',
				pushedCommits: ['abc123'],
			}),
		);
		const onWrapupTurn = vi.fn();

		const result = await runWrapup({
			wrapupThread: thread,
			systemPromptWrapup: 'WRAPUP SYSTEM',
			spec: 'fix bug',
			plan: 'approved plan',
			workSummary: 'changed README',
			gitContext: 'Current branch: agent/task',
			validationResults: [{ name: 'test', passed: true, exitCode: 0, output: '' }],
			validationSkipped: false,
			onWrapupTurn,
		});

		expect(inputs[0]).toContain('WRAPUP SYSTEM');
		expect(inputs[0]).toContain('approved plan');
		expect(inputs[0]).toContain('changed README');
		expect(inputs[0]).toContain('Original task');
		expect(inputs[0]).toContain('Work-agent summary');
		expect(inputs[0]).toContain('Controller/git context');
		expect(inputs[0]).toContain('Required output JSON');
		expect(inputs[0]).toContain('prUrl');
		expect(result).toEqual({
			summary: 'pushed and opened PR',
			prUrl: 'https://github.com/org/repo/pull/1',
			branchName: 'agent/task',
			pushedCommits: ['abc123'],
		});
		expect(onWrapupTurn).toHaveBeenCalledWith({
			response: expect.any(String),
			tokenCount: 10,
			threadId: 'wrapup-thread',
		});
	});

	test('retries once when the wrapup response is not JSON', async () => {
		const { thread, inputs } = buildThread([
			'I pushed the branch and opened https://github.com/org/repo/pull/2',
			JSON.stringify({
				summary: 'pushed on retry',
				prUrl: 'https://github.com/org/repo/pull/2',
				branchName: 'agent/task',
				pushedCommits: ['abc123'],
			}),
		]);

		const result = await runWrapup({
			wrapupThread: thread,
			systemPromptWrapup: 'WRAPUP SYSTEM',
			spec: 'fix bug',
			plan: 'approved plan',
			workSummary: 'work summary',
			gitContext: 'git status',
			validationResults: [],
			validationSkipped: false,
			onWrapupTurn: () => {},
		});

		expect(inputs).toHaveLength(2);
		expect(inputs[1]).toContain('Return only valid JSON');
		expect(result).toEqual({
			summary: 'pushed on retry',
			prUrl: 'https://github.com/org/repo/pull/2',
			branchName: 'agent/task',
			pushedCommits: ['abc123'],
		});
	});

	test('falls back to raw summary when retry is still not JSON', async () => {
		const { thread } = buildThread([
			'not json',
			'Created https://github.com/org/repo/pull/3 but forgot JSON',
		]);

		const result = await runWrapup({
			wrapupThread: thread,
			systemPromptWrapup: 'WRAPUP SYSTEM',
			spec: 'fix bug',
			plan: 'approved plan',
			workSummary: 'work summary',
			gitContext: 'git status',
			validationResults: [],
			validationSkipped: false,
			onWrapupTurn: () => {},
		});

		expect(result).toEqual({
			summary: 'Created https://github.com/org/repo/pull/3 but forgot JSON',
			prUrl: 'https://github.com/org/repo/pull/3',
			branchName: null,
			pushedCommits: [],
		});
	});
});
