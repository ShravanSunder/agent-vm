import type { ReasoningEffort } from '../config/worker-config.js';
import { createCodexExecutor } from './codex-executor.js';
import type { ExecutorCapabilities, WorkExecutor } from './executor-interface.js';
import {
	SCRIPTED_E2E_EXECUTOR_ENV_NAME,
	SCRIPTED_E2E_EXECUTOR_PROVIDER,
	createScriptedE2eExecutor,
} from './scripted-e2e-executor.js';

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
		case SCRIPTED_E2E_EXECUTOR_PROVIDER:
			if (process.env[SCRIPTED_E2E_EXECUTOR_ENV_NAME] !== '1') {
				throw new Error(
					`${SCRIPTED_E2E_EXECUTOR_PROVIDER} executor is available only when ${SCRIPTED_E2E_EXECUTOR_ENV_NAME}=1.`,
				);
			}
			return createScriptedE2eExecutor({ capabilities });
		case 'claude':
			throw new Error('Claude executor is not implemented yet.');
		default:
			throw new Error(`Unknown executor provider: '${provider}'.`);
	}
}
