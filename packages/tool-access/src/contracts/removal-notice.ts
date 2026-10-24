import { z } from 'zod';

import { markSchema, sessionRefSchema } from '#tool-access/contracts/workspace-token-claims';

export const removalSessionRefSchema = z.strictObject({
	installation: sessionRefSchema.shape.installation,
	harnessEndpoint: sessionRefSchema.shape.harness_endpoint,
	conversationId: sessionRefSchema.shape.conversation_id,
});
export const removalSubjectSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('bot'), botId: z.uuid() }),
	z.strictObject({ kind: z.literal('fleetHarnessSession'), sessionRef: removalSessionRefSchema }),
	z.strictObject({ kind: z.literal('machine'), installation: z.uuid() }),
]);
// PD-shaped stand-in until Fleet's Rust JSON Schema is vendored with its source revision.
export const removalNoticeSchema = z.strictObject({
	noticeId: z.uuidv7(),
	organizationId: z.uuid(),
	workspaceId: z.uuid(),
	subject: removalSubjectSchema,
	removalRevision: markSchema,
	reason: z.enum([
		'membershipEnded',
		'personaChanged',
		'botRetired',
		'credentialRetired',
		'machineRevoked',
		'allowanceWithdrawn',
		'sessionRemoved',
		'sessionEnded',
	]),
});
export const removalNoticeAckSchema = z.discriminatedUnion('result', [
	z.strictObject({ result: z.literal('recorded'), noticeId: removalNoticeSchema.shape.noticeId }),
	z.strictObject({
		result: z.literal('alreadyRecorded'),
		noticeId: removalNoticeSchema.shape.noticeId,
	}),
]);
export type RemovalNotice = z.infer<typeof removalNoticeSchema>;
export type RemovalSubject = z.infer<typeof removalSubjectSchema>;
export type RemovalNoticeAck = z.infer<typeof removalNoticeAckSchema>;
