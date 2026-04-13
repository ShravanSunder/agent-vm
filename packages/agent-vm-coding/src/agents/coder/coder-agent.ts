import type { AgentRunResult, CodexClient, CodexThread, StructuredInput } from '../shared-types.js';

export interface CoderAgentConfig {
	readonly model: string;
}

export interface CoderAgent {
	implement(input: readonly StructuredInput[]): Promise<AgentRunResult>;
	fix(input: readonly StructuredInput[]): Promise<AgentRunResult>;
	resumeOrRebuild(threadId: string | null, context: readonly StructuredInput[]): Promise<void>;
	getThreadId(): string | null;
}

export function createCoderAgent(config: CoderAgentConfig, codexClient: CodexClient): CoderAgent {
	let currentThread: CodexThread | null = null;
	let currentThreadId: string | null = null;

	async function runInCurrentThread(input: readonly StructuredInput[]): Promise<AgentRunResult> {
		if (currentThread === null) {
			throw new Error('No active coder thread. Call implement() first.');
		}

		const result = await currentThread.run(input);
		currentThreadId = currentThread.getThreadId() || currentThreadId;

		return {
			response: result.finalResponse ?? '',
			tokenCount: result.usage?.output_tokens ?? 0,
			threadId: currentThreadId ?? '',
		};
	}

	return {
		async implement(input: readonly StructuredInput[]): Promise<AgentRunResult> {
			currentThread = codexClient.startThread({ model: config.model });
			const result = await currentThread.run(input);
			currentThreadId = currentThread.getThreadId() || null;

			return {
				response: result.finalResponse ?? '',
				tokenCount: result.usage?.output_tokens ?? 0,
				threadId: currentThreadId ?? '',
			};
		},

		async fix(input: readonly StructuredInput[]): Promise<AgentRunResult> {
			return runInCurrentThread(input);
		},

		async resumeOrRebuild(
			threadId: string | null,
			context: readonly StructuredInput[],
		): Promise<void> {
			if (threadId !== null) {
				try {
					currentThread = codexClient.resumeThread(threadId, {
						model: config.model,
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

			currentThread = codexClient.startThread({ model: config.model });
			await currentThread.run(context);
			currentThreadId = currentThread.getThreadId() || null;
		},

		getThreadId(): string | null {
			return currentThreadId;
		},
	};
}
