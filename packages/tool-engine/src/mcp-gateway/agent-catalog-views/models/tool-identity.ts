import { z } from 'zod';

export interface ToolIdentity {
	readonly namespace: string;
	readonly toolName: string;
}

export const toolIdentitySchema = z
	.object({
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();

export const toolRefSchema = z.string().startsWith('mcp:').brand<'ToolRef'>();

export type ToolRef = z.infer<typeof toolRefSchema>;
