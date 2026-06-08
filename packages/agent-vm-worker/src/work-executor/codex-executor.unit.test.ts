/* oxlint-disable typescript-eslint/no-unsafe-assignment -- expect matchers intentionally carry loose matcher types in tests */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkExecutor } from './executor-factory.js';
import type { ExecutorResult, StructuredInput, WorkExecutor } from './executor-interface.js';

interface MockSdkThread {
	id: string;
	run: ReturnType<typeof vi.fn>;
}

const hoistedMocks = vi.hoisted(() => ({
	mockStartThread: vi.fn(),
	mockResumeThread: vi.fn(),
	execaMock: vi.fn(),
	getOrCreateLocalToolMcpServerMock: vi.fn(),
	codexConstructorMock: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => {
	class MockCodex {
		constructor(options?: unknown) {
			hoistedMocks.codexConstructorMock(options);
		}
		startThread = hoistedMocks.mockStartThread;
		resumeThread = hoistedMocks.mockResumeThread;
	}

	return { Codex: MockCodex };
});

vi.mock('execa', () => ({
	execa: hoistedMocks.execaMock,
}));

vi.mock('./local-tool-mcp-server.js', () => ({
	getOrCreateLocalToolMcpServer: hoistedMocks.getOrCreateLocalToolMcpServerMock,
}));

const {
	mockStartThread,
	mockResumeThread,
	execaMock,
	getOrCreateLocalToolMcpServerMock,
	codexConstructorMock,
} = hoistedMocks;

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
		execaMock.mockReset();
		getOrCreateLocalToolMcpServerMock.mockReset();
		codexConstructorMock.mockReset();
		getOrCreateLocalToolMcpServerMock.mockResolvedValue(null);
		delete process.env.STATE_DIR;
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
		expect(execaMock).not.toHaveBeenCalled();
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

	it('resumeOrRebuild() rebuilds on recoverable resume errors', async () => {
		mockResumeThread.mockImplementation(() => {
			throw new Error('Resume failed', {
				cause: new Error('Thread expired with 404'),
			});
		});
		const rebuiltThread = createMockThread('thread-2', 'context rebuilt', 10);
		mockStartThread.mockReturnValue(rebuiltThread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		await executor.resumeOrRebuild('expired-thread', [{ type: 'text', text: 'context' }]);

		expect(mockResumeThread).toHaveBeenCalledWith(
			'expired-thread',
			expect.objectContaining({
				model: 'latest',
			}),
		);
		expect(mockStartThread).toHaveBeenCalled();
		expect(executor.getThreadId()).toBe('thread-2');
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to resume thread expired-thread; rebuilding thread instead'),
		);
	});

	it('resumeOrRebuild() rethrows non-recoverable resume errors', async () => {
		mockResumeThread.mockImplementation(() => {
			throw new Error('permission denied');
		});

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		await expect(
			executor.resumeOrRebuild('bad-thread', [{ type: 'text', text: 'context' }]),
		).rejects.toThrow('permission denied');
		expect(mockStartThread).not.toHaveBeenCalled();
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

	it('registers remote mcp servers before starting codex', async () => {
		const thread = createMockThread('thread-1', 'done', 5);
		mockStartThread.mockReturnValue(thread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: {
				mcpServers: [{ name: 'deepwiki', url: 'http://127.0.0.1:4000/mcp' }],
				tools: [],
			},
		});

		await executor.execute([{ type: 'text', text: 'hello' }]);

		expect(execaMock).toHaveBeenCalledWith(
			'codex',
			['mcp', 'add', 'deepwiki', '--url', 'http://127.0.0.1:4000/mcp'],
			// oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
			expect.objectContaining({
				env: expect.objectContaining({
					HOME: expect.any(String),
				}),
			}),
		);
		expect(codexConstructorMock).toHaveBeenCalledWith(
			// oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
			expect.objectContaining({
				env: expect.objectContaining({
					HOME: expect.stringContaining(`${tmpdir()}/agent-vm-codex-home-`),
				}),
			}),
		);
	});

	it('registers remote mcp servers with bearer token env vars', async () => {
		const thread = createMockThread('thread-1', 'done', 5);
		mockStartThread.mockReturnValue(thread);

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: {
				mcpServers: [
					{
						name: 'internal-docs',
						url: 'http://127.0.0.1:4100/mcp',
						bearerTokenEnvVar: 'INTERNAL_DOCS_TOKEN',
					},
				],
				tools: [],
			},
		});

		await executor.execute([{ type: 'text', text: 'hello' }]);

		expect(execaMock).toHaveBeenCalledWith(
			'codex',
			[
				'mcp',
				'add',
				'internal-docs',
				'--url',
				'http://127.0.0.1:4100/mcp',
				'--bearer-token-env-var',
				'INTERNAL_DOCS_TOKEN',
			],
			// oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
			expect.objectContaining({
				env: expect.objectContaining({
					HOME: expect.any(String),
				}),
			}),
		);
	});

	it('uses STATE_DIR for temporary codex home when available', async () => {
		const thread = createMockThread('thread-1', 'done', 5);
		mockStartThread.mockReturnValue(thread);
		process.env.STATE_DIR = join(tmpdir(), 'agent-vm-worker-state-test');

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: { mcpServers: [], tools: [] },
		});

		await executor.execute([{ type: 'text', text: 'hello' }]);

		expect(codexConstructorMock).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.objectContaining({
					HOME: expect.stringContaining(`${process.env.STATE_DIR}/agent-vm-codex-home-`),
				}),
			}),
		);
	});

	it('registers a local tool mcp server when tools are provided', async () => {
		const thread = createMockThread('thread-1', 'done', 5);
		mockStartThread.mockReturnValue(thread);
		getOrCreateLocalToolMcpServerMock.mockResolvedValue({
			url: 'http://127.0.0.1:4555/mcp',
		});

		const { createCodexExecutor } = await import('./codex-executor.js');
		const executor = createCodexExecutor({
			model: 'latest',
			capabilities: {
				mcpServers: [],
				tools: [
					{
						name: 'git-push',
						description: 'Push branch',
						inputSchema: { type: 'object', properties: {} },
						execute: async () => ({ ok: true }),
					},
				],
			},
		});

		await executor.execute([{ type: 'text', text: 'hello' }]);

		expect(getOrCreateLocalToolMcpServerMock).toHaveBeenCalledWith([
			expect.objectContaining({ name: 'git-push' }),
		]);
		expect(execaMock).toHaveBeenCalledWith(
			'codex',
			['mcp', 'add', 'agent-vm-local-tools', '--url', 'http://127.0.0.1:4555/mcp'],
			expect.any(Object),
		);
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
