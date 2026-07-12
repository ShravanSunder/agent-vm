import { execa } from 'execa';

import type { RepoLocation } from '../../shared/repo-location.js';

export interface ControllerToolRepoSelection {
	readonly repo: RepoLocation | null;
	readonly error: string | null;
}

export type CurrentBranchResult =
	| { readonly ok: true; readonly branch: string | null }
	| { readonly ok: false; readonly error: string };

export type CurrentHeadResult =
	| { readonly ok: true; readonly head: string }
	| { readonly ok: false; readonly error: string };

export function buildSafeGitEnvironment(cwd: string): NodeJS.ProcessEnv {
	const existingCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10);
	const nextIndex = Number.isFinite(existingCount) && existingCount >= 0 ? existingCount : 0;
	return {
		...process.env,
		GIT_CONFIG_COUNT: String(nextIndex + 1),
		[`GIT_CONFIG_KEY_${String(nextIndex)}`]: 'safe.directory',
		[`GIT_CONFIG_VALUE_${String(nextIndex)}`]: cwd,
	};
}

export function selectRepo(
	repos: readonly RepoLocation[],
	params: Record<string, unknown>,
): ControllerToolRepoSelection {
	const requestedWorkPath = typeof params.repoWorkPath === 'string' ? params.repoWorkPath : null;
	const requestedRepoUrl = typeof params.repoUrl === 'string' ? params.repoUrl : null;
	const configured = repos.map((repo) => `${repo.workPath} (${repo.repoUrl})`).join(', ');

	if (repos.length === 0) {
		return { repo: null, error: 'No repo configured.' };
	}
	if (requestedWorkPath) {
		const repo = repos.find((candidate) => candidate.workPath === requestedWorkPath) ?? null;
		return repo
			? { repo, error: null }
			: {
					repo: null,
					error: `repoWorkPath '${requestedWorkPath}' not found; configured repos: ${configured}`,
				};
	}
	if (requestedRepoUrl) {
		const repo = repos.find((candidate) => candidate.repoUrl === requestedRepoUrl) ?? null;
		return repo
			? { repo, error: null }
			: {
					repo: null,
					error: `repoUrl '${requestedRepoUrl}' not found; configured repos: ${configured}`,
				};
	}
	if (repos.length > 1) {
		return {
			repo: null,
			error: 'Multiple repos configured; provide repoWorkPath or repoUrl.',
		};
	}
	return { repo: repos[0] ?? null, error: null };
}

export async function currentBranch(cwd: string): Promise<CurrentBranchResult> {
	const result = await execa('git', ['branch', '--show-current'], {
		cwd,
		env: buildSafeGitEnvironment(cwd),
		reject: false,
		timeout: 10_000,
	});
	if (typeof result.exitCode !== 'number') {
		return {
			ok: false,
			error: [
				'git branch --show-current terminated without an exit code',
				result.stdout,
				result.stderr,
			]
				.filter((line) => line.trim().length > 0)
				.join('\n'),
		};
	}
	if (result.exitCode !== 0) {
		return {
			ok: false,
			error: ['git branch --show-current failed', result.stdout, result.stderr]
				.filter((line) => line.trim().length > 0)
				.join('\n'),
		};
	}
	const branch = result.stdout.trim();
	return { ok: true, branch: branch.length > 0 ? branch : null };
}

export async function currentHead(cwd: string): Promise<CurrentHeadResult> {
	const result = await execa('git', ['rev-parse', 'HEAD'], {
		cwd,
		env: buildSafeGitEnvironment(cwd),
		reject: false,
		timeout: 10_000,
	});
	if (typeof result.exitCode !== 'number') {
		return {
			ok: false,
			error: ['git rev-parse HEAD terminated without an exit code', result.stdout, result.stderr]
				.filter((line) => line.trim().length > 0)
				.join('\n'),
		};
	}
	if (result.exitCode !== 0) {
		return {
			ok: false,
			error: ['git rev-parse HEAD failed', result.stdout, result.stderr]
				.filter((line) => line.trim().length > 0)
				.join('\n'),
		};
	}
	const head = result.stdout.trim();
	if (head.length === 0) {
		return {
			ok: false,
			error: 'git rev-parse HEAD returned an empty HEAD.',
		};
	}
	return { ok: true, head };
}
