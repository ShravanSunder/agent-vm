import { z } from 'zod';

export const repoTargetSchema = z.object({
	repoUrl: z.string().min(1),
	baseBranch: z.string().min(1),
});

export type RepoTarget = z.infer<typeof repoTargetSchema>;

export const repoLocationSchema = repoTargetSchema.extend({
	gitDirPath: z.string().min(1),
	workPath: z.string().min(1),
});

export type RepoLocation = z.infer<typeof repoLocationSchema>;
