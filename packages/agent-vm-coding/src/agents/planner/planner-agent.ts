import type { AgentRunResult, CodexClient, CodexThread, StructuredInput } from '../shared-types.js';

export interface PlannerAgentConfig {
	readonly model: string;
}

export interface PlannerAgent {
	plan(input: readonly StructuredInput[]): Promise<AgentRunResult>;
	revise(input: readonly StructuredInput[]): Promise<AgentRunResult>;
	getThreadId(): string | null;
}

export function createPlannerAgent(
	config: PlannerAgentConfig,
	codexClient: CodexClient,
): PlannerAgent {
	let currentThread: CodexThread | null = null;
	let currentThreadId: string | null = null;

	async function runInCurrentThread(input: readonly StructuredInput[]): Promise<AgentRunResult> {
		if (currentThread === null) {
			throw new Error('No active planner thread. Call plan() first.');
		}

		const result = await currentThread.run(input);

		return {
			response: result.finalResponse ?? '',
			tokenCount: result.usage?.output_tokens ?? 0,
			threadId: currentThreadId ?? '',
		};
	}

	return {
		async plan(input: readonly StructuredInput[]): Promise<AgentRunResult> {
			currentThread = codexClient.startThread({ model: config.model });

			const result = await currentThread.run(input);
			currentThreadId = currentThread.getThreadId() || null;

			return {
				response: result.finalResponse ?? '',
				tokenCount: result.usage?.output_tokens ?? 0,
				threadId: currentThreadId ?? '',
			};
		},

		async revise(input: readonly StructuredInput[]): Promise<AgentRunResult> {
			return runInCurrentThread(input);
		},

		getThreadId(): string | null {
			return currentThreadId;
		},
	};
}
