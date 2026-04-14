import { z } from 'zod';

import { codingGatewayConfigSchema } from '../config.js';

export const taskStatusValues = [
	'accepted',
	'planning',
	'implementing',
	'reviewing-code',
	'awaiting-followup',
	'completed',
	'failed',
] as const satisfies readonly string[];

export const taskStatusSchema = z.enum(taskStatusValues);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_STATUSES = ['completed', 'failed'] as const;

export const taskConfigSchema = codingGatewayConfigSchema.pick({
	model: true,
	reviewModel: true,
	plannerSkills: true,
	planReviewerSkills: true,
	coderSkills: true,
	codeReviewerSkills: true,
	maxPlanReviewLoops: true,
	maxCodeReviewLoops: true,
	maxSanityRetries: true,
}).extend({
	prompt: z.string().min(1),
	repoUrl: z.string().min(1),
	baseBranch: z.string().min(1),
	testCommand: z.string().min(1),
	lintCommand: z.string().min(1),
});

export type TaskConfig = z.infer<typeof taskConfigSchema>;

export const retryPromptContextSchema = z.object({
	sanityCheckAttempt: z.number().int().nonnegative(),
	maxSanityRetries: z.number().int().positive(),
	testOutput: z.string(),
	testExitCode: z.number().int(),
	lintOutput: z.string(),
	lintExitCode: z.number().int(),
	filesChanged: z.string(),
	originalPrompt: z.string(),
});

export type RetryPromptContext = z.infer<typeof retryPromptContextSchema>;

export const taskEventSchema = z.discriminatedUnion('event', [
	z.object({
		event: z.literal('task-accepted'),
		taskId: z.string().min(1),
		config: taskConfigSchema,
	}),
	z.object({
		event: z.literal('task-closed'),
	}),
	z.object({
		event: z.literal('context-gathered'),
		fileCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('plan-created'),
		plannerThreadId: z.string(),
		plan: z.string(),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('plan-review-started'),
		loop: z.number().int().positive(),
	}),
	z.object({
		event: z.literal('plan-approved'),
		loop: z.number().int().positive(),
	}),
	z.object({
		event: z.literal('plan-revision-requested'),
		loop: z.number().int().positive(),
		comments: z.string(),
	}),
	z.object({
		event: z.literal('plan-revised'),
		plan: z.string(),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('implementation-started'),
		coderThreadId: z.string(),
	}),
	z.object({
		event: z.literal('implementation-complete'),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('sanity-check-passed'),
	}),
	z.object({
		event: z.literal('sanity-check-failed'),
		testExitCode: z.number().int(),
		testOutput: z.string(),
		lintExitCode: z.number().int(),
		lintOutput: z.string(),
	}),
	z.object({
		event: z.literal('code-review-started'),
		loop: z.number().int().positive(),
	}),
	z.object({
		event: z.literal('code-approved'),
	}),
	z.object({
		event: z.literal('code-revision-requested'),
		loop: z.number().int().positive(),
		comments: z.string(),
	}),
	z.object({
		event: z.literal('code-fix-complete'),
		tokenCount: z.number().int().nonnegative(),
	}),
	z.object({
		event: z.literal('pr-created'),
		url: z.string().min(1),
		branch: z.string().min(1),
	}),
	z.object({
		event: z.literal('followup-accepted'),
		prompt: z.string().min(1),
	}),
	z.object({
		event: z.literal('task-failed'),
		reason: z.string(),
	}),
]);

export type TaskEvent = z.infer<typeof taskEventSchema>;

export interface TimestampedEvent {
	readonly ts: string;
	readonly data: TaskEvent;
}
