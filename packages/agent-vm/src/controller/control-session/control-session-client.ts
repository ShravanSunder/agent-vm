import {
	CONTROL_QUEUE_LIMITS,
	CONTROL_SESSION_TIMING_MS,
	ControlEnvelopeSchema,
	assertControlEnvelopeMatchesDomainMessage,
	assertDerivedControlDeliveryPolicy,
	type ControlDeliveryPolicy,
	type ControlEnvelope,
	type DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';

export const CONTROL_SESSION_EVENT_NAMES = {
	close: 'control:close',
	hello: 'control:hello',
	message: 'control:message',
} as const;

export const DEFAULT_GATEWAY_CONTROL_PATH = '/__agent-vm/gateway-control';

export interface ControlSessionEndpoint {
	readonly host: string;
	readonly path: string;
	readonly port: number;
}

export interface ControlSessionClient<TControlHelloResponse> {
	readonly ready: Promise<TControlHelloResponse>;
	close(): void;
	emitApplicationMessage(
		envelope: ControlEnvelope,
		domainMessage: DomainControlMessageIdentity,
		payload: unknown,
		options?: ControlSessionEmitApplicationMessageOptions,
	): Promise<unknown>;
	getDiagnostics(): ControlSessionDiagnostics<TControlHelloResponse>;
}

export interface ControlSessionEmitApplicationMessageOptions {
	readonly commandResultTimeoutMs?: number;
}

export interface ControlSessionDiagnostics<TControlHelloResponse> {
	readonly accepted: boolean;
	readonly connected: boolean;
	readonly endpointPath: string;
	readonly helloCount: number;
	readonly lastHelloResponse?: TControlHelloResponse | undefined;
	readonly ready: boolean;
	readonly transportName?: string | undefined;
}

export function assertControlSessionDispatchAllowed(options: {
	readonly assertEnvelopeDeliveryPolicy?: (envelope: ControlEnvelope) => void;
	readonly domainMessage: DomainControlMessageIdentity;
	readonly envelope: ControlEnvelope;
	readonly policyByKind?: Partial<Record<ControlEnvelope['kind'], ControlDeliveryPolicy>>;
	readonly policyByOperation: Readonly<Record<string, ControlDeliveryPolicy>>;
}): void {
	ControlEnvelopeSchema.parse(options.envelope);
	assertControlEnvelopeMatchesDomainMessage(options.envelope, options.domainMessage);
	if (options.assertEnvelopeDeliveryPolicy === undefined) {
		assertDerivedControlDeliveryPolicy({
			envelope: options.envelope,
			policyByOperation: options.policyByOperation,
			...(options.policyByKind === undefined ? {} : { policyByKind: options.policyByKind }),
		});
		return;
	}
	options.assertEnvelopeDeliveryPolicy(options.envelope);
}

export function measureControlSessionMessageBytes(
	envelope: ControlEnvelope,
	payload: unknown,
): number {
	const serializedMessage = JSON.stringify([envelope, payload]);
	if (serializedMessage === undefined) {
		throw new Error('control message payload must be JSON serializable');
	}
	return Buffer.byteLength(serializedMessage, 'utf8');
}

export function assertControlSessionMessageWithinBounds(
	envelope: ControlEnvelope,
	payload: unknown,
): void {
	if (envelope.deliveryPolicy === 'forbidden_bulk') {
		throw new Error('forbidden bulk message cannot be sent on the control session');
	}
	const messageByteLength = measureControlSessionMessageBytes(envelope, payload);
	if (messageByteLength > CONTROL_QUEUE_LIMITS.maxHttpBufferBytes) {
		throw new Error(
			`control message exceeds maxHttpBufferBytes: ${String(messageByteLength)} > ${String(CONTROL_QUEUE_LIMITS.maxHttpBufferBytes)}`,
		);
	}
}

export function computeControlSessionManualReconnectDelayMs(options: {
	readonly attempt: number;
	readonly random?: () => number;
}): number {
	const boundedAttempt = Math.max(0, Math.min(options.attempt, 16));
	const exponentialDelay = Math.min(
		CONTROL_SESSION_TIMING_MS.manualReconnectInitialDelay * 2 ** boundedAttempt,
		CONTROL_SESSION_TIMING_MS.manualReconnectMaxDelay,
	);
	const jitterWindow = Math.floor(
		exponentialDelay * CONTROL_SESSION_TIMING_MS.manualReconnectJitterRatio,
	);
	const normalizedRandomValue = Math.min(1, Math.max(0, options.random?.() ?? Math.random()));
	const jitter = Math.floor(normalizedRandomValue * (jitterWindow * 2 + 1)) - jitterWindow;
	return Math.max(
		0,
		Math.min(CONTROL_SESSION_TIMING_MS.manualReconnectMaxDelay, exponentialDelay + jitter),
	);
}
