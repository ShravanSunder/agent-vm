import { z } from 'zod';

import { workerConfigSchema } from '../config/worker-config.js';
import { phaseNames } from '../shared/phase-names.js';
import { repoLocationSchema } from '../shared/repo-location.js';
import { reviewResultSchema } from '../shared/review-result.js';

export const phaseNameSchema = z.enum(phaseNames);
export type PhaseName = z.infer<typeof phaseNameSchema>;

export const taskStatusValues = [
	'pending',
	'plan-agent',
	'plan-reviewer',
	'work-agent',
	'work-reviewer',
	'wrapup',
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
	logPath: z.string().optional(),
});

export type VerificationCommandResult = z.infer<typeof verificationCommandResultSchema>;

export const taskEventSchema = z.discriminatedUnion('event', [
	z.object({
		event: z.literal('task-accepted'),
		taskId: z.string().min(1),
		config: taskConfigSchema,
	}),
	z.object({
		event: z.literal('context-gather-failed'),
		reason: z.string(),
	}),
	z.object({
		event: z.literal('phase-started'),
		phase: phaseNameSchema,
	}),
	z.object({
		event: z.literal('phase-completed'),
		phase: phaseNameSchema,
	}),
	z.object({
		event: z.literal('plan-agent-turn'),
		cycle: z.number().int().nonnegative(),
		threadId: z.string(),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('plan-reviewer-turn'),
		cycle: z.number().int().positive(),
		threadId: z.string(),
		tokenCount: z.number().int().nonnegative(),
		review: reviewResultSchema,
	}),
	z.object({
		event: z.literal('plan-finalized'),
		plan: z.string(),
	}),
	z.object({
		event: z.literal('work-agent-turn'),
		cycle: z.number().int().nonnegative(),
		threadId: z.string(),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('work-reviewer-turn'),
		cycle: z.number().int().positive(),
		threadId: z.string(),
		tokenCount: z.number().int().nonnegative(),
		review: reviewResultSchema,
		validationResults: z.array(verificationCommandResultSchema),
		validationSkipped: z.boolean().default(false),
	}),
	z.object({
		event: z.literal('wrapup-turn'),
		threadId: z.string(),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('wrapup-result'),
		prUrl: z.string().url().nullable(),
		branchName: z.string().nullable(),
		pushedCommits: z.array(z.string()),
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
