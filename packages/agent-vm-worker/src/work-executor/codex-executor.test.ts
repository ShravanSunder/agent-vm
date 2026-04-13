import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkExecutor } from './executor-factory.js';
import type { ExecutorResult, StructuredInput, WorkExecutor } from './executor-interface.js';

interface MockSdkThread {
	id: string;
	run: ReturnType<typeof vi.fn>;
}

const mockStartThread = vi.fn();
const mockResumeThread = vi.fn();

vi.mock('@openai/codex-sdk', () => {
	class MockCodex {
		startThread = mockStartThread;
		resumeThread = mockResumeThread;
	}

	return { Codex: MockCodex };
});

function createMockThread(id: string, response: string, outputTokens: number): MockSdkThread {
	return {
		id,
		run: vi.fn().mockResolvedValue({
			finalResponse: response,
			usage: { output_tokens: outputTokens },
		}),
	};
}

function createMockWorkExecutor(): WorkExecutor & {
	readonly executeCalls: StructuredInput[][];
	readonly fixCalls: StructuredInput[][];
} {
	let currentThreadId: string | null = null;
	const executeCalls: StructuredInput[][] = [];
	const fixCalls: StructuredInput[][] = [];
	let threadCounter = 0;

	return {
		async execute(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			executeCalls.push([...input]);
			threadCounter += 1;
			currentThreadId = `thread-${threadCounter}`;
			return {
				response: 'executed',
				tokenCount: 50,
				threadId: currentThreadId,
			};
		},

		async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			if (currentThreadId === null) {
				throw new Error('No active executor thread. Call execute() first.');
			}
			fixCalls.push([...input]);
			return {
				response: 'fixed',
				tokenCount: 30,
				threadId: currentThreadId,
			};
		},

		async resumeOrRebuild(threadId: string | null): Promise<void> {
			if (threadId) {
				currentThreadId = threadId;
				return;
			}
			threadCounter += 1;
			currentThreadId = `thread-${threadCounter}`;
		},

		getThreadId(): string | null {
			return currentThreadId;
		},

		executeCalls,
		fixCalls,
	};
}

describe('codex-executor', () => {
	beforeEach(() => {
		mockStartThread.mockReset();
		mockResumeThread.mockReset();
	});

	it('execute() starts a new thread and returns result', async () => {
		const thread = createMockThread('thread-1', 'executed', 50);
		mockStartThread.mockReturnValue(thread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		const result = await executor.execute([{ type: 'text', text: 'do the thing' }]);

		expect(result).toEqual({
			response: 'executed',
			tokenCount: 50,
			threadId: 'thread-1',
		});
		expect(executor.getThreadId()).toBe('thread-1');
		expect(thread.run).toHaveBeenCalledWith([{ type: 'text', text: 'do the thing' }]);
	});

	it('fix() continues the same thread', async () => {
		const thread = createMockThread('thread-1', 'executed', 50);
		thread.run
			.mockResolvedValueOnce({ finalResponse: 'executed', usage: { output_tokens: 50 } })
			.mockResolvedValueOnce({ finalResponse: 'fixed', usage: { output_tokens: 30 } });
		mockStartThread.mockReturnValue(thread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		await executor.execute([{ type: 'text', text: 'initial' }]);
		const result = await executor.fix([{ type: 'text', text: 'fix this' }]);

		expect(result.response).toBe('fixed');
		expect(result.threadId).toBe('thread-1');
	});

	it('fix() throws when no thread exists', async () => {
		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		await expect(executor.fix([{ type: 'text', text: 'fix' }])).rejects.toThrow(
			'No active executor thread',
		);
	});

	it('resumeOrRebuild() resumes existing thread', async () => {
		const thread = createMockThread('existing-thread', 'ignored', 0);
		mockResumeThread.mockReturnValue(thread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		await executor.resumeOrRebuild('existing-thread', []);
		expect(executor.getThreadId()).toBe('existing-thread');
	});

	it('resumeOrRebuild() rebuilds when threadId is null', async () => {
		const thread = createMockThread('thread-1', 'context built', 10);
		mockStartThread.mockReturnValue(thread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		await executor.resumeOrRebuild(null, [{ type: 'text', text: 'context' }]);
		expect(executor.getThreadId()).toBe('thread-1');
	});

	it('maps skill inputs to inline text instructions', async () => {
		const thread = createMockThread('thread-1', 'done', 5);
		mockStartThread.mockReturnValue(thread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		await executor.execute([
			{ type: 'text', text: 'implement plan' },
			{ type: 'skill', name: 'tdd', content: 'Write tests first.' },
		]);

		expect(thread.run).toHaveBeenCalledWith([
			{ type: 'text', text: 'implement plan' },
			{ type: 'text', text: '[Skill: tdd]\n\nWrite tests first.' },
		]);
	});
});

describe('work-executor interface contract', () => {
	let executor: ReturnType<typeof createMockWorkExecutor>;

	beforeEach(() => {
		executor = createMockWorkExecutor();
	});

	it('execute() starts a new thread and returns result', async () => {
		const result = await executor.execute([{ type: 'text', text: 'do the thing' }]);

		expect(result.response).toBe('executed');
		expect(result.tokenCount).toBe(50);
		expect(result.threadId).toBe('thread-1');
		expect(executor.getThreadId()).toBe('thread-1');
	});

	it('fix() continues the same thread', async () => {
		await executor.execute([{ type: 'text', text: 'initial' }]);
		const result = await executor.fix([{ type: 'text', text: 'fix this' }]);

		expect(result.response).toBe('fixed');
		expect(result.threadId).toBe('thread-1');
		expect(executor.fixCalls).toHaveLength(1);
	});

	it('fix() throws when no thread exists', async () => {
		await expect(executor.fix([{ type: 'text', text: 'fix' }])).rejects.toThrow(
			'No active executor thread',
		);
	});

	it('resumeOrRebuild() resumes existing thread', async () => {
		await executor.resumeOrRebuild('existing-thread', []);
		expect(executor.getThreadId()).toBe('existing-thread');
	});

	it('resumeOrRebuild() rebuilds when threadId is null', async () => {
		await executor.resumeOrRebuild(null, [{ type: 'text', text: 'context' }]);
		expect(executor.getThreadId()).toBe('thread-1');
	});

	it('handles skill inputs', async () => {
		await executor.execute([
			{ type: 'text', text: 'implement plan' },
			{ type: 'skill', name: 'tdd', content: 'Write tests first.' },
		]);

		expect(executor.executeCalls[0]).toHaveLength(2);
		expect(executor.executeCalls[0]?.[1]?.type).toBe('skill');
	});
});

describe('executor-factory', () => {
	it('throws for claude provider', () => {
		expect(() => createWorkExecutor('claude', 'latest', { mcpServers: [], tools: [] })).toThrow(
			'Claude executor is not implemented yet.',
		);
	});

	it('throws for unknown provider', () => {
		expect(() => createWorkExecutor('unknown', 'latest', { mcpServers: [], tools: [] })).toThrow(
			"Unknown executor provider: 'unknown'.",
		);
	});
});
