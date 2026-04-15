import type { ReasoningEffort } from '../config/worker-config.js';
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
			throw new Error('Claude executor is not implemented yet.');
		default:
			throw new Error(`Unknown executor provider: '${provider}'.`);
	}
}
