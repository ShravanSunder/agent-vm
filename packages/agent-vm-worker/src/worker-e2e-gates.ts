import path from 'node:path';

export function resolveWorkerRuntimeEntrypoint(repoRoot: string): string {
	return path.join(repoRoot, 'packages', 'agent-vm-worker', 'dist', 'main.js');
}

export type WorkerRuntimeE2eProvider = 'claude' | 'codex';

type WorkerRuntimeE2eEnvName =
	| 'AGENT_VM_TEST_ANTHROPIC_API_KEY'
	| 'AGENT_VM_TEST_OPENAI_API_KEY'
	| 'AGENT_VM_WORKER_E2E';

interface WorkerRuntimeProviderGate {
	readonly command?: string;
	readonly credentialEnv: Exclude<WorkerRuntimeE2eEnvName, 'AGENT_VM_WORKER_E2E'>;
	readonly requiresClaudeRuntime?: boolean;
}

const workerRuntimeProviderGates: Record<WorkerRuntimeE2eProvider, WorkerRuntimeProviderGate> = {
	claude: {
		credentialEnv: 'AGENT_VM_TEST_ANTHROPIC_API_KEY',
		requiresClaudeRuntime: true,
	},
	codex: {
		command: 'codex',
		credentialEnv: 'AGENT_VM_TEST_OPENAI_API_KEY',
	},
};

export function shouldRunWorkerRuntimeE2e(options: {
	readonly claudeRuntimeAvailable?: () => boolean;
	readonly commandExists: (command: string) => boolean;
	readonly env: Partial<Record<WorkerRuntimeE2eEnvName, string>>;
	readonly provider: WorkerRuntimeE2eProvider;
}): boolean {
	const providerGate = workerRuntimeProviderGates[options.provider];
	const credential = options.env[providerGate.credentialEnv];
	const commandIsAvailable =
		providerGate.command === undefined || options.commandExists(providerGate.command);
	const runtimeIsAvailable =
		providerGate.requiresClaudeRuntime !== true || options.claudeRuntimeAvailable?.() === true;
	return (
		options.env.AGENT_VM_WORKER_E2E === '1' &&
		typeof credential === 'string' &&
		credential.length > 0 &&
		commandIsAvailable &&
		runtimeIsAvailable
	);
}
