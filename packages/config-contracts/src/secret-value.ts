import { z } from 'zod';

export const secretValueSchema = z.discriminatedUnion('source', [
	z
		.object({
			source: z.literal('environment'),
			name: z.string().min(1),
		})
		.strict(),
	z
		.object({
			source: z.literal('1password'),
			ref: z.string().min(1),
		})
		.strict(),
]);

export type SecretValue = z.infer<typeof secretValueSchema>;
