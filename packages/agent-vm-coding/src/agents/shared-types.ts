export type StructuredInput =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'skill'; readonly name: string; readonly path: string };

export interface CodexRunResult {
	readonly finalResponse?: string;
	readonly usage?: {
		readonly output_tokens?: number;
	};
}

export interface CodexThread {
	run(input: readonly StructuredInput[]): Promise<CodexRunResult>;
	getThreadId(): string;
}

export interface CodexClient {
	startThread(options: { readonly model: string }): CodexThread;
	resumeThread(threadId: string, options?: { readonly model: string }): CodexThread;
}

export interface AgentRunResult {
	readonly response: string;
	readonly tokenCount: number;
	readonly threadId: string;
}
