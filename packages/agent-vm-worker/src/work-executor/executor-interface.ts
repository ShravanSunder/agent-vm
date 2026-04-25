import type { McpServerConfig } from '../config/worker-config.js';

export type StructuredInput =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'skill'; readonly name: string; readonly content: string };

export interface ExecutorResult {
	readonly response: string;
	readonly tokenCount: number;
	readonly threadId: string;
}

export interface WorkExecutor {
	execute(input: readonly StructuredInput[]): Promise<ExecutorResult>;
	fix(input: readonly StructuredInput[]): Promise<ExecutorResult>;
	resumeOrRebuild(threadId: string | null, context: readonly StructuredInput[]): Promise<void>;
	getThreadId(): string | null;
}

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface ExecutorCapabilities {
	readonly mcpServers: readonly McpServerConfig[];
	readonly tools: readonly ToolDefinition[];
}
