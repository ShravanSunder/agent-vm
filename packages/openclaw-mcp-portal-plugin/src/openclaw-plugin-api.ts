import type { IncomingMessage, ServerResponse } from 'node:http';

export interface OpenClawPromptHookContext {
	readonly agentId?: string;
	readonly appendPrompt?: (content: string) => void;
}

export interface OpenClawPluginToolContext {
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
}

export type OpenClawToolUpdateCallback = (update: unknown) => Promise<void> | void;

export interface OpenClawToolRegistrationResult {
	readonly content: string;
	readonly details?: unknown;
}

export interface OpenClawToolRegistration {
	readonly description: string;
	readonly execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: OpenClawToolUpdateCallback,
	) => Promise<OpenClawToolRegistrationResult>;
	readonly label?: string;
	readonly name: string;
	readonly parameters: unknown;
}

export type OpenClawToolFactory = (
	context: OpenClawPluginToolContext,
) => OpenClawToolRegistration | readonly OpenClawToolRegistration[] | null | undefined;

export interface OpenClawPluginHookContext {
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly sessionKey?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export interface OpenClawAgentTurnPrepareEvent {
	readonly messages?: readonly unknown[];
	readonly prompt?: string;
}

export interface OpenClawBeforePromptBuildEvent {
	readonly messages?: readonly unknown[];
	readonly prompt?: string;
}

export interface OpenClawBeforeToolCallEvent {
	readonly params: Record<string, unknown>;
	readonly toolCallId?: string;
	readonly toolName: string;
}

export type OpenClawApprovalResolution =
	| 'allow-always'
	| 'allow-once'
	| 'cancelled'
	| 'deny'
	| 'timeout';

export interface OpenClawBeforeToolCallResult {
	readonly block?: boolean;
	readonly blockReason?: string;
	readonly params?: Record<string, unknown>;
	readonly requireApproval?: {
		readonly description: string;
		readonly onResolution?: (decision: OpenClawApprovalResolution) => Promise<void> | void;
		readonly pluginId?: string;
		readonly severity?: 'critical' | 'info' | 'warning';
		readonly timeoutBehavior?: 'allow' | 'deny';
		readonly timeoutMs?: number;
		readonly title: string;
	};
}

export interface OpenClawPromptHookResult {
	readonly appendContext?: string;
	readonly appendSystemContext?: string;
	readonly prependContext?: string;
	readonly prependSystemContext?: string;
}

export type OpenClawPluginHookEventMap = {
	readonly agent_turn_prepare: OpenClawAgentTurnPrepareEvent;
	readonly before_prompt_build: OpenClawBeforePromptBuildEvent;
	readonly before_tool_call: OpenClawBeforeToolCallEvent;
};

export type OpenClawPluginHookResultMap = {
	readonly agent_turn_prepare: OpenClawPromptHookResult;
	readonly before_prompt_build: OpenClawPromptHookResult;
	readonly before_tool_call: OpenClawBeforeToolCallResult;
};

export interface OpenClawPluginHookOptions {
	readonly priority?: number;
	readonly timeoutMs?: number;
}

export interface OpenClawHttpRouteRegistration {
	readonly auth: 'gateway' | 'plugin';
	readonly handler: (
		request: IncomingMessage,
		response: ServerResponse,
	) => Promise<boolean> | boolean;
	readonly match?: 'exact' | 'prefix';
	readonly path: string;
	readonly replaceExisting?: boolean;
}

export interface OpenClawPluginService {
	readonly id: string;
	readonly start: () => Promise<void> | void;
	readonly stop?: () => Promise<void> | void;
}

export type OpenClawPluginHostCleanupReason = 'disable' | 'reset' | 'delete' | 'restart';

export interface OpenClawRuntimeLifecycleRegistration {
	readonly id: string;
	readonly description?: string;
	readonly cleanup?: (context: {
		readonly reason: OpenClawPluginHostCleanupReason;
		readonly sessionKey?: string;
		readonly runId?: string;
	}) => Promise<void> | void;
}

export type OpenClawRuntimeLifecycleRegistrar = (
	lifecycle: OpenClawRuntimeLifecycleRegistration,
) => void;

export interface OpenClawPortalPluginApi {
	readonly config?: unknown;
	readonly lifecycle?: {
		readonly registerRuntimeLifecycle: OpenClawRuntimeLifecycleRegistrar;
	};
	readonly logger?: {
		readonly debug?: (message: string) => void;
		readonly error?: (message: string) => void;
		readonly info?: (message: string) => void;
		readonly warn?: (message: string) => void;
	};
	readonly pluginConfig?: unknown;
	readonly registrationMode?: string;
	readonly registerTool?: (
		tool: OpenClawToolRegistration | OpenClawToolFactory,
		options?: {
			readonly name?: string;
			readonly names?: readonly string[];
			readonly optional?: boolean;
		},
	) => void;
	readonly registerRuntimeLifecycle?: OpenClawRuntimeLifecycleRegistrar;
	readonly registerService?: (service: OpenClawPluginService) => void;
	readonly on?: <THookName extends keyof OpenClawPluginHookEventMap>(
		hookName: THookName,
		handler: (
			event: OpenClawPluginHookEventMap[THookName],
			context: OpenClawPluginHookContext,
		) =>
			| OpenClawPluginHookResultMap[THookName]
			| Promise<OpenClawPluginHookResultMap[THookName] | void>
			| void,
		options?: OpenClawPluginHookOptions,
	) => void;
	readonly registerPromptHook?: (
		hookName: 'agent_turn_prepare' | 'before_prompt_build',
		handler: (context: OpenClawPromptHookContext) => Promise<void> | void,
	) => void;
	readonly registerHttpRoute?: (registration: OpenClawHttpRouteRegistration) => void;
}
