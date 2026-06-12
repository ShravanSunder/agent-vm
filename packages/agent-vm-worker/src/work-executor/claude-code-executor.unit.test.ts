/* oxlint-disable typescript-eslint/no-unsafe-assignment -- SDK fixture types are intentionally narrowed to the fields the executor reads. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkExecutor } from './executor-factory.js';
import type { StructuredInput } from './executor-interface.js';
import { createPersistentThread } from './persistent-thread.js';

const hoistedMocks = vi.hoisted(() => ({
	getOrCreateLocalToolMcpServerMock: vi.fn(),
	queryMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: hoistedMocks.queryMock,
}));

vi.mock('./local-tool-mcp-server.js', () => ({
	getOrCreateLocalToolMcpServer: hoistedMocks.getOrCreateLocalToolMcpServerMock,
}));

const { getOrCreateLocalToolMcpServerMock, queryMock } = hoistedMocks;

interface CapturedQueryCall {
	readonly options?: {
		readonly allowDangerouslySkipPermissions?: boolean;
		readonly cwd?: string;
		readonly effort?: string;
		readonly env?: Record<string, string | undefined>;
		readonly pathToClaudeCodeExecutable?: string;
		readonly settingSources?: readonly string[];
		readonly mcpServers?: Record<string, unknown>;
		readonly model?: string;
		readonly permissionMode?: string;
		readonly resume?: string;
	};
	readonly prompt: string;
}

function createResultMessage(options: {
	readonly outputTokens: number;
	readonly response: string;
	readonly sessionRef: string;
}): unknown {
	return {
		type: 'result',
		subtype: 'success',
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: options.response,
		stop_reason: 'end_turn',
		total_cost_usd: 0,
		usage: { output_tokens: options.outputTokens },
		modelUsage: {},
		permission_denials: [],
		uuid: '00000000-0000-4000-8000-000000000000',
		session_id: options.sessionRef,
	};
}

function createErrorResultMessage(sessionRef: string, errors: readonly string[]): unknown {
	return {
		type: 'result',
		subtype: 'error_during_execution',
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: true,
		num_turns: 1,
		stop_reason: 'error',
		total_cost_usd: 0,
		usage: { output_tokens: 0 },
		modelUsage: {},
		permission_denials: [],
		errors: [...errors],
		uuid: '00000000-0000-4000-8000-000000000001',
		session_id: sessionRef,
	};
}

function createQuery(messages: readonly unknown[]): AsyncGenerator<unknown, void> {
	return (async function* streamMessages(): AsyncGenerator<unknown, void> {
		for (const message of messages) {
			yield message;
		}
	})();
}

function createClosableNeverEndingQuery(closeMock: () => void): unknown {
	let resolveWait: (() => void) | undefined;
	const query = (async function* streamMessages(): AsyncGenerator<unknown, void> {
		await new Promise<void>((resolve) => {
			resolveWait = resolve;
		});
		yield* [];
	})();
	return Object.assign(query, {
		close: () => {
			closeMock();
			resolveWait?.();
		},
	});
}

function capturedQueryCalls(): readonly CapturedQueryCall[] {
	return queryMock.mock.calls.map((call: readonly unknown[]): CapturedQueryCall => {
		const [params] = call;
		if (typeof params !== 'object' || params === null) {
			throw new Error('Expected query params object.');
		}
		return params as CapturedQueryCall;
	});
}

describe('claude-code-executor', () => {
	beforeEach(() => {
		queryMock.mockReset();
		getOrCreateLocalToolMcpServerMock.mockReset();
		getOrCreateLocalToolMcpServerMock.mockResolvedValue(null);
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.INTERNAL_DOCS_TOKEN;
		delete process.env.STATE_DIR;
	});

	it('execute() starts a fresh Claude query and returns the SDK result', async () => {
		queryMock.mockReturnValue(
			createQuery([
				createResultMessage({
					outputTokens: 42,
					response: 'implemented',
					sessionRef: 'claude-session-1',
				}),
			]),
		);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
			reasoningEffort: 'high',
			workingDirectory: '/work/repos/project',
		});

		const result = await executor.execute([{ type: 'text', text: 'do the thing' }]);

		expect(result).toEqual({
			response: 'implemented',
			sessionRef: 'claude-session-1',
			tokenCount: 42,
		});
		expect(executor.getSessionRef()).toBe('claude-session-1');
		expect(capturedQueryCalls()[0]).toMatchObject({
			prompt: 'do the thing',
			options: {
				allowDangerouslySkipPermissions: true,
				cwd: '/work/repos/project',
				effort: 'high',
				model: 'claude-sonnet-4-6',
				permissionMode: 'bypassPermissions',
			},
		});
	});

	it('isolates Claude HOME and settings under STATE_DIR', async () => {
		queryMock.mockReturnValue(
			createQuery([
				createResultMessage({
					outputTokens: 42,
					response: 'implemented',
					sessionRef: 'claude-session-1',
				}),
			]),
		);
		process.env.STATE_DIR = '/tmp/agent-vm-worker-claude-state-test';

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
			resolveClaudeCodeExecutable: () => '/opt/agent-vm/claude',
		});

		await executor.execute([{ type: 'text', text: 'do the thing' }]);

		expect(capturedQueryCalls()[0]?.options).toMatchObject({
			env: {
				CLAUDE_CONFIG_DIR: expect.stringContaining(
					'/tmp/agent-vm-worker-claude-state-test/agent-vm-claude-home-',
				),
				HOME: expect.stringContaining(
					'/tmp/agent-vm-worker-claude-state-test/agent-vm-claude-home-',
				),
			},
			pathToClaudeCodeExecutable: '/opt/agent-vm/claude',
			settingSources: [],
		});
	});

	it('throws an actionable error when the Claude SDK runtime is unavailable', async () => {
		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');

		expect(() =>
			createClaudeCodeExecutor({
				capabilities: { mcpServers: [], tools: [] },
				model: 'claude-sonnet-4-6',
				resolveClaudeCodeExecutable: () => {
					throw new Error('Native CLI binary for linux-x64 not found.');
				},
			}),
		).toThrow(
			'Claude Code runtime is unavailable. Reinstall @anthropic-ai/claude-agent-sdk without omitting optional dependencies.',
		);
	});

	it('fix() resumes the current Claude session', async () => {
		queryMock
			.mockReturnValueOnce(
				createQuery([
					createResultMessage({
						outputTokens: 10,
						response: 'started',
						sessionRef: 'claude-session-1',
					}),
				]),
			)
			.mockReturnValueOnce(
				createQuery([
					createResultMessage({
						outputTokens: 11,
						response: 'fixed',
						sessionRef: 'claude-session-1',
					}),
				]),
			);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
		});

		await executor.execute([{ type: 'text', text: 'initial' }]);
		const result = await executor.fix([{ type: 'text', text: 'fix it' }]);

		expect(result.response).toBe('fixed');
		expect(capturedQueryCalls()[1]?.options?.resume).toBe('claude-session-1');
	});

	it('fix() fails safely when Claude cannot resume the prior session', async () => {
		queryMock
			.mockReturnValueOnce(
				createQuery([
					createResultMessage({
						outputTokens: 10,
						response: 'started',
						sessionRef: 'claude-session-1',
					}),
				]),
			)
			.mockImplementationOnce(() => {
				throw new Error('Session not found: 404');
			})
			.mockReturnValueOnce(
				createQuery([
					createResultMessage({
						outputTokens: 11,
						response: 'rebuilt incorrectly',
						sessionRef: 'claude-session-2',
					}),
				]),
			);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
		});

		await executor.execute([{ type: 'text', text: 'initial' }]);

		await expect(executor.fix([{ type: 'text', text: 'revise it' }])).rejects.toThrow(
			'Claude session claude-session-1 could not be resumed and cannot be safely rebuilt without the prior assistant transcript.',
		);
		expect(queryMock).toHaveBeenCalledTimes(2);
	});

	it('fix() throws before a session exists', async () => {
		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
		});

		await expect(executor.fix([{ type: 'text', text: 'fix' }])).rejects.toThrow(
			'No active Claude session. Call execute() first.',
		);
	});

	it('maps skill input into the Claude prompt', async () => {
		queryMock.mockReturnValue(
			createQuery([
				createResultMessage({
					outputTokens: 3,
					response: 'done',
					sessionRef: 'claude-session-1',
				}),
			]),
		);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
		});
		const input: readonly StructuredInput[] = [
			{ type: 'text', text: 'implement' },
			{ type: 'skill', name: 'tdd', content: 'write tests first' },
		];

		await executor.execute(input);

		expect(capturedQueryCalls()[0]?.prompt).toBe('implement\n\n[Skill: tdd]\n\nwrite tests first');
	});

	it('configures HTTP MCP servers and local tool MCP server for Claude', async () => {
		process.env.INTERNAL_DOCS_TOKEN = 'docs-token';
		getOrCreateLocalToolMcpServerMock.mockResolvedValue({ url: 'http://127.0.0.1:4500/mcp' });
		queryMock.mockReturnValue(
			createQuery([
				createResultMessage({
					outputTokens: 1,
					response: 'done',
					sessionRef: 'claude-session-1',
				}),
			]),
		);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: {
				mcpServers: [
					{
						bearerTokenEnvVar: 'INTERNAL_DOCS_TOKEN',
						name: 'internal-docs',
						url: 'https://docs.example.test/mcp',
					},
				],
				tools: [
					{
						description: 'Validate the repo',
						execute: async () => 'ok',
						inputSchema: {},
						name: 'validate',
					},
				],
			},
			model: 'claude-sonnet-4-6',
		});

		await executor.execute([{ type: 'text', text: 'use tools' }]);

		expect(capturedQueryCalls()[0]?.options?.mcpServers).toEqual({
			'agent-vm-local-tools': {
				alwaysLoad: true,
				type: 'http',
				url: 'http://127.0.0.1:4500/mcp',
			},
			'internal-docs': {
				headers: { Authorization: 'Bearer docs-token' },
				type: 'http',
				url: 'https://docs.example.test/mcp',
			},
		});
	});

	it('fails loudly when a bearer-token MCP env var is missing', async () => {
		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: {
				mcpServers: [
					{
						bearerTokenEnvVar: 'INTERNAL_DOCS_TOKEN',
						name: 'internal-docs',
						url: 'https://docs.example.test/mcp',
					},
				],
				tools: [],
			},
			model: 'claude-sonnet-4-6',
		});

		await expect(executor.execute([{ type: 'text', text: 'use docs' }])).rejects.toThrow(
			"Claude MCP server 'internal-docs' requires env var INTERNAL_DOCS_TOKEN.",
		);
		expect(queryMock).not.toHaveBeenCalled();
	});

	it('maps minimal reasoning effort to Claude low effort', async () => {
		queryMock.mockReturnValue(
			createQuery([
				createResultMessage({
					outputTokens: 1,
					response: 'done',
					sessionRef: 'claude-session-1',
				}),
			]),
		);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
			reasoningEffort: 'minimal',
		});

		await executor.execute([{ type: 'text', text: 'think lightly' }]);

		expect(capturedQueryCalls()[0]?.options?.effort).toBe('low');
	});

	it('throws structured SDK result errors', async () => {
		queryMock.mockReturnValue(
			createQuery([createErrorResultMessage('claude-session-1', ['authentication failed'])]),
		);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
		});

		await expect(executor.execute([{ type: 'text', text: 'fail' }])).rejects.toThrow(
			'Claude query failed: authentication failed',
		);
	});

	it('resumeOrRebuild() rebuilds from context when no session ref exists', async () => {
		queryMock.mockReturnValue(
			createQuery([
				createResultMessage({
					outputTokens: 5,
					response: 'context loaded',
					sessionRef: 'rebuilt-session',
				}),
			]),
		);

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
		});

		await executor.resumeOrRebuild(null, [{ type: 'text', text: 'context' }]);

		expect(executor.getSessionRef()).toBe('rebuilt-session');
		expect(capturedQueryCalls()[0]?.prompt).toBe('context');
	});

	it('closes the active Claude query when the persistent thread turn times out', async () => {
		const closeMock = vi.fn();
		queryMock.mockReturnValue(createClosableNeverEndingQuery(closeMock));

		const { createClaudeCodeExecutor } = await import('./claude-code-executor.js');
		const executor = createClaudeCodeExecutor({
			capabilities: { mcpServers: [], tools: [] },
			model: 'claude-sonnet-4-6',
		});
		const thread = createPersistentThread({ executor, turnTimeoutMs: 50 });

		await expect(thread.send('hang')).rejects.toThrow('persistent-thread.send timed out');
		expect(closeMock).toHaveBeenCalledTimes(1);
	});
});

describe('executor-factory claude provider', () => {
	it('returns a Claude executor for claude provider', () => {
		const executor = createWorkExecutor('claude', 'claude-sonnet-4-6', {
			mcpServers: [],
			tools: [],
		});

		expect(executor.getSessionRef()).toBeNull();
	});
});
