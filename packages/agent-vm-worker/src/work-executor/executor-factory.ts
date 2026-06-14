import type { ReasoningEffort } from '../config/worker-config.js';
import { createClaudeCodeExecutor } from './claude-code-executor.js';
import { createCodexExecutor } from './codex-executor.js';
import type { ExecutorCapabilities, WorkExecutor } from './executor-interface.js';

export function createWorkExecutor(
	provider: string,
	model: string,
	capabilities: ExecutorCapabilities,
	workingDirectory?: string,
	reasoningEffort?: ReasoningEffort,
): WorkExecutor {
	switch (provider) {
		case 'codex':
			return createCodexExecutor({
				model,
				capabilities,
				...(workingDirectory ? { workingDirectory } : {}),
				...(reasoningEffort ? { reasoningEffort } : {}),
			});
		case 'claude':
			return createClaudeCodeExecutor({
				model,
				capabilities,
				...(workingDirectory ? { workingDirectory } : {}),
				...(reasoningEffort ? { reasoningEffort } : {}),
			});
		default:
			throw new Error(`Unknown executor provider: '${provider}'.`);
	}
}
