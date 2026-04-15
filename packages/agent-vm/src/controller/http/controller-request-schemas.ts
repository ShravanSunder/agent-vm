import { repoTargetSchema } from '@shravansunder/agent-vm-worker';
import { z } from 'zod';

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

export const controllerWorkerTaskRequestSchema = z.object({
	prompt: z.string().min(1),
	repos: z.array(repoTargetSchema).default([]),
	context: z.record(z.string(), z.unknown()).default({}),
});
