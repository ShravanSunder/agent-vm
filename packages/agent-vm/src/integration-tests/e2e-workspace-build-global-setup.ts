import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

type E2eWorkspaceBuildResult = 'built' | 'skipped';

type E2eWorkspaceBuildEnvironment = Partial<Record<string, string>>;

interface E2eWorkspaceBuildProject {
	provide(key: 'agentVmE2eCacheRoot', value: string): void;
}

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

interface ConfigureE2eCacheRootOptions {
	readonly env?: E2eWorkspaceBuildEnvironment;
	readonly project?: E2eWorkspaceBuildProject;
	readonly tmpdir?: string;
}

export function shouldBuildWorkspaceForE2e(
	env: E2eWorkspaceBuildEnvironment = process.env,
): boolean {
	if (env.AGENT_VM_E2E_SKIP_WORKSPACE_BUILD === '1') {
		return false;
	}
	return shouldConfigureE2eCacheRoot(env);
}

export function shouldConfigureE2eCacheRoot(
	env: E2eWorkspaceBuildEnvironment = process.env,
): boolean {
	return (
		env.AGENT_VM_OPENCLAW_E2E === '1' ||
		env.AGENT_VM_WORKER_E2E === '1' ||
		env.AGENT_VM_LLM_E2E === '1' ||
		env.AGENT_VM_GONDOLIN_E2E === '1'
	);
}

export function resolveE2eGlobalCacheRoot(
	env: E2eWorkspaceBuildEnvironment = process.env,
	tmpdir = os.tmpdir(),
): string {
	const configuredCacheRoot = env.AGENT_VM_E2E_CACHE_DIR;
	if (configuredCacheRoot !== undefined && configuredCacheRoot.length > 0) {
		return path.resolve(configuredCacheRoot);
	}
	return path.join(tmpdir, 'agent-vm-e2e-cache');
}

export function configureE2eCacheRootForGlobalSetup(
	options: ConfigureE2eCacheRootOptions = {},
): string | undefined {
	const env = options.env ?? process.env;
	if (!shouldConfigureE2eCacheRoot(env)) {
		return undefined;
	}
	const cacheRoot = resolveE2eGlobalCacheRoot(env, options.tmpdir);
	env.AGENT_VM_E2E_CACHE_DIR = cacheRoot;
	options.project?.provide('agentVmE2eCacheRoot', cacheRoot);
	return cacheRoot;
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

export function setup(project?: E2eWorkspaceBuildProject): void {
	configureE2eCacheRootForGlobalSetup(project === undefined ? {} : { project });
	runE2eWorkspaceBuild({ cwd: process.cwd() });
}
