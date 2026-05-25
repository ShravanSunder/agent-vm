import { z } from 'zod';

export const controllerLeasePeekResponseSchema = z.object({
	agentId: z.string(),
	createdAt: z.number(),
	idleTtlMs: z.number(),
	lastUsedAt: z.number(),
	leaseId: z.string(),
	profileId: z.string(),
	ssh: z.object({
		host: z.string(),
		port: z.number().int(),
		user: z.string(),
	}),
	tcpSlot: z.number().int(),
	transport: z.literal('ssh-sandbox'),
	workdir: z.string(),
	zoneId: z.string(),
});

export type ControllerLeasePeekResponse = z.infer<typeof controllerLeasePeekResponseSchema>;
