import { Codex, type Thread, type UserInput } from '@openai/codex-sdk';

import type {
	ExecutorCapabilities,
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from './executor-interface.js';

export interface CodexExecutorConfig {
	readonly model: string;
	readonly capabilities: ExecutorCapabilities;
	readonly workingDirectory?: string;
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
	const codex = new Codex({});
	const workingDirectory = config.workingDirectory ?? '/workspace';
	let currentThread: Thread | null = null;
	let currentThreadId: string | null = null;

	function startNewThread(): Thread {
		void config.capabilities;

		return codex.startThread({
			model: config.model,
			approvalPolicy: 'never',
			sandboxMode: 'danger-full-access',
			workingDirectory,
			networkAccessEnabled: true,
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
			currentThread = startNewThread();
			const result = await runInThread(currentThread, input);
			currentThreadId = result.threadId || null;
			return result;
		},

		async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
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
			if (threadId !== null) {
				try {
					currentThread = codex.resumeThread(threadId, {
						model: config.model,
						approvalPolicy: 'never',
						sandboxMode: 'danger-full-access',
						workingDirectory,
						networkAccessEnabled: true,
					});
					currentThreadId = threadId;
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const recoverableResumeError =
						message.includes('expired') ||
						message.includes('not found') ||
						message.includes('does not exist');

					if (!recoverableResumeError) {
						throw error;
					}

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
