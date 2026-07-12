import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type {
	ControlEnvelope,
	ControlHandshakeCredential,
	DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import type { GatewayControlRpcMessage } from '@agent-vm/gateway-control-contracts';

export class GatewayControlSessionUnavailableError extends Error {
	readonly code = 'gateway_control_not_connected';

	constructor() {
		super('gateway control session is not connected');
		this.name = 'GatewayControlSessionUnavailableError';
	}
}

export class GatewayControlSessionWaiterOverflowError extends Error {
	readonly code = 'gateway_control_session_waiter_overflow';

	constructor(readonly limit: number) {
		super(`gateway control accepted-session waiter limit reached: ${String(limit)}`);
		this.name = 'GatewayControlSessionWaiterOverflowError';
	}
}

export type GatewayControlNonceState = 'issued' | 'consuming' | 'accepted' | 'failed' | 'expired';
export type GatewayControlReadyRejectionReason =
	| 'expired_ready_request'
	| 'future_ready_request'
	| 'identity_mismatch'
	| 'invalid_ready_proof'
	| 'replayed_ready_request'
	| 'signature_mismatch';

export interface GatewayControlIdentity {
	readonly bootId: string;
	readonly callerContextAgentAuthorityKeys: Readonly<Record<string, string>>;
	readonly callerContextProofKey: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly processEpoch: string;
	readonly zoneId: string;
}

export interface GatewayControlPublicIdentity {
	readonly bootId: string;
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly zoneId: string;
}

export interface GatewayControlServiceOptions {
	readonly applicationMessageHandler?: GatewayControlApplicationMessageHandler;
	readonly handleEngineUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
	readonly identity: GatewayControlIdentity;
	readonly nonceTtlMs?: number;
	readonly now?: () => number;
	readonly verifierPublicKeyPem: string;
}

export interface GatewayControlApplicationMessageHandler {
	buildHandlerFailureResult?(
		context: GatewayControlApplicationMessageContext,
		error: unknown,
	): unknown;
	handle(context: GatewayControlApplicationMessageContext): Promise<unknown>;
	messageIdentity(context: GatewayControlApplicationMessageContext): DomainControlMessageIdentity;
}

export interface GatewayControlApplicationMessageContext {
	readonly envelope: ControlEnvelope;
	readonly payload: unknown;
}

export type GatewayControlIssuedCredential = GatewayControlPublicIdentity &
	ControlHandshakeCredential;

export interface GatewayControlAcceptedSession extends GatewayControlPublicIdentity {
	readonly attachmentGeneration: number;
	readonly connectionId: string;
	readonly gatewayEpoch: string;
	readonly processEpoch: string;
	readonly sessionId: string;
}

export interface StoredGatewayControlCredential {
	readonly credential: GatewayControlIssuedCredential;
	terminalAtMs?: number | undefined;
	state: GatewayControlNonceState;
}

export interface FailedUpgradeAttemptWindow {
	count: number;
	readonly windowStartedAtMs: number;
}

export interface ConsumedReadyRequest {
	readonly consumedAtMs: number;
}

export interface PendingGatewayControlCommandResult {
	readonly connectionId: string;
	readonly operation: string;
	readonly promise: Promise<unknown>;
	readonly reject: (error: Error) => void;
	readonly resolve: (payload: unknown) => void;
	readonly sessionId: string;
	timeout: ReturnType<typeof setTimeout>;
}

export interface GatewayControlEmitApplicationMessageOptions {
	readonly admissionPrincipal?: string;
	readonly commandResultTimeoutMs?: number;
	readonly waitForReceipt?: boolean;
}

export interface GatewayControlApplicationMessageIntent {
	readonly buildEnvelope: (options: {
		readonly acceptedSession: GatewayControlAcceptedSession;
		readonly sequence: number;
	}) => ControlEnvelope;
	readonly domainMessage: DomainControlMessageIdentity;
	readonly payload: GatewayControlRpcMessage;
}

export type ReadyProofConsumptionResult =
	| { readonly accepted: true }
	| {
			readonly accepted: false;
			readonly reason: GatewayControlReadyRejectionReason;
	  };

export interface GatewayControlService {
	readonly handleReadyRequest: (req: IncomingMessage, res: ServerResponse) => boolean;
	readonly handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	readonly getCredentialState: (credentialId: string) => GatewayControlNonceState | undefined;
	readonly emitApplicationMessage: (
		intent: GatewayControlApplicationMessageIntent,
		options?: GatewayControlEmitApplicationMessageOptions,
	) => Promise<unknown>;
	readonly getCurrentAcceptedSession: () => GatewayControlAcceptedSession | undefined;
	readonly waitForAcceptedSession: () => Promise<GatewayControlAcceptedSession>;
	readonly close: () => Promise<void>;
}
