import { z } from 'zod';

export const controllerLeasePeekResponseSchema = z.object({
	createdAt: z.number(),
	lastUsedAt: z.number(),
	leaseId: z.string(),
	profileId: z.string(),
	scopeKey: z.string(),
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
