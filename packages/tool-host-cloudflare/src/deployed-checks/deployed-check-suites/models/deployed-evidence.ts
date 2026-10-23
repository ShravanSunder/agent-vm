import { z } from 'zod';

export const portalResponseObservationSchema = z.strictObject({
	status: z.number(),
	result: z.record(z.string(), z.unknown()),
	bytes: z.number().nonnegative(),
});
export const overlapRunSchema = z.strictObject({
	runId: z.string(),
	overlapRunId: z.string(),
	callIds: z.array(z.string()).min(1),
	responses: z.array(portalResponseObservationSchema).length(3),
	startedAt: z.number(),
	endedAt: z.number(),
});
export const tailRecordSchema = z.object({
	outcome: z.string(),
	event: z.object({ request: z.object({ url: z.string() }) }),
	logs: z.array(z.object({ timestamp: z.number(), message: z.array(z.unknown()) })),
	exceptions: z.array(z.unknown()).optional(),
	eventTimestamp: z.number(),
});
export const requestLogSchema = z.strictObject({
	event: z.enum(['request-started', 'request-ended']),
	isolateId: z.string().min(1),
	requestId: z.string().min(1),
	activeRequests: z.number().int().nonnegative(),
});
export const analyticsRowSchema = z.object({
	index1: z.string(),
	blob1: z.string(),
	blob2: z.string(),
	blob3: z.enum(['direct', 'indirect']),
	blob4: z.string(),
	blob5: z.string(),
	blob6: z.enum(['ran', 'refused', 'needs approval', 'failed']),
	blob7: z.enum(['none', 'authorization', 'approval', 'upstream', 'too-large', 'invalid-input']),
	blob8: z.literal('no'),
	double1: z.number().finite().nonnegative(),
	double2: z.number().finite().nonnegative(),
	double3: z.number().finite().nonnegative(),
});
export const analyticsSqlResponseSchema = z.object({
	data: z.array(analyticsRowSchema).min(1),
	meta: z.array(z.unknown()).optional(),
	rows: z.number().optional(),
});
export const canaryRunSchema = z.strictObject({
	runId: z.string(),
	startedAt: z.number(),
	endedAt: z.number(),
	argumentCanary: z.string(),
	resultCanary: z.string(),
	token: z.string(),
	callId: z.string(),
});
export type TailRecord = z.infer<typeof tailRecordSchema>;
export type PortalResponseObservation = z.infer<typeof portalResponseObservationSchema>;
