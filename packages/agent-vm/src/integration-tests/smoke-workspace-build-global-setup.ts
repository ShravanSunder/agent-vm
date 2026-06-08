import { execFileSync } from 'node:child_process';
import path from 'node:path';

type SmokeWorkspaceBuildResult = 'built' | 'skipped';

type SmokeWorkspaceBuildEnvironment = Partial<
	Record<
		| 'AGENT_VM_GONDOLIN_SMOKE'
		| 'AGENT_VM_1PASSWORD_SMOKE'
		| 'AGENT_VM_OPENCLAW_SMOKE'
		| 'AGENT_VM_WORKER_SMOKE',
		string
	>
>;

interface SmokeWorkspaceBuildExecOptions {
	readonly cwd: string;
	readonly stdio: 'inherit';
}

interface RunSmokeWorkspaceBuildOptions {
	readonly cwd: string;
	readonly env?: SmokeWorkspaceBuildEnvironment;
	readonly execFileSync?: (
		command: string,
		args: readonly string[],
		options: SmokeWorkspaceBuildExecOptions,
	) => unknown;
}

export function shouldBuildWorkspaceForSmoke(
	env: SmokeWorkspaceBuildEnvironment = process.env,
): boolean {
	return (
		env.AGENT_VM_OPENCLAW_SMOKE === '1' ||
		env.AGENT_VM_WORKER_SMOKE === '1' ||
		env.AGENT_VM_GONDOLIN_SMOKE === '1'
	);
}

export function runSmokeWorkspaceBuild(
	options: RunSmokeWorkspaceBuildOptions,
): SmokeWorkspaceBuildResult {
	const env = options.env ?? process.env;
	if (!shouldBuildWorkspaceForSmoke(env)) {
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
	runSmokeWorkspaceBuild({ cwd: process.cwd() });
}
