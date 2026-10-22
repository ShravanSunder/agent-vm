import { z } from 'zod';
export const toolPortalAgentConfigSchema = z.object({ profile: z.string().min(1) }).strict();
export type ToolPortalAgentConfig = z.infer<typeof toolPortalAgentConfigSchema>;
