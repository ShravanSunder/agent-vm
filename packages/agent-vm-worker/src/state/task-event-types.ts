import { z } from 'zod';

import { workerConfigSchema } from '../config/worker-config.js';
import { phaseNames, reviewPhaseNames } from '../shared/phase-names.js';
import { repoLocationSchema } from '../shared/repo-location.js';
import { wrapupActionResultSchema } from '../wrapup/wrapup-types.js';
export type { WrapupActionResult } from '../wrapup/wrapup-types.js';

export const phaseNameSchema = z.enum(phaseNames);
export type PhaseName = z.infer<typeof phaseNameSchema>;

export const taskStatusValues = [
	'pending',
	'planning',
	'reviewing-plan',
	'working',
	'verifying',
	'reviewing-work',
	'wrapping-up',
	'completed',
	'closed',
	'failed',
] as const satisfies readonly string[];

export const taskStatusSchema = z.enum(taskStatusValues);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_STATUSES = ['completed', 'closed', 'failed'] as const;

export const taskConfigSchema = z.object({
	taskId: z.string().min(1),
	prompt: z.string().min(1),
	repos: z.array(repoLocationSchema),
	context: z.record(z.string(), z.unknown()),
	effectiveConfig: workerConfigSchema,
});

export type TaskConfig = z.infer<typeof taskConfigSchema>;

export const verificationCommandResultSchema = z.object({
	name: z.string(),
	passed: z.boolean(),
	exitCode: z.number().int(),
	output: z.string(),
});

export type VerificationCommandResult = z.infer<typeof verificationCommandResultSchema>;

export const taskEventSchema = z.discriminatedUnion('event', [
	z.object({
		event: z.literal('task-accepted'),
		taskId: z.string().min(1),
		config: taskConfigSchema,
	}),
	z.object({
		event: z.literal('phase-started'),
		phase: phaseNameSchema,
		loop: z.number().int().nonnegative().optional(),
	}),
	z.object({
		event: z.literal('phase-completed'),
		phase: phaseNameSchema,
		tokenCount: z.number().int().nonnegative().optional(),
	}),
	z.object({
		event: z.literal('plan-created'),
		plan: z.string(),
		threadId: z.string(),
	}),
	z.object({
		event: z.literal('work-started'),
		threadId: z.string(),
	}),
	z.object({
		event: z.literal('review-result'),
		phase: z.enum(reviewPhaseNames),
		approved: z.boolean(),
		summary: z.string(),
		loop: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('verification-result'),
		results: z.array(verificationCommandResultSchema),
	}),
	z.object({
		event: z.literal('fix-applied'),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('wrapup-result'),
		actions: z.array(wrapupActionResultSchema),
	}),
	z.object({
		event: z.literal('task-completed'),
	}),
	z.object({
		event: z.literal('task-failed'),
		reason: z.string(),
	}),
	z.object({
		event: z.literal('task-closed'),
	}),
]);

export type TaskEvent = z.infer<typeof taskEventSchema>;

export interface TimestampedEvent {
	readonly ts: string;
	readonly data: TaskEvent;
}
