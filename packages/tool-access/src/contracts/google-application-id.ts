// Copied from agent-vm at 7cb295d1; existing packages remain unchanged until S4.
import { z } from 'zod';

export const googleOAuthApplicationIds = ['workspace-app', 'gmail-app', 'youtube-app'] as const;
export const googleOAuthApplicationIdSchema = z.enum(googleOAuthApplicationIds);
export type GoogleOAuthApplicationId = z.infer<typeof googleOAuthApplicationIdSchema>;
