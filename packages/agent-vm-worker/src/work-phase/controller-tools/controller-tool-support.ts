import { execa } from 'execa';

import type { RepoLocation } from '../../shared/repo-location.js';

export interface ControllerToolRepoSelection {
	readonly repo: RepoLocation | null;
	readonly error: string | null;
}

export type ControllerToolFailure =
	| {
			readonly type: 'controller-transport-error';
			readonly success: false;
			readonly artifact: string;
	  }
	| {
			readonly type: 'controller-http-error';
			readonly success: false;
			readonly status: number;
			readonly artifact: string;
	  }
	| {
			readonly type: 'controller-parse-error';
			readonly success: false;
			readonly artifact: string;
	  };

export type CurrentBranchResult =
	| { readonly ok: true; readonly branch: string | null }
	| { readonly ok: false; readonly error: string };

export function isControllerToolFailure(value: unknown): value is ControllerToolFailure {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		(value.type === 'controller-transport-error' ||
			value.type === 'controller-http-error' ||
			value.type === 'controller-parse-error') &&
		'success' in value &&
		value.success === false &&
		'artifact' in value &&
		typeof value.artifact === 'string'
	);
}

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

export async function postControllerJson(options: {
	readonly url: string;
	readonly body: Record<string, unknown>;
	readonly timeoutMs: number;
}): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(options.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: AbortSignal.timeout(options.timeoutMs),
			body: JSON.stringify(options.body),
		});
	} catch (error) {
		return {
			type: 'controller-transport-error',
			success: false,
			artifact: `Controller request failed before HTTP response: ${error instanceof Error ? error.message : String(error)}`,
		} satisfies ControllerToolFailure;
	}
	const text = await response.text();
	if (!response.ok) {
		return {
			type: 'controller-http-error',
			success: false,
			status: response.status,
			artifact: `Controller request failed with HTTP ${String(response.status)}: ${text}`,
		} satisfies ControllerToolFailure;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		return {
			type: 'controller-parse-error',
			success: false,
			artifact: `Controller response parse failed: ${error instanceof Error ? error.message : String(error)}`,
		} satisfies ControllerToolFailure;
	}
}
