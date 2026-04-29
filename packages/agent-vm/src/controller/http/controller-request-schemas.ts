import { z } from 'zod';

import { workerTaskControllerRequestSchema } from '../../config/resource-contracts/index.js';

export const controllerLeaseCreateRequestSchema = z.object({
	agentWorkspaceDir: z.string().min(1),
	profileId: z.string().min(1),
	scopeKey: z.string().min(1),
	workspaceDir: z.string().min(1),
	zoneId: z.string().min(1),
});

export const controllerDestroyZoneRequestSchema = z.object({
	purge: z.boolean().optional(),
});

export const controllerExecuteCommandRequestSchema = z.object({
	command: z.string().min(1),
});

export const controllerWorkerTaskRequestSchema = workerTaskControllerRequestSchema;

export const controllerPushBranchesRequestSchema = z.object({
	branches: z
		.array(
			z.object({
				repoUrl: z.string().min(1),
				branchName: z.string().min(1),
			}),
		)
		.min(1),
});

const commitSummarySchema = z.object({
	sha: z.string().min(1),
	subject: z.string(),
	author: z.string().optional(),
	date: z.string().optional(),
});

const divergenceSchema = z.object({
	aheadOfDefault: z.number().int().nonnegative(),
	behindDefault: z.number().int().nonnegative(),
});

export const controllerPushBranchesResponseSchema = z.object({
	results: z.array(
		z.object({
			repoUrl: z.string().min(1),
			branch: z.string().min(1),
			success: z.boolean(),
			error: z.string().optional(),
			localHead: z.string().optional(),
			remoteBranchHead: z.string().optional(),
			defaultBranch: z.string().optional(),
			remoteDefaultHead: z.string().optional(),
			commitsOnBranch: z.array(commitSummarySchema).optional(),
			pushedInThisCall: z.array(commitSummarySchema).optional(),
			remoteAlreadyHadBranch: z.boolean().optional(),
			divergence: divergenceSchema.optional(),
		}),
	),
});

export const controllerPullDefaultRequestSchema = z.object({
	repoUrl: z.string().min(1),
	currentBranch: z.string().min(1).nullable().optional(),
	currentHead: z.string().min(1).optional(),
	/**
	 * Caller-attested `git status --porcelain` dirtiness for the current worktree.
	 * The controller uses it to decide whether a current-branch fast-forward is
	 * safe; the host-side bare gitdir cannot inspect the worker worktree itself.
	 */
	worktreeDirty: z.boolean().optional(),
});

const currentBranchAheadSchema = z.object({
	status: z.literal('ahead'),
	branch: z.string().min(1),
	upstreamTrackingRef: z.string().min(1),
	localHead: z.string().min(1),
	remoteHead: z.string().min(1),
	reason: z.string().min(1),
});

const currentBranchDefaultBranchSchema = z.object({
	status: z.literal('default-branch'),
	branch: z.string().min(1),
	upstreamTrackingRef: z.string().min(1),
	localHead: z.string().min(1),
	remoteHead: z.string().min(1),
	reason: z.string().min(1),
});

const currentBranchDetachedSchema = z.object({
	status: z.literal('detached'),
	branch: z.null(),
	upstreamTrackingRef: z.null(),
	localHead: z.string().min(1),
	reason: z.string().min(1),
});

const currentBranchDirtyWorktreeSchema = z.object({
	status: z.literal('dirty-worktree'),
	branch: z.string().min(1),
	upstreamTrackingRef: z.string().min(1),
	localHead: z.string().min(1),
	remoteHead: z.string().min(1),
	reason: z.string().min(1),
});

const currentBranchDivergedSchema = z.object({
	status: z.literal('diverged'),
	branch: z.string().min(1),
	upstreamTrackingRef: z.string().min(1),
	localHead: z.string().min(1),
	remoteHead: z.string().min(1),
	reason: z.string().min(1),
});

const currentBranchFastForwardedSchema = z.object({
	status: z.literal('fast-forwarded'),
	branch: z.string().min(1),
	upstreamTrackingRef: z.string().min(1),
	localHead: z.string().min(1),
	remoteHead: z.string().min(1),
});

const currentBranchNoUpstreamSchema = z.object({
	status: z.literal('no-upstream'),
	branch: z.string().min(1),
	upstreamTrackingRef: z.null(),
	localHead: z.string().min(1).optional(),
	reason: z.string().min(1),
});

const currentBranchUpToDateSchema = z.object({
	status: z.literal('up-to-date'),
	branch: z.string().min(1),
	upstreamTrackingRef: z.string().min(1),
	localHead: z.string().min(1),
	remoteHead: z.string().min(1),
});

const currentBranchSyncSchema = z.discriminatedUnion('status', [
	currentBranchAheadSchema,
	currentBranchDefaultBranchSchema,
	currentBranchDetachedSchema,
	currentBranchDirtyWorktreeSchema,
	currentBranchDivergedSchema,
	currentBranchFastForwardedSchema,
	currentBranchNoUpstreamSchema,
	currentBranchUpToDateSchema,
]);

const pullDefaultAdvancedResponseSchema = z.object({
	kind: z.literal('advanced'),
	repoUrl: z.string().min(1),
	success: z.literal(true),
	message: z.string().min(1),
	defaultBranch: z.string().min(1),
	remoteDefaultHead: z.string().min(1),
	localDefaultHead: z.string().min(1),
	currentBranch: z.string().nullable().optional(),
	fetchedCommits: z.array(commitSummarySchema),
	commitsSinceForkPoint: z.array(commitSummarySchema),
	divergence: divergenceSchema.extend({ forkPoint: z.string() }),
	currentBranchSync: currentBranchSyncSchema.optional(),
});

const pullDefaultRefusedNotFastForwardResponseSchema = z.object({
	kind: z.literal('refused-not-fast-forward'),
	repoUrl: z.string().min(1),
	success: z.literal(false),
	message: z.string().min(1),
	error: z.string().min(1),
	defaultBranch: z.string().min(1),
	remoteDefaultHead: z.string().min(1),
});

const pullDefaultFailedResponseSchema = z.object({
	kind: z.literal('failed'),
	repoUrl: z.string().min(1),
	success: z.literal(false),
	message: z.string().min(1),
	error: z.string().min(1),
});

export const controllerPullDefaultResponseSchema = z.discriminatedUnion('kind', [
	pullDefaultAdvancedResponseSchema,
	pullDefaultRefusedNotFastForwardResponseSchema,
	pullDefaultFailedResponseSchema,
]);
