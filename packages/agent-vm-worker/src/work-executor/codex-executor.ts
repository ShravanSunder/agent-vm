import { Codex, type Thread, type UserInput } from '@openai/codex-sdk';

import { writeStderr } from '../shared/stderr.js';
import { prepareCodexRuntimeCapabilities } from './codex-capability-setup.js';
import type {
	ExecutorCapabilities,
	ExecutorResult,
	StructuredInput,
	WorkExecutor,
} from './executor-interface.js';

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
	let currentSessionRef: string | null = null;

	async function ensureCapabilitiesConfigured(): Promise<void> {
		if (codex !== null) {
			return;
		}

		const runtimeHandle = await prepareCodexRuntimeCapabilities({
			capabilities: config.capabilities,
			inheritedEnv: process.env,
			stateDirectory: process.env.STATE_DIR,
			workingDirectory,
		});

		codex = new Codex({
			...(typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length > 0
				? { apiKey: process.env.OPENAI_API_KEY }
				: {}),
			config: {
				skip_git_repo_check: true,
			},
			env: runtimeHandle.env,
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
		const sessionRef = thread.id ?? currentSessionRef ?? '';

		return {
			response: result.finalResponse ?? '',
			tokenCount: result.usage?.output_tokens ?? 0,
			sessionRef,
		};
	}

	return {
		async execute(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			await ensureCapabilitiesConfigured();
			currentThread = startNewThread();
			const result = await runInThread(currentThread, input);
			currentSessionRef = result.sessionRef || null;
			return result;
		},

		async fix(input: readonly StructuredInput[]): Promise<ExecutorResult> {
			await ensureCapabilitiesConfigured();
			if (currentThread === null) {
				throw new Error('No active executor thread. Call execute() first.');
			}

			const result = await runInThread(currentThread, input);
			currentSessionRef = result.sessionRef || currentSessionRef;
			return result;
		},

		async resumeOrRebuild(
			sessionRef: string | null,
			context: readonly StructuredInput[],
		): Promise<void> {
			await ensureCapabilitiesConfigured();
			if (sessionRef !== null) {
				try {
					if (codex === null) {
						throw new Error('Codex executor has not been configured.');
					}
					currentThread = codex.resumeThread(sessionRef, {
						model: config.model,
						approvalPolicy: 'never',
						sandboxMode: 'danger-full-access',
						workingDirectory,
						skipGitRepoCheck: true,
						networkAccessEnabled: true,
					});
					currentSessionRef = sessionRef;
					return;
				} catch (error) {
					if (!isRecoverableResumeError(error)) {
						throw error;
					}

					const message = error instanceof Error ? error.message : String(error);
					writeStderr(
						`[codex-executor] Failed to resume thread ${sessionRef}; rebuilding thread instead: ${message}`,
					);
					currentThread = null;
					currentSessionRef = null;
				}
			}

			currentThread = startNewThread();
			await runInThread(currentThread, context);
			currentSessionRef = currentThread.id ?? null;
		},

		getSessionRef(): string | null {
			return currentSessionRef;
		},
	};
}
