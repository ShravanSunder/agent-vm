import {
	query,
	type EffortLevel,
	type McpServerConfig as ClaudeMcpServerConfig,
	type Options as ClaudeQueryOptions,
	type Query as ClaudeQuery,
	type SDKMessage,
	type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { ReasoningEffort } from '../config/worker-config.js';
import {
	prepareClaudeRuntimeCapabilities,
	resolveActionableClaudeCodeExecutable,
	type ClaudeRuntimeCapabilitiesHandle,
	type ResolveClaudeCodeExecutable,
} from './claude-capability-setup.js';
import type {
	ExecutorCapabilities,
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from './executor-interface.js';
import { getOrCreateLocalToolMcpServer } from './local-tool-mcp-server.js';

export interface ClaudeCodeExecutorConfig {
	readonly capabilities: ExecutorCapabilities;
	readonly model: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly resolveClaudeCodeExecutable?: ResolveClaudeCodeExecutable;
	readonly workingDirectory?: string;
}

function mapToClaudePrompt(input: readonly StructuredInput[]): string {
	return input
		.map((item) => {
			if (item.type === 'text') {
				return item.text;
			}
			return `[Skill: ${item.name}]\n\n${item.content}`;
		})
		.join('\n\n');
}

function mapReasoningEffort(reasoningEffort: ReasoningEffort | undefined): EffortLevel | undefined {
	if (reasoningEffort === undefined) {
		return undefined;
	}
	if (reasoningEffort === 'minimal') {
		return 'low';
	}
	return reasoningEffort;
}

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
			message.includes('session not found') ||
			message.includes('does not exist') ||
			message.includes('unknown session') ||
			message.includes('404') ||
			message.includes('no session found'),
	);
}

function resultMessageToError(result: SDKResultMessage): Error {
	if (result.subtype === 'success') {
		return new Error('Claude query succeeded unexpectedly.');
	}
	const message = result.errors.length > 0 ? result.errors.join('; ') : result.subtype;
	return new Error(`Claude query failed: ${message}`);
}

function hasSessionId(
	message: SDKMessage,
): message is SDKMessage & { readonly session_id: string } {
	return 'session_id' in message && typeof message.session_id === 'string';
}

function buildBearerHeaders(options: {
	readonly env: Record<string, string>;
	readonly mcpServerName: string;
	readonly tokenEnvVar: string;
}): Record<string, string> {
	const token = options.env[options.tokenEnvVar];
	if (!token) {
		throw new Error(
			`Claude MCP server '${options.mcpServerName}' requires env var ${options.tokenEnvVar}.`,
		);
	}
	return { Authorization: `Bearer ${token}` };
}

async function buildClaudeMcpServers(options: {
	readonly capabilities: ExecutorCapabilities;
	readonly env: Record<string, string>;
}): Promise<Record<string, ClaudeMcpServerConfig>> {
	const mcpServers: Record<string, ClaudeMcpServerConfig> = {};
	for (const mcpServer of options.capabilities.mcpServers) {
		const headers = mcpServer.bearerTokenEnvVar
			? buildBearerHeaders({
					env: options.env,
					mcpServerName: mcpServer.name,
					tokenEnvVar: mcpServer.bearerTokenEnvVar,
				})
			: undefined;
		mcpServers[mcpServer.name] = {
			type: 'http',
			url: mcpServer.url,
			...(headers ? { headers } : {}),
		};
	}

	const localToolServer = await getOrCreateLocalToolMcpServer(options.capabilities.tools);
	if (localToolServer) {
		mcpServers['agent-vm-local-tools'] = {
			alwaysLoad: true,
			type: 'http',
			url: localToolServer.url,
		};
	}

	return mcpServers;
}

export function createClaudeCodeExecutor(config: ClaudeCodeExecutorConfig): WorkExecutor {
	const workingDirectory = config.workingDirectory ?? process.cwd();
	const executablePath = resolveActionableClaudeCodeExecutable(config.resolveClaudeCodeExecutable);
	let runtimeHandle: ClaudeRuntimeCapabilitiesHandle | null = null;
	let activeQuery: ClaudeQuery | null = null;
	let currentSessionRef: string | null = null;

	async function ensureRuntimeConfigured(): Promise<ClaudeRuntimeCapabilitiesHandle> {
		if (runtimeHandle !== null) {
			return runtimeHandle;
		}
		runtimeHandle = await prepareClaudeRuntimeCapabilities({
			executablePath,
			inheritedEnv: process.env,
			...(process.env.STATE_DIR === undefined ? {} : { stateDirectory: process.env.STATE_DIR }),
		});
		return runtimeHandle;
	}

	async function buildQueryOptions(resumeSessionRef: string | null): Promise<ClaudeQueryOptions> {
		const runtime = await ensureRuntimeConfigured();
		const mcpServers = await buildClaudeMcpServers({
			capabilities: config.capabilities,
			env: runtime.env,
		});
		const effort = mapReasoningEffort(config.reasoningEffort);
		return {
			allowDangerouslySkipPermissions: true,
			cwd: workingDirectory,
			env: runtime.env,
			...(effort ? { effort } : {}),
			...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
			model: config.model,
			pathToClaudeCodeExecutable: runtime.executablePath,
			permissionMode: 'bypassPermissions',
			...(resumeSessionRef !== null ? { resume: resumeSessionRef } : {}),
			settingSources: [],
		};
	}

	async function runClaudeTurn(
		input: readonly StructuredInput[],
		resumeSessionRef: string | null,
	): Promise<ExecutorResult> {
		const prompt = mapToClaudePrompt(input);
		const sdkQuery = query({
			options: await buildQueryOptions(resumeSessionRef),
			prompt,
		});
		activeQuery = sdkQuery;
		try {
			let resultMessage: SDKResultMessage | null = null;
			let latestSessionRef = resumeSessionRef;

			for await (const message of sdkQuery) {
				if (hasSessionId(message)) {
					latestSessionRef = message.session_id;
				}
				if (message.type === 'result') {
					resultMessage = message;
				}
			}

			if (resultMessage === null) {
				throw new Error('Claude query completed without a result message.');
			}
			if (resultMessage.subtype !== 'success') {
				throw resultMessageToError(resultMessage);
			}

			const sessionRef = resultMessage.session_id ?? latestSessionRef ?? '';
			currentSessionRef = sessionRef.length > 0 ? sessionRef : null;
			return {
				response: resultMessage.result,
				sessionRef,
				tokenCount: resultMessage.usage.output_tokens,
			};
		} finally {
			if (activeQuery === sdkQuery) {
				activeQuery = null;
			}
		}
	}

	return {
		async execute(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			return await runClaudeTurn(input, null);
		},

		async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			if (currentSessionRef === null) {
				throw new Error('No active Claude session. Call execute() first.');
			}
			try {
				const result = await runClaudeTurn(input, currentSessionRef);
				return result;
			} catch (error) {
				if (isRecoverableResumeError(error)) {
					throw new Error(
						`Claude session ${currentSessionRef} could not be resumed and cannot be safely rebuilt without the prior assistant transcript.`,
						{ cause: error },
					);
				}
				throw error;
			}
		},

		async resumeOrRebuild(
			sessionRef: string | null,
			context: readonly StructuredInput[],
		): Promise<void> {
			if (sessionRef !== null) {
				currentSessionRef = sessionRef;
				return;
			}
			await runClaudeTurn(context, null);
		},

		getSessionRef(): string | null {
			return currentSessionRef;
		},

		cancelActiveTurn(): void {
			activeQuery?.close();
			activeQuery = null;
		},
	};
}
