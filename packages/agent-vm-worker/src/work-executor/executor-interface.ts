import type { McpServerConfig } from '../config/worker-config.js';

export type StructuredInput =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'skill'; readonly name: string; readonly content: string };

export interface ExecutorResult {
	readonly response: string;
	readonly tokenCount: number;
	readonly sessionRef: string;
}

export interface WorkExecutor {
	/** Starts a fresh provider conversation for the first phase turn. */
	execute(input: readonly StructuredInput[]): Promise<ExecutorResult>;
	/** Continues the current provider conversation for review/fix turns. */
	fix(input: readonly StructuredInput[]): Promise<ExecutorResult>;
	/** Best-effort resume of a provider session, or rebuilds from context if resume is impossible. */
	resumeOrRebuild(sessionRef: string | null, context: readonly StructuredInput[]): Promise<void>;
	/** Provider-owned handle used to resume the current conversation later. */
	getSessionRef(): string | null;
	/** Cancels an in-flight provider turn after the worker-level turn timeout fires. */
	cancelActiveTurn?(): void;
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
