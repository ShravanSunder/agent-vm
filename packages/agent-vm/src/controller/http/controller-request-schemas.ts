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
});

export const controllerPullDefaultResponseSchema = z.object({
	repoUrl: z.string().min(1),
	success: z.boolean(),
	error: z.string().optional(),
	defaultBranch: z.string().optional(),
	remoteDefaultHead: z.string().optional(),
	localDefaultHead: z.string().optional(),
	currentBranch: z.string().nullable().optional(),
	fetchedCommits: z.array(commitSummarySchema).optional(),
	commitsSinceForkPoint: z.array(commitSummarySchema).optional(),
	divergence: divergenceSchema.extend({ forkPoint: z.string() }).optional(),
});
