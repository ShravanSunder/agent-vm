import { describe, expect, test, vi } from 'vitest';

import type { WorkExecutor } from './executor-interface.js';
import { createPersistentThread } from './persistent-thread.js';

function inputText(input: readonly { readonly type: string; readonly text?: string }[]): string {
	const first = input[0];
	return first && first.type === 'text' ? (first.text ?? '') : '';
}

function buildMockExecutor(
	responses: Array<{
		readonly response: string;
		readonly tokenCount: number;
		readonly threadId: string;
	}>,
): {
	readonly executor: WorkExecutor;
	readonly calls: Array<{ readonly method: string; readonly input: string }>;
} {
	const calls: Array<{ readonly method: string; readonly input: string }> = [];
	let responseIndex = 0;
	function nextResponse(): {
		readonly response: string;
		readonly tokenCount: number;
		readonly threadId: string;
	} {
		const response = responses[responseIndex];
		responseIndex += 1;
		if (!response) {
			throw new Error('Mock executor response queue exhausted');
		}
		return response;
	}

	const executor: WorkExecutor = {
		async execute(input) {
			calls.push({ method: 'execute', input: inputText(input) });
			return nextResponse();
		},
		async fix(input) {
			calls.push({ method: 'fix', input: inputText(input) });
			return nextResponse();
		},
		async resumeOrRebuild() {},
		getThreadId() {
			return responses[Math.max(0, responseIndex - 1)]?.threadId ?? null;
		},
	};

	return { executor, calls };
}

describe('createPersistentThread', () => {
	test('first send calls execute and later sends call fix', async () => {
		const { executor, calls } = buildMockExecutor([
			{ response: 'r1', tokenCount: 10, threadId: 'thread-1' },
			{ response: 'r2', tokenCount: 11, threadId: 'thread-1' },
			{ response: 'r3', tokenCount: 12, threadId: 'thread-1' },
		]);
		const thread = createPersistentThread({ executor, turnTimeoutMs: 5_000 });

		const first = await thread.send('turn 1');
		await thread.send('turn 2');
		const third = await thread.send('turn 3');

		expect(calls).toEqual([
			{ method: 'execute', input: 'turn 1' },
			{ method: 'fix', input: 'turn 2' },
			{ method: 'fix', input: 'turn 3' },
		]);
		expect(first.response).toBe('r1');
		expect(third.threadId).toBe('thread-1');
	});

	test('throws on turn timeout', async () => {
		const executor: WorkExecutor = {
			execute: () => new Promise(() => {}),
			fix: () => new Promise(() => {}),
			async resumeOrRebuild() {},
			getThreadId: () => null,
		};
		const thread = createPersistentThread({ executor, turnTimeoutMs: 25 });

		await expect(thread.send('never')).rejects.toThrow(/timed out/i);
	});

	test('threadId delegates to executor', () => {
		const executor = {
			execute: vi.fn(),
			fix: vi.fn(),
			resumeOrRebuild: vi.fn(),
			getThreadId: vi.fn(() => 'thread-xyz'),
		} as unknown as WorkExecutor;
		const thread = createPersistentThread({ executor, turnTimeoutMs: 1_000 });

		expect(thread.threadId()).toBe('thread-xyz');
	});
});
