import { GatewayStablePrincipalDigestSchema } from '@agent-vm/agent-portal-sdk/contracts';
import { z } from 'zod/v4';

export const ControllerExecutionDataPayloadMaxBytes = 1024 * 1024;
export const ControllerExecutionWebSocketPath = '/agent-vm/controller-execution';

const canonicalPaddedBase64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isCanonicalBoundedExecutionPayload(value: string): boolean {
	if (value.length < 4 || !canonicalPaddedBase64Pattern.test(value)) return false;
	const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	const decodedBytes = (value.length / 4) * 3 - paddingBytes;
	return decodedBytes <= ControllerExecutionDataPayloadMaxBytes;
}

const ControllerExecutionDataBindingSchema = z
	.object({
		audience: z.literal('controller-execution-data'),
		channelId: z.string().min(1),
		controllerEpoch: z.string().min(1),
		executionFingerprint: z.string().min(1),
		gatewayEpoch: z.string().min(1),
		operationId: z.string().min(1),
		runtimeEpoch: z.string().min(1),
		stablePrincipal: GatewayStablePrincipalDigestSchema,
	})
	.strict();

const ControllerExecutionFrameSequenceSchema = z.number().int().nonnegative().safe();

export const ControllerExecutionDataHandshakeSchema = ControllerExecutionDataBindingSchema.extend({
	kind: z.literal('handshake'),
}).strict();

export const ControllerExecutionDataCreditSchema = ControllerExecutionDataBindingSchema.extend({
	availableCreditBytes: ControllerExecutionFrameSequenceSchema,
	kind: z.literal('credit'),
	nextSequence: ControllerExecutionFrameSequenceSchema,
	queuedBytes: ControllerExecutionFrameSequenceSchema,
}).strict();

const ControllerExecutionDataPayloadSchema = z.string().refine(isCanonicalBoundedExecutionPayload, {
	message: `Execution data payload must be canonical padded base64 containing at most ${ControllerExecutionDataPayloadMaxBytes} decoded bytes.`,
});

const ControllerExecutionDataFrameVariantSchemas = [
	ControllerExecutionDataBindingSchema.extend({
		creditBytes: ControllerExecutionFrameSequenceSchema,
		kind: z.literal('data'),
		payloadBase64: ControllerExecutionDataPayloadSchema,
		sequence: ControllerExecutionFrameSequenceSchema,
	}).strict(),
	ControllerExecutionDataBindingSchema.extend({
		creditBytes: ControllerExecutionFrameSequenceSchema,
		kind: z.literal('eof'),
		sequence: ControllerExecutionFrameSequenceSchema,
	}).strict(),
	ControllerExecutionDataBindingSchema.extend({
		creditBytes: ControllerExecutionFrameSequenceSchema,
		kind: z.literal('cancel'),
		sequence: ControllerExecutionFrameSequenceSchema,
	}).strict(),
] as const;

export const ControllerExecutionDataFrameSchema = z.discriminatedUnion(
	'kind',
	ControllerExecutionDataFrameVariantSchemas,
);

export type ControllerExecutionDataBinding = z.infer<typeof ControllerExecutionDataBindingSchema>;
export type ControllerExecutionDataCredit = z.infer<typeof ControllerExecutionDataCreditSchema>;
export type ControllerExecutionDataFrame = z.infer<typeof ControllerExecutionDataFrameSchema>;
export type ControllerExecutionDataHandshake = z.infer<
	typeof ControllerExecutionDataHandshakeSchema
>;
