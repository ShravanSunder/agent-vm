import { execa } from 'execa';

import type { RepoLocation } from '../../shared/repo-location.js';
import type { ToolDefinition } from '../../work-executor/executor-interface.js';
import {
	currentBranch,
	isControllerToolFailure,
	postControllerJson,
	selectRepo,
} from './controller-tool-support.js';

const CONTROLLER_TOOL_TIMEOUT_MS = 120_000;
const GIT_TOOL_TIMEOUT_MS = 30_000;

interface GitToolCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode?: number;
}

type PullDefaultToolControllerResult =
	| ({
			readonly kind: 'advanced';
			readonly success: true;
			readonly message: string;
			readonly currentBranchSync?: PullDefaultToolCurrentBranchSync;
	  } & Readonly<Record<string, unknown>>)
	| ({
			readonly kind: 'failed' | 'refused-not-fast-forward';
			readonly success: false;
			readonly error?: string;
			readonly message?: string;
	  } & Readonly<Record<string, unknown>>);

type PullDefaultToolCurrentBranchSync =
	| {
			readonly status: 'fast-forwarded';
			readonly branch: string;
			readonly localHead: string;
			readonly remoteHead: string;
	  }
	| {
			readonly status: 'default-branch';
			readonly branch: string;
			readonly localHead: string;
			readonly remoteHead: string;
	  }
	| {
			readonly status:
				| 'ahead'
				| 'detached'
				| 'dirty-worktree'
				| 'diverged'
				| 'no-upstream'
				| 'up-to-date';
	  };

function formatGitToolFailure(command: string, result: GitToolCommandResult): string {
	const headline =
		typeof result.exitCode === 'number'
			? `${command} failed`
			: `${command} terminated without an exit code`;
	return [headline, result.stdout, result.stderr]
		.filter((line) => line.trim().length > 0)
		.join('\n');
}

function isSuccessfulGitToolResult(result: GitToolCommandResult): boolean {
	return typeof result.exitCode === 'number' && result.exitCode === 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseCurrentBranchSync(value: unknown): PullDefaultToolCurrentBranchSync | null {
	if (!isObjectRecord(value) || typeof value.status !== 'string') return null;
	switch (value.status) {
		case 'fast-forwarded':
		case 'default-branch':
			return typeof value.branch === 'string' &&
				typeof value.localHead === 'string' &&
				typeof value.remoteHead === 'string'
				? {
						...value,
						status: value.status,
						branch: value.branch,
						localHead: value.localHead,
						remoteHead: value.remoteHead,
					}
				: null;
		case 'ahead':
		case 'detached':
		case 'dirty-worktree':
		case 'diverged':
		case 'no-upstream':
		case 'up-to-date':
			return { ...value, status: value.status };
		default:
			return null;
	}
}

function parseControllerPullDefaultResult(value: unknown): PullDefaultToolControllerResult | null {
	if (!isObjectRecord(value) || typeof value.kind !== 'string') return null;
	switch (value.kind) {
		case 'advanced': {
			if (value.success !== true || typeof value.message !== 'string') return null;
			if ('currentBranchSync' in value) {
				const currentBranchSync = parseCurrentBranchSync(value.currentBranchSync);
				if (!currentBranchSync) return null;
				return {
					...value,
					kind: 'advanced',
					success: true,
					message: value.message,
					currentBranchSync,
				};
			}
			return {
				...value,
				kind: 'advanced',
				success: true,
				message: value.message,
			};
		}
		case 'failed':
		case 'refused-not-fast-forward':
			return value.success === false
				? {
						...value,
						kind: value.kind,
						success: false,
						...(typeof value.error === 'string' ? { error: value.error } : {}),
						...(typeof value.message === 'string' ? { message: value.message } : {}),
					}
				: null;
		default:
			return null;
	}
}

function controllerResultMessage(value: PullDefaultToolControllerResult): string {
	if ('message' in value && typeof value.message === 'string') {
		return value.message;
	}
	if ('error' in value && typeof value.error === 'string') {
		return value.error;
	}
	return 'Controller returned pull-default success=false without a message.';
}

function shouldResetWorktreeAfterControllerPull(result: PullDefaultToolControllerResult): boolean {
	if (result.kind !== 'advanced') return false;
	const sync = result.currentBranchSync;
	if (!sync) return false;
	switch (sync.status) {
		case 'fast-forwarded':
			return true;
		case 'default-branch':
			return sync.localHead !== sync.remoteHead;
		case 'ahead':
		case 'detached':
		case 'dirty-worktree':
		case 'diverged':
		case 'no-upstream':
		case 'up-to-date':
			return false;
		default: {
			const exhaustiveStatus: never = sync;
			return exhaustiveStatus;
		}
	}
}

export interface CreateGitPullDefaultToolProps {
	readonly controllerBaseUrl: string;
	readonly zoneId: string;
	readonly taskId: string;
	readonly repos: readonly RepoLocation[];
}

export function createGitPullDefaultTool(props: CreateGitPullDefaultToolProps): ToolDefinition {
	return {
		name: 'git-pull-default',
		description:
			'Ask the controller to refresh origin/default and safely refresh your current branch. It fast-forwards the default branch ref, fetches origin/<currentBranch>, and if your current branch is clean and behind its upstream, fast-forwards that branch and resets the worktree to the new HEAD. It never merges or rebases. currentBranchSync.status can be fast-forwarded, up-to-date, ahead, diverged, dirty-worktree, no-upstream, detached, or default-branch; read the returned message before deciding the next git action.',
		inputSchema: {
			type: 'object',
			properties: {
				repoWorkPath: { type: 'string' },
				repoUrl: { type: 'string' },
			},
			additionalProperties: false,
		},
		async execute(params) {
			const selected = selectRepo(props.repos, params);
			if (!selected.repo) {
				return {
					type: 'pull-default',
					success: false,
					artifact: selected.error ?? 'Repo not found.',
				};
			}
			const currentBranchResult = await currentBranch(selected.repo.workPath);
			if (!currentBranchResult.ok) {
				return {
					type: 'pull-default',
					success: false,
					artifact: `Unable to read current git branch: ${currentBranchResult.error}`,
				};
			}
			const currentHeadResult = await execa('git', ['rev-parse', 'HEAD'], {
				cwd: selected.repo.workPath,
				reject: false,
				timeout: GIT_TOOL_TIMEOUT_MS,
			});
			if (!isSuccessfulGitToolResult(currentHeadResult)) {
				return {
					type: 'pull-default',
					success: false,
					artifact: `Unable to read current git HEAD: ${formatGitToolFailure('git rev-parse HEAD', currentHeadResult)}`,
				};
			}
			const statusResult = await execa('git', ['status', '--porcelain'], {
				cwd: selected.repo.workPath,
				reject: false,
				timeout: GIT_TOOL_TIMEOUT_MS,
			});
			if (!isSuccessfulGitToolResult(statusResult)) {
				return {
					type: 'pull-default',
					success: false,
					artifact: `Unable to read worktree status: ${formatGitToolFailure('git status --porcelain', statusResult)}`,
				};
			}

			const result = await postControllerJson({
				url: `${props.controllerBaseUrl}/zones/${props.zoneId}/tasks/${props.taskId}/pull-default`,
				timeoutMs: CONTROLLER_TOOL_TIMEOUT_MS,
				body: {
					repoUrl: selected.repo.repoUrl,
					currentBranch: currentBranchResult.branch,
					currentHead: currentHeadResult.stdout.trim(),
					worktreeDirty: statusResult.stdout.trim().length > 0,
				},
			});
			if (isControllerToolFailure(result)) {
				return { type: 'pull-default', success: false, artifact: result.artifact };
			}
			const pullResult = parseControllerPullDefaultResult(result);
			if (!pullResult) {
				return {
					type: 'pull-default',
					success: false,
					artifact: 'Controller returned an unexpected pull-default response.',
				};
			}
			if (!pullResult.success) {
				return {
					type: 'pull-default',
					success: false,
					artifact: controllerResultMessage(pullResult),
				};
			}
			if (shouldResetWorktreeAfterControllerPull(pullResult)) {
				const resetResult = await execa('git', ['reset', '--hard', 'HEAD'], {
					cwd: selected.repo.workPath,
					reject: false,
					timeout: GIT_TOOL_TIMEOUT_MS,
				});
				if (!isSuccessfulGitToolResult(resetResult)) {
					return {
						type: 'pull-default',
						success: false,
						artifact: `Controller fast-forwarded the current branch, but worker reset failed: ${formatGitToolFailure('git reset --hard HEAD', resetResult)}`,
					};
				}
			}
			return {
				type: 'pull-default',
				success: true,
				artifact: {
					message: controllerResultMessage(pullResult),
					result: pullResult,
				},
			};
		},
	};
}
