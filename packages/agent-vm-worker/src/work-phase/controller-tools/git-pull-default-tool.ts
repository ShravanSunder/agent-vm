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

function hasFastForwardedCurrentBranch(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || !('currentBranchSync' in value)) {
		return false;
	}
	const currentBranchSync = value.currentBranchSync;
	return (
		typeof currentBranchSync === 'object' &&
		currentBranchSync !== null &&
		'status' in currentBranchSync &&
		currentBranchSync.status === 'fast-forwarded'
	);
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
			'Ask the controller to fetch origin/default and fast-forward the local default branch ref. Does not modify your current branch. Returns commits added to default and divergence vs your current branch.',
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
			if ((currentHeadResult.exitCode ?? 0) !== 0) {
				return {
					type: 'pull-default',
					success: false,
					artifact: `Unable to read current git HEAD: ${[
						'git rev-parse HEAD failed',
						currentHeadResult.stdout,
						currentHeadResult.stderr,
					]
						.filter((line) => line.trim().length > 0)
						.join('\n')}`,
				};
			}
			const statusResult = await execa('git', ['status', '--porcelain'], {
				cwd: selected.repo.workPath,
				reject: false,
				timeout: GIT_TOOL_TIMEOUT_MS,
			});
			if ((statusResult.exitCode ?? 0) !== 0) {
				return {
					type: 'pull-default',
					success: false,
					artifact: `Unable to read worktree status: ${[
						'git status --porcelain failed',
						statusResult.stdout,
						statusResult.stderr,
					]
						.filter((line) => line.trim().length > 0)
						.join('\n')}`,
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
			if (hasFastForwardedCurrentBranch(result)) {
				const resetResult = await execa('git', ['reset', '--hard', 'HEAD'], {
					cwd: selected.repo.workPath,
					reject: false,
					timeout: GIT_TOOL_TIMEOUT_MS,
				});
				if ((resetResult.exitCode ?? 0) !== 0) {
					return {
						type: 'pull-default',
						success: false,
						artifact: `Controller fast-forwarded the current branch, but worker reset failed: ${[
							'git reset --hard HEAD failed',
							resetResult.stdout,
							resetResult.stderr,
						]
							.filter((line) => line.trim().length > 0)
							.join('\n')}`,
					};
				}
			}
			return { type: 'pull-default', success: true, artifact: result };
		},
	};
}
