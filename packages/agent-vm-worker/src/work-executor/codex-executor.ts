import fs from 'node:fs/promises';
import path from 'node:path';

import { Codex, type Thread, type UserInput } from '@openai/codex-sdk';
import { execa } from 'execa';

import { writeStderr } from '../shared/stderr.js';
import type {
	ExecutorCapabilities,
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from './executor-interface.js';
import { getOrCreateLocalToolMcpServer } from './local-tool-mcp-server.js';

function extractErrorMessages(error: unknown): readonly string[] {
	if (!(error instanceof Error)) {
		return [String(error)];
	}

	const messages = [error.message];
	if ('cause' in error && error.cause !== undefined) {
		messages.push(...extractErrorMessages(error.cause));
	}
	return messages;
}

function isRecoverableResumeError(error: unknown): boolean {
	const messages = extractErrorMessages(error).map((message) => message.toLowerCase());
	return messages.some(
		(message) =>
			message.includes('expired') ||
			message.includes('thread not found') ||
			message.includes('does not exist') ||
			message.includes('unknown thread') ||
			message.includes('404') ||
			message.includes('no thread found'),
	);
}

export interface CodexExecutorConfig {
	readonly model: string;
	readonly capabilities: ExecutorCapabilities;
	readonly workingDirectory?: string;
	readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

function mapToCodexInput(input: readonly StructuredInput[]): UserInput[] {
	return input.map((item): UserInput => {
		if (item.type === 'text') {
			return { type: 'text', text: item.text };
		}

		return {
			type: 'text',
			text: `[Skill: ${item.name}]\n\n${item.content}`,
		};
	});
}

export function createCodexExecutor(config: CodexExecutorConfig): WorkExecutor {
	const workingDirectory = config.workingDirectory ?? process.cwd();
	let codex: Codex | null = null;
	let currentThread: Thread | null = null;
	let currentThreadId: string | null = null;

	async function ensureCapabilitiesConfigured(): Promise<void> {
		if (codex !== null) {
			return;
		}

		await fs.mkdir(workingDirectory, { recursive: true });
		const codexHomeBase = process.env.STATE_DIR ?? workingDirectory;
		const tempHome = await fs.mkdtemp(path.join(codexHomeBase, '.agent-vm-codex-home-'));
		await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });

		for (const mcpServer of config.capabilities.mcpServers) {
			// MCP registration must be serialized because each command mutates the same config home.
			// oxlint-disable-next-line eslint/no-await-in-loop
			await execa('codex', ['mcp', 'add', mcpServer.name, '--url', mcpServer.url], {
				cwd: workingDirectory,
				env: { ...process.env, HOME: tempHome },
				reject: true,
			});
		}

		const localToolServer = await getOrCreateLocalToolMcpServer(config.capabilities.tools);
		if (localToolServer) {
			await execa('codex', ['mcp', 'add', 'agent-vm-local-tools', '--url', localToolServer.url], {
				cwd: workingDirectory,
				env: { ...process.env, HOME: tempHome },
				reject: true,
			});
		}

		codex = new Codex({
			...(typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length > 0
				? { apiKey: process.env.OPENAI_API_KEY }
				: {}),
			config: {
				skip_git_repo_check: true,
			},
			env: {
				...process.env,
				HOME: tempHome,
			},
		});
	}

	function startNewThread(): Thread {
		if (codex === null) {
			throw new Error('Codex executor has not been configured.');
		}

		return codex.startThread({
			model: config.model,
			approvalPolicy: 'never',
			sandboxMode: 'danger-full-access',
			workingDirectory,
			skipGitRepoCheck: true,
			networkAccessEnabled: true,
			...(config.reasoningEffort ? { modelReasoningEffort: config.reasoningEffort } : {}),
		});
	}

	async function runInThread(
		thread: Thread,
		input: readonly StructuredInput[],
	): Promise<ExecutorResult> {
		const result = await thread.run(mapToCodexInput(input));
		const threadId = thread.id ?? currentThreadId ?? '';

		return {
			response: result.finalResponse ?? '',
			tokenCount: result.usage?.output_tokens ?? 0,
			threadId,
		};
	}

	return {
		async execute(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			await ensureCapabilitiesConfigured();
			currentThread = startNewThread();
			const result = await runInThread(currentThread, input);
			currentThreadId = result.threadId || null;
			return result;
		},

		async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			await ensureCapabilitiesConfigured();
			if (currentThread === null) {
				throw new Error('No active executor thread. Call execute() first.');
			}

			const result = await runInThread(currentThread, input);
			currentThreadId = result.threadId || currentThreadId;
			return result;
		},

		async resumeOrRebuild(
			threadId: string | null,
			context: readonly StructuredInput[],
		): Promise<void> {
			await ensureCapabilitiesConfigured();
			if (threadId !== null) {
				try {
					if (codex === null) {
						throw new Error('Codex executor has not been configured.');
					}
					currentThread = codex.resumeThread(threadId, {
						model: config.model,
						approvalPolicy: 'never',
						sandboxMode: 'danger-full-access',
						workingDirectory,
						skipGitRepoCheck: true,
						networkAccessEnabled: true,
					});
					currentThreadId = threadId;
					return;
				} catch (error) {
					if (!isRecoverableResumeError(error)) {
						throw error;
					}

					const message = error instanceof Error ? error.message : String(error);
					writeStderr(
						`[codex-executor] Failed to resume thread ${threadId}; rebuilding thread instead: ${message}`,
					);
					currentThread = null;
					currentThreadId = null;
				}
			}

			currentThread = startNewThread();
			await runInThread(currentThread, context);
			currentThreadId = currentThread.id ?? null;
		},

		getThreadId(): string | null {
			return currentThreadId;
		},
	};
}
