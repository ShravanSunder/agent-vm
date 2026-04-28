import { execa } from 'execa';

import type { RepoLocation } from '../../shared/repo-location.js';

export interface ControllerToolRepoSelection {
	readonly repo: RepoLocation | null;
	readonly error: string | null;
}

export interface ControllerToolFailure {
	readonly type: 'controller-error';
	readonly success: false;
	readonly artifact: string;
}

export function isControllerToolFailure(value: unknown): value is ControllerToolFailure {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		value.type === 'controller-error' &&
		'success' in value &&
		value.success === false &&
		'artifact' in value &&
		typeof value.artifact === 'string'
	);
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

export async function currentBranch(cwd: string): Promise<string | null> {
	const result = await execa('git', ['branch', '--show-current'], {
		cwd,
		reject: false,
		timeout: 10_000,
	});
	if ((result.exitCode ?? 0) !== 0) return null;
	const branch = result.stdout.trim();
	return branch.length > 0 ? branch : null;
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
			type: 'controller-error',
			success: false,
			artifact: `Controller request failed: ${error instanceof Error ? error.message : String(error)}`,
		} satisfies ControllerToolFailure;
	}
	const text = await response.text();
	if (!response.ok) {
		return {
			type: 'controller-error',
			success: false,
			artifact: `Controller request failed with HTTP ${String(response.status)}: ${text}`,
		} satisfies ControllerToolFailure;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		return {
			type: 'controller-error',
			success: false,
			artifact: `Controller response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
		} satisfies ControllerToolFailure;
	}
}
