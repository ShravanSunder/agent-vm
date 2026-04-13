import { z } from 'zod';

export const skillReferenceSchema = z.object({
	name: z.string().min(1),
	path: z.string().min(1),
});

export type SkillReference = z.infer<typeof skillReferenceSchema>;
