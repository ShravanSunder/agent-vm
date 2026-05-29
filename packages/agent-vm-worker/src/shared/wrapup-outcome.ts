import { z } from 'zod';

export const wrapupOutcomeSchema = z.enum(['pr-created', 'no-pr-needed', 'pr-blocked']);
export type WrapupOutcome = z.infer<typeof wrapupOutcomeSchema>;

const wrapupResultBaseSchema = z.object({
	summary: z.string(),
	branchName: z.string().nullable(),
	pushedCommits: z.array(z.string()).default([]),
});

export const wrapupPrCreatedResultSchema = wrapupResultBaseSchema.extend({
	outcome: z.literal('pr-created'),
	reason: z.null(),
	prUrl: z.string().url(),
});

export const wrapupNoPrNeededResultSchema = wrapupResultBaseSchema.extend({
	outcome: z.literal('no-pr-needed'),
	reason: z.string(),
	prUrl: z.null(),
});

export const wrapupPrBlockedResultSchema = wrapupResultBaseSchema.extend({
	outcome: z.literal('pr-blocked'),
	reason: z.string(),
	prUrl: z.null(),
});

export const wrapupFinalAnswerSchema = z.discriminatedUnion('outcome', [
	wrapupPrCreatedResultSchema,
	wrapupNoPrNeededResultSchema,
	wrapupPrBlockedResultSchema,
]);

export type WrapupFinalAnswer = z.infer<typeof wrapupFinalAnswerSchema>;
