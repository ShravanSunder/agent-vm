import { execa } from 'execa';

import type { ControllerTelemetryIdentity } from './controller-telemetry.js';

export type ControllerTelemetryGitResolver = (
	args: readonly string[],
	options: { readonly cwd: string },
) => Promise<string | undefined>;

export interface ResolveControllerTelemetryIdentityOptions {
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv | undefined;
	readonly git?: ControllerTelemetryGitResolver | undefined;
	readonly serviceVersion: string;
}

export async function resolveControllerTelemetryIdentity(
	options: ResolveControllerTelemetryIdentityOptions,
): Promise<ControllerTelemetryIdentity> {
	const env = options.env ?? process.env;
	const git = options.git ?? runGit;
	const repositoryIdentity =
		readEnv(env, 'AGENT_VM_OBSERVABILITY_REPO_ID') ??
		(await git(['config', '--get', 'remote.origin.url'], { cwd: options.cwd })) ??
		(await git(['rev-parse', '--show-toplevel'], { cwd: options.cwd })) ??
		options.cwd;
	const worktreeIdentity =
		readEnv(env, 'AGENT_VM_OBSERVABILITY_WORKTREE_ID') ??
		(await git(['rev-parse', '--show-toplevel'], { cwd: options.cwd })) ??
		options.cwd;
	const branchName =
		readEnv(env, 'AGENT_VM_OBSERVABILITY_BRANCH_NAME') ??
		(await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: options.cwd })) ??
		'unknown';
	const runtimeFlavor = readEnv(env, 'AGENT_VM_OBSERVABILITY_RUNTIME_FLAVOR');
	const releaseChannel = readEnv(env, 'AGENT_VM_OBSERVABILITY_RELEASE_CHANNEL');

	return {
		branchName,
		...(releaseChannel ? { releaseChannel } : {}),
		repositoryIdentity,
		...(runtimeFlavor ? { runtimeFlavor } : {}),
		serviceVersion: options.serviceVersion,
		worktreeIdentity,
	};
}

async function runGit(
	args: readonly string[],
	options: { readonly cwd: string },
): Promise<string | undefined> {
	const result = await execa('git', [...args], {
		cwd: options.cwd,
		reject: false,
	});
	if (result.exitCode !== 0) {
		return undefined;
	}
	const stdout = result.stdout.trim();
	return stdout.length > 0 ? stdout : undefined;
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key]?.trim();
	return value && value.length > 0 ? value : undefined;
}
