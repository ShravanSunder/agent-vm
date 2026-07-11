import { ZodError, z } from 'zod/v4';

export const CONTROL_PROTOCOL_VERSION = 1;

export const CONTROL_SESSION_TIMING_MS = {
	activeUseHeartbeatCadence: 30_000,
	activeUseStaleTtl: 120_000,
	clockSkewTolerance: 30_000,
	commandAckTimeout: 2_000,
	connectTimeout: 3_000,
	controlSessionDeathGrace: 600_000,
	engineIoPingInterval: 10_000,
	engineIoPingTimeout: 10_000,
	manualReconnectInitialDelay: 250,
	manualReconnectJitterRatio: 0.2,
	manualReconnectMaxDelay: 5_000,
	priorityAckFailureThreshold: 3,
	resyncTimeout: 5_000,
} as const;

export const CONTROL_QUEUE_LIMITS = {
	dedupeWindowMessages: 512,
	dedupeWindowTtlMs: 60_000,
	maxHttpBufferBytes: 65_536,
	queueByteCap: 4 * 1024 * 1024,
	queueMessageCap: 256,
} as const;

export const ControlDomainSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);

export const KnownControlDomainSchema = z.enum(['gateway_control', 'worker_control']);

export const ControlMessageKindSchema = z.enum(['command', 'command_result', 'event', 'heartbeat']);

export const ControlDeliveryPolicySchema = z.enum([
	'latest_wins',
	'droppable',
	'acked_idempotent',
	'critical_idempotent',
	'append_only_observation',
	'single_use_critical',
	'forbidden_bulk',
]);

export const ControlSessionCloseReasonSchema = z.enum([
	'normal_shutdown',
	'controller_restart',
	'peer_restart',
	'auth_failed',
	'protocol_version_mismatch',
	'domain_mismatch',
	'generation_mismatch',
	'controller_epoch_mismatch',
	'duplicate_session',
	'stale_session',
	'sequence_gap',
	'ack_timeout',
	'command_timeout',
	'resync_timeout',
	'queue_overflow',
	'message_too_large',
	'schema_validation_failed',
	'forbidden_bulk_message',
	'transport_error',
]);

export const ControlEnvelopeSchema = z
	.object({
		bootId: z.string().min(1),
		commandId: z.string().uuid().optional(),
		connectionId: z.string().uuid(),
		controllerEpoch: z.string().min(1),
		createdAtMs: z.number().int().positive(),
		deliveryPolicy: ControlDeliveryPolicySchema,
		domain: ControlDomainSchema,
		expiresAtMs: z.number().int().positive().optional(),
		idempotencyKey: z.string().min(1).optional(),
		kind: ControlMessageKindSchema,
		messageId: z.string().uuid(),
		operation: z.string().min(1).optional(),
		peerId: z.string().min(1),
		protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
		sequence: z.number().int().nonnegative(),
		sessionId: z.string().uuid(),
		zoneId: z.string().min(1),
	})
	.strict();

export const ControlSessionStateSchema = z.enum([
	'unknown',
	'connecting',
	'ready',
	'reconnecting',
	'stale',
	'rejected',
	'generation_mismatch',
	'failed',
	'closed',
]);

export const ControlRpcResultBaseSchema = z.enum([
	'ok',
	'failed',
	'timeout',
	'rejected',
	'cancelled',
	'stale_generation',
]);

export const ControlRpcErrorSchema = z
	.object({
		errorClass: z.string().min(1),
		retryable: z.boolean().optional(),
		safeMessage: z.string().min(1).optional(),
	})
	.strict();

export const ControlCorrelationSchema = z
	.object({
		causationId: z.string().uuid().optional(),
		correlationId: z.string().min(1).optional(),
		requestId: z.string().min(1).optional(),
		runId: z.string().min(1).optional(),
		sessionKeyDigest: z.string().min(32).optional(),
		toolCallId: z.string().min(1).optional(),
		traceId: z
			.string()
			.regex(/^[0-9a-f]{32}$/u)
			.optional(),
	})
	.strict();

export const ControlCloseSchema = z
	.object({
		reason: ControlSessionCloseReasonSchema,
		safeMessage: z.string().min(1).optional(),
		sessionId: z.string().uuid(),
	})
	.strict();

export const ControlMessageAcceptedReceiptSchema = z
	.object({
		received: z.literal(true),
	})
	.strict();

export const ControlMessageRejectedReceiptSchema = z
	.object({
		errorClass: z.string().min(1),
		received: z.literal(false),
		safeMessage: z.string().min(1).optional(),
	})
	.strict();

export const ControlMessageReceiptSchema = z.discriminatedUnion('received', [
	ControlMessageAcceptedReceiptSchema,
	ControlMessageRejectedReceiptSchema,
]);

export const DomainCommandResultResponseLinkSchema = z
	.object({
		kind: z.literal('command_result'),
		payload: z
			.object({
				responseToMessageId: z.string().uuid(),
			})
			.passthrough(),
	})
	.passthrough();

export const ControlHandshakeCredentialSchema = z
	.object({
		audience: KnownControlDomainSchema,
		bootId: z.string().min(1),
		controllerEpoch: z.string().min(1),
		credentialId: z.string().min(1),
		expiresAtMs: z.number().int().positive(),
		generationId: z.string().min(1),
		issuedAtMs: z.number().int().positive(),
		nonce: z.string().min(16),
		peerId: z.string().min(1),
		protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
		zoneId: z.string().min(1),
	})
	.strict()
	.refine((value) => value.expiresAtMs > value.issuedAtMs, {
		message: 'expiresAtMs must be greater than issuedAtMs',
		path: ['expiresAtMs'],
	});

export const ControlHandshakeProofSchema = ControlHandshakeCredentialSchema.extend({
	signature: z.string().min(1),
}).strict();

export const ControlReadyRequestCredentialSchema = z
	.object({
		audience: KnownControlDomainSchema,
		bootId: z.string().min(1),
		controllerEpoch: z.string().min(1),
		generationId: z.string().min(1),
		issuedAtMs: z.number().int().positive(),
		peerId: z.string().min(1),
		protocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
		requestId: z.string().uuid(),
		zoneId: z.string().min(1),
	})
	.strict();

export const ControlReadyRequestProofSchema = ControlReadyRequestCredentialSchema.extend({
	signature: z.string().min(1),
}).strict();

export const ControlHandshakeHeadersSchema = z
	.object({
		proof: ControlHandshakeProofSchema,
	})
	.strict();

export const CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE = 'agent-vm.control.v1';

export const CONTROL_HANDSHAKE_HEADER_NAMES = {
	bootId: 'x-agent-vm-control-boot-id',
	controllerEpoch: 'x-agent-vm-control-controller-epoch',
	credentialId: 'x-agent-vm-control-credential-id',
	domain: 'x-agent-vm-control-domain',
	expiresAtMs: 'x-agent-vm-control-expires-at-ms',
	generationId: 'x-agent-vm-control-generation-id',
	issuedAtMs: 'x-agent-vm-control-issued-at-ms',
	nonce: 'x-agent-vm-control-nonce',
	peerId: 'x-agent-vm-control-peer-id',
	protocol: 'x-agent-vm-control-protocol',
	signature: 'x-agent-vm-control-signature',
	zoneId: 'x-agent-vm-control-zone-id',
} as const;

export const CONTROL_READY_HEADER_NAMES = {
	bootId: CONTROL_HANDSHAKE_HEADER_NAMES.bootId,
	controllerEpoch: CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch,
	domain: CONTROL_HANDSHAKE_HEADER_NAMES.domain,
	generationId: CONTROL_HANDSHAKE_HEADER_NAMES.generationId,
	issuedAtMs: CONTROL_HANDSHAKE_HEADER_NAMES.issuedAtMs,
	peerId: CONTROL_HANDSHAKE_HEADER_NAMES.peerId,
	protocol: CONTROL_HANDSHAKE_HEADER_NAMES.protocol,
	requestId: 'x-agent-vm-control-ready-request-id',
	signature: CONTROL_HANDSHAKE_HEADER_NAMES.signature,
	zoneId: CONTROL_HANDSHAKE_HEADER_NAMES.zoneId,
} as const;

export const controlMessageKindDisposition = {
	command: 'rpc_lifecycle',
	command_result: 'rpc_lifecycle',
	event: 'domain_event',
	heartbeat: 'priority_liveness',
} as const satisfies Record<ControlMessageKind, string>;

export type ControlDomain = z.infer<typeof ControlDomainSchema>;
export type KnownControlDomain = z.infer<typeof KnownControlDomainSchema>;
export type ControlMessageKind = z.infer<typeof ControlMessageKindSchema>;
export type ControlDeliveryPolicy = z.infer<typeof ControlDeliveryPolicySchema>;
export type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
export type ControlMessageReceipt = z.infer<typeof ControlMessageReceiptSchema>;
export type ControlClose = z.infer<typeof ControlCloseSchema>;
export type ControlSessionCloseReason = z.infer<typeof ControlSessionCloseReasonSchema>;
export type ControlHandshakeCredential = z.infer<typeof ControlHandshakeCredentialSchema>;
export type ControlHandshakeProof = z.infer<typeof ControlHandshakeProofSchema>;
export type ControlReadyRequestCredential = z.infer<typeof ControlReadyRequestCredentialSchema>;
export type ControlReadyRequestProof = z.infer<typeof ControlReadyRequestProofSchema>;

export type ControlHelloAcknowledge<TControlHelloResponse> = (
	response: TControlHelloResponse,
) => void;
export type ControlMessageAcknowledge = (receipt: ControlMessageReceipt) => void;
export type ControlCloseAcknowledge = (receipt: ControlMessageReceipt) => void;

export interface ControlSessionControllerToPeerEvents<
	TDomainMessage,
	TControlHello,
	TControlHelloResponse,
> {
	'control:close': (payload: ControlClose, acknowledge: ControlCloseAcknowledge) => void;
	'control:hello': (
		payload: TControlHello,
		acknowledge: ControlHelloAcknowledge<TControlHelloResponse>,
	) => void;
	'control:message': (
		envelope: ControlEnvelope,
		payload: TDomainMessage,
		acknowledge: ControlMessageAcknowledge,
	) => void;
}

export interface ControlSessionPeerToControllerEvents<TDomainMessage> {
	'control:close': (payload: ControlClose, acknowledge: ControlCloseAcknowledge) => void;
	'control:message': (
		envelope: ControlEnvelope,
		payload: TDomainMessage,
		acknowledge: ControlMessageAcknowledge,
	) => void;
}

export interface DomainControlMessageIdentity {
	readonly kind: ControlMessageKind;
	readonly operation?: string;
}

export interface DeliveryPolicyDerivationProps {
	readonly envelope: ControlEnvelope;
	readonly policyByOperation: Readonly<Record<string, ControlDeliveryPolicy>>;
	readonly policyByKind?: Partial<Record<ControlMessageKind, ControlDeliveryPolicy>>;
}

export function assertControlEnvelopeMatchesDomainMessage(
	envelope: ControlEnvelope,
	domainMessage: DomainControlMessageIdentity,
): void {
	if (envelope.kind !== domainMessage.kind) {
		throw new Error(`control message kind mismatch: ${envelope.kind} !== ${domainMessage.kind}`);
	}
	if (envelope.operation !== domainMessage.operation) {
		throw new Error(
			`control message operation mismatch: ${envelope.operation ?? '<none>'} !== ${domainMessage.operation ?? '<none>'}`,
		);
	}
}

export function buildControlMessageReceipt(): ControlMessageReceipt {
	return ControlMessageReceiptSchema.parse({ received: true });
}

export function buildControlMessageRejectionReceipt(props: {
	readonly errorClass: string;
	readonly safeMessage?: string;
}): ControlMessageReceipt {
	return ControlMessageReceiptSchema.parse({
		errorClass: props.errorClass,
		received: false,
		...(props.safeMessage === undefined ? {} : { safeMessage: props.safeMessage }),
	});
}

export function buildControlMessageExceptionRejectionReceipt(props: {
	readonly error: unknown;
	readonly processingErrorClass: string;
	readonly safeMessage: string;
	readonly schemaErrorClass?: string;
}): ControlMessageReceipt {
	return buildControlMessageRejectionReceipt({
		errorClass:
			props.error instanceof ZodError
				? (props.schemaErrorClass ?? 'schema_validation_failed')
				: props.processingErrorClass,
		safeMessage: props.safeMessage,
	});
}

export function assertControlMessageReceiptAccepted(receiptPayload: unknown): void {
	const receipt = ControlMessageReceiptSchema.parse(receiptPayload);
	if (!receipt.received) {
		throw new Error(receipt.safeMessage ?? receipt.errorClass);
	}
}

export function extractDomainCommandResultResponseToMessageId(
	payload: unknown,
): string | undefined {
	const parsed = DomainCommandResultResponseLinkSchema.safeParse(payload);
	return parsed.success ? parsed.data.payload.responseToMessageId : undefined;
}

export function buildControlHandshakeSignaturePayload(proof: ControlHandshakeCredential): string {
	return JSON.stringify({
		audience: proof.audience,
		bootId: proof.bootId,
		controllerEpoch: proof.controllerEpoch,
		credentialId: proof.credentialId,
		expiresAtMs: proof.expiresAtMs,
		generationId: proof.generationId,
		issuedAtMs: proof.issuedAtMs,
		nonce: proof.nonce,
		peerId: proof.peerId,
		protocolVersion: proof.protocolVersion,
		zoneId: proof.zoneId,
	});
}

export function buildControlReadyRequestSignaturePayload(
	proof: ControlReadyRequestCredential,
): string {
	return JSON.stringify({
		audience: proof.audience,
		bootId: proof.bootId,
		controllerEpoch: proof.controllerEpoch,
		generationId: proof.generationId,
		issuedAtMs: proof.issuedAtMs,
		peerId: proof.peerId,
		protocolVersion: proof.protocolVersion,
		requestId: proof.requestId,
		zoneId: proof.zoneId,
	});
}

export function deriveControlDeliveryPolicy(
	props: DeliveryPolicyDerivationProps,
): ControlDeliveryPolicy {
	if (props.envelope.operation !== undefined) {
		const operationPolicy = props.policyByOperation[props.envelope.operation];
		if (operationPolicy !== undefined) {
			return operationPolicy;
		}
	}
	const kindPolicy = props.policyByKind?.[props.envelope.kind];
	if (kindPolicy !== undefined) {
		return kindPolicy;
	}
	throw new Error(
		`no derived delivery policy for ${props.envelope.kind}:${props.envelope.operation ?? '<none>'}`,
	);
}

export function assertDerivedControlDeliveryPolicy(props: DeliveryPolicyDerivationProps): void {
	const derivedPolicy = deriveControlDeliveryPolicy(props);
	if (props.envelope.deliveryPolicy !== derivedPolicy) {
		throw new Error(
			`control delivery policy mismatch: ${props.envelope.deliveryPolicy} !== ${derivedPolicy}`,
		);
	}
}

export function coalesceLatestWinsByKey<TMessage>(
	messages: readonly TMessage[],
	keyForMessage: (message: TMessage) => string,
): readonly TMessage[] {
	const latestByKey = new Map<string, TMessage>();
	for (const message of messages) {
		latestByKey.set(keyForMessage(message), message);
	}
	return [...latestByKey.values()];
}

export function shouldReplayControlEnvelope(envelope: ControlEnvelope): boolean {
	return (
		envelope.deliveryPolicy !== 'droppable' &&
		envelope.deliveryPolicy !== 'latest_wins' &&
		envelope.deliveryPolicy !== 'forbidden_bulk'
	);
}

export interface ControlSequenceContinuityProps {
	readonly advisorySequenceMode?: 'contiguous' | 'lossy';
	readonly envelope: ControlEnvelope;
	readonly lastSeenSequence: number;
}

export interface ControlEnvelopeSequencedMessage {
	readonly envelope: Pick<ControlEnvelope, 'sequence'>;
}

export function orderControlMessagesByEnvelopeSequence<
	TControlMessage extends ControlEnvelopeSequencedMessage,
>(messages: readonly TControlMessage[]): readonly TControlMessage[] {
	return messages.toSorted((left, right) => left.envelope.sequence - right.envelope.sequence);
}

function controlSequenceDiagnosticSuffix(envelope: ControlEnvelope): string {
	return ` kind=${envelope.kind} operation=${envelope.operation ?? '<none>'} delivery=${envelope.deliveryPolicy} sessionId=${envelope.sessionId}`;
}

export type ControlSequenceContinuityDecision =
	| {
			readonly action: 'accept';
			readonly nextLastSeenSequence: number;
	  }
	| {
			readonly action: 'drop';
			readonly nextLastSeenSequence: number;
			readonly safeMessage: string;
	  }
	| {
			readonly action: 'stale';
			readonly closeReason: Extract<ControlSessionCloseReason, 'sequence_gap'>;
			readonly nextLastSeenSequence: number;
			readonly safeMessage: string;
	  };

export function evaluateControlSequenceContinuity(
	props: ControlSequenceContinuityProps,
): ControlSequenceContinuityDecision {
	const advisorySequenceMode = props.advisorySequenceMode ?? 'lossy';
	if (props.envelope.sequence <= props.lastSeenSequence) {
		return {
			action: 'drop',
			nextLastSeenSequence: props.lastSeenSequence,
			safeMessage: `control sequence did not advance: last=${String(props.lastSeenSequence)} received=${String(props.envelope.sequence)}${controlSequenceDiagnosticSuffix(props.envelope)}`,
		};
	}
	if (
		advisorySequenceMode === 'lossy' &&
		(props.envelope.deliveryPolicy === 'droppable' ||
			props.envelope.deliveryPolicy === 'latest_wins')
	) {
		return {
			action: 'accept',
			nextLastSeenSequence: props.lastSeenSequence,
		};
	}
	const expectedSequence = props.lastSeenSequence + 1;
	if (props.envelope.sequence === expectedSequence) {
		return {
			action: 'accept',
			nextLastSeenSequence: props.envelope.sequence,
		};
	}
	return {
		action: 'stale',
		closeReason: 'sequence_gap',
		nextLastSeenSequence: props.lastSeenSequence,
		safeMessage: `control sequence gap: expected=${String(expectedSequence)} received=${String(props.envelope.sequence)}${controlSequenceDiagnosticSuffix(props.envelope)}`,
	};
}

export function buildControlProtocolJsonSchemas(): Readonly<Record<string, unknown>> {
	return {
		close: z.toJSONSchema(ControlCloseSchema, { io: 'input' }),
		envelope: z.toJSONSchema(ControlEnvelopeSchema, { io: 'input' }),
		handshakeCredential: z.toJSONSchema(ControlHandshakeCredentialSchema, { io: 'input' }),
		handshakeProof: z.toJSONSchema(ControlHandshakeProofSchema, { io: 'input' }),
		readyRequestCredential: z.toJSONSchema(ControlReadyRequestCredentialSchema, {
			io: 'input',
		}),
		readyRequestProof: z.toJSONSchema(ControlReadyRequestProofSchema, { io: 'input' }),
	};
}
