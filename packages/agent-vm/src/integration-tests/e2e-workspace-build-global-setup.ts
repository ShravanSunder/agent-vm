import { execFileSync } from 'node:child_process';
import path from 'node:path';

type E2eWorkspaceBuildResult = 'built' | 'skipped';

type E2eWorkspaceBuildEnvironment = Partial<
	Record<
		| 'AGENT_VM_GONDOLIN_E2E'
		| 'AGENT_VM_1PASSWORD_E2E'
		| 'AGENT_VM_E2E_SKIP_WORKSPACE_BUILD'
		| 'AGENT_VM_LLM_E2E'
		| 'AGENT_VM_OPENCLAW_E2E'
		| 'AGENT_VM_TEST_OPENAI_API_KEY'
		| 'AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN'
		| 'AGENT_VM_WORKER_E2E',
		string
	>
>;

interface E2eWorkspaceBuildExecOptions {
	readonly cwd: string;
	readonly stdio: 'inherit';
}

interface RunE2eWorkspaceBuildOptions {
	readonly cwd: string;
	readonly env?: E2eWorkspaceBuildEnvironment;
	readonly execFileSync?: (
		command: string,
		args: readonly string[],
		options: E2eWorkspaceBuildExecOptions,
	) => unknown;
}

export function shouldBuildWorkspaceForE2e(
	env: E2eWorkspaceBuildEnvironment = process.env,
): boolean {
	if (env.AGENT_VM_E2E_SKIP_WORKSPACE_BUILD === '1') {
		return false;
	}
	return (
		env.AGENT_VM_OPENCLAW_E2E === '1' ||
		env.AGENT_VM_WORKER_E2E === '1' ||
		env.AGENT_VM_LLM_E2E === '1' ||
		env.AGENT_VM_GONDOLIN_E2E === '1'
	);
}

export function runE2eWorkspaceBuild(
	options: RunE2eWorkspaceBuildOptions,
): E2eWorkspaceBuildResult {
	const env = options.env ?? process.env;
	if (!shouldBuildWorkspaceForE2e(env)) {
		return 'skipped';
	}

	const runExecFileSync = options.execFileSync ?? execFileSync;
	runExecFileSync('pnpm', ['build'], {
		cwd: path.resolve(options.cwd),
		stdio: 'inherit',
	});
	return 'built';
}

export function setup(): void {
	runE2eWorkspaceBuild({ cwd: process.cwd() });
}
