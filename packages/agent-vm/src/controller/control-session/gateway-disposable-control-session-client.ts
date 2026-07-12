import { randomUUID } from 'node:crypto';

import {
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SESSION_TIMING_MS,
	ControlEnvelopeSchema,
	assertControlMessageReceiptAccepted,
	buildControlMessageExceptionRejectionReceipt,
	buildControlMessageReceipt,
	evaluateControlSequenceContinuity,
	extractDomainCommandResultResponseToMessageId,
	type ControlDeliveryPolicy,
	type ControlEnvelope,
	type ControlMessageAcknowledge,
	type ControlSessionControllerToPeerEvents,
	type ControlSessionPeerToControllerEvents,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlHelloResponseSchema,
	GatewayControlHelloSchema,
	GatewayControlRpcMessageSchema,
	classifyGatewayControlAdmission,
	createGatewayControlAdmissionExecutor,
	type GatewayControlHello,
	type GatewayControlHelloResponse,
	type GatewayControlAdmissionClassification,
	type GatewayControlAdmissionExecutionRequest,
	type GatewayControlAdmissionExecutor,
	type GatewayControlAdmissionSubmission,
	type GatewayControlLeaseRejectionReason,
	type GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';
import { io, type Socket } from 'socket.io-client';

import {
	CONTROL_SESSION_EVENT_NAMES,
	assertControlSessionDispatchAllowed,
	assertControlSessionMessageWithinBounds,
	computeControlSessionManualReconnectDelayMs,
	measureControlSessionMessageBytes,
	type ControlSessionEndpoint,
	type ControlSessionClient,
} from './control-session-client.js';
import type { ControlSessionDispatcher } from './control-session-dispatcher.js';
import type {
	GatewayControlProcessAdmissionCoordinator,
	GatewayControlProcessSessionRegistration,
} from './gateway-control-process-admission-coordinator.js';

export const GATEWAY_CONTROL_RECONNECT_DEADLINE_MS = 60_000;
export const GATEWAY_CONTROL_RECONNECT_MAX_ATTEMPTS = 16;
export const GATEWAY_CONTROL_RECONNECT_STABILITY_HEARTBEATS = 3;
export const GATEWAY_CONTROL_RECONNECT_STABILITY_MS = 30_000;

interface PendingGatewayCommandResult {
	readonly attempt: GatewayControlAttempt;
	readonly expectedOperation: string;
	readonly promise: Promise<unknown>;
	readonly reject: (error: Error) => void;
	readonly resolve: (payload: unknown) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export interface GatewayDisposableControlSessionIdentity {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly peerId: string;
	readonly processEpoch: string;
	readonly zoneId: string;
}

export interface CreateGatewayDisposableControlSocketOptions {
	readonly endpoint: ControlSessionEndpoint;
	readonly extraHeaders: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
}

export type GatewayDisposableControlSocket = Socket<
	ControlSessionPeerToControllerEvents<unknown>,
	ControlSessionControllerToPeerEvents<unknown, GatewayControlHello, GatewayControlHelloResponse>
>;

export interface GatewayDisposableControlSessionClientOptions {
	readonly commandAckTimeoutMs?: number;
	readonly commandResultTimeoutMsByOperation?: Partial<Record<string, number>>;
	readonly connectTimeoutMs?: number;
	readonly createSocket?: (
		options: CreateGatewayDisposableControlSocketOptions,
	) => GatewayDisposableControlSocket;
	readonly dispatcher?: ControlSessionDispatcher;
	readonly endpoint: ControlSessionEndpoint;
	readonly initialExtraHeaders: Readonly<Record<string, string>>;
	readonly identity: GatewayDisposableControlSessionIdentity;
	readonly nextAttachmentGeneration: () => number;
	readonly now?: () => number;
	readonly onAttemptOutcome?: (outcome: GatewayControlAttemptOutcome) => void;
	readonly onAttachmentGap?: (transition: GatewayControlAttachmentGapTransition) => void;
	readonly onHelloResponse?: (response: GatewayControlHelloResponse) => void;
	readonly onReconnectExhausted?: (transition: GatewayControlReconnectExhaustedTransition) => void;
	readonly policyByKind?: Partial<Record<ControlEnvelope['kind'], ControlDeliveryPolicy>>;
	readonly policyByOperation: Readonly<Record<string, ControlDeliveryPolicy>>;
	readonly processAdmissionCoordinator?: GatewayControlProcessAdmissionCoordinator;
	readonly reconnectJitterRandom?: () => number;
	readonly scheduleReconnectTimer?: (
		callback: () => void,
		delayMs: number,
	) => GatewayControlReconnectTimer;
	readonly resolveInboundStablePrincipal?: (context: {
		readonly envelope: ControlEnvelope;
		readonly message: GatewayControlRpcMessage;
	}) =>
		| string
		| {
				readonly leaseRejectionReason: GatewayControlLeaseRejectionReason;
				readonly status: 'rejected';
		  }
		| undefined;
	readonly refreshExtraHeaders: () => Promise<Readonly<Record<string, string>>>;
	readonly scheduleImmediate?: (callback: () => void) => void;
}

export type GatewayControlAttemptOutcome =
	| {
			readonly attachmentGeneration: number;
			readonly kind: 'connect_error';
	  }
	| {
			readonly attachmentGeneration: number;
			readonly kind: 'hello_response';
			readonly outcome: GatewayControlHelloResponse['outcome'];
	  };

export interface GatewayControlReconnectTimer {
	cancel(): void;
	unref?(): void;
}

export interface GatewayDisposableControlSessionDiagnostics {
	readonly accepted: boolean;
	readonly attachmentGeneration?: number;
	readonly connected: boolean;
	readonly endpointPath: string;
	readonly helloCount: number;
	readonly lastHelloResponse?: GatewayControlHelloResponse;
	readonly ready: boolean;
	readonly reconnectAttempts: number;
	readonly reconnectExhausted: boolean;
	readonly transportName?: string;
}

export interface GatewayControlReconnectExhaustedTransition {
	readonly attempts: number;
	readonly exhaustionReason: 'attempt_limit' | 'deadline';
	readonly gapReason: string;
	readonly gatewayEpoch: string;
	readonly kind: 'reconnect_exhausted';
	readonly processEpoch: string;
	readonly zoneId: string;
}

export interface GatewayControlAttachmentGapTransition {
	readonly attachmentGeneration: number;
	readonly gapReason: string;
	readonly gatewayEpoch: string;
	readonly kind: 'attachment_gap';
	readonly observedAtMs: number;
	readonly processEpoch: string;
	readonly zoneId: string;
}

export interface GatewayDisposableControlSessionClient extends ControlSessionClient<GatewayControlHelloResponse> {
	fenceCurrentSession(options: {
		readonly expectedAttachmentGeneration: number;
		readonly expectedSessionId: string;
		readonly reason: 'reliability_test_disconnect';
	}):
		| { readonly status: 'not-current' }
		| {
				readonly attachmentGeneration: number;
				readonly sessionId: string;
				readonly status: 'fenced';
		  };
	getDiagnostics(): GatewayDisposableControlSessionDiagnostics;
}

interface GatewayControlAttempt {
	accepted: boolean;
	connectionId?: string;
	lastSeenControllerSequence: number;
	lastSeenPeerSequence: number;
	readonly egressAdmission: GatewayControlAdmissionExecutor<unknown>;
	readonly ingressAdmission: GatewayControlAdmissionExecutor<unknown>;
	nextControllerSequence: number;
	readonly attachmentGeneration: number;
	readonly socket: GatewayDisposableControlSocket;
	sessionId?: string;
}

interface GatewayControlStabilizingAttempt {
	acceptedAtMs: number;
	heartbeatCount: number;
	readonly attempt: GatewayControlAttempt;
}

export function createGatewayDisposableControlSocket(
	options: CreateGatewayDisposableControlSocketOptions,
): GatewayDisposableControlSocket {
	return io(`http://${options.endpoint.host}:${String(options.endpoint.port)}`, {
		addTrailingSlash: false,
		autoConnect: false,
		extraHeaders: { ...options.extraHeaders },
		forceNew: true,
		path: options.endpoint.path,
		reconnection: false,
		timeout: options.timeoutMs,
		transports: ['websocket'],
	});
}

function buildGatewayControlHello(
	identity: GatewayDisposableControlSessionIdentity,
	attachmentGeneration: number,
): GatewayControlHello {
	return GatewayControlHelloSchema.parse({
		attachmentGeneration,
		controllerEpoch: identity.controllerEpoch,
		domain: 'gateway_control',
		gatewayEpoch: identity.gatewayEpoch,
		peerId: identity.peerId,
		processEpoch: identity.processEpoch,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
	});
}

function buildGatewayResponseEnvelope(options: {
	readonly requestEnvelope: ControlEnvelope;
	readonly sequence: number;
}): ControlEnvelope {
	return ControlEnvelopeSchema.parse({
		...options.requestEnvelope,
		createdAtMs: Date.now(),
		kind: 'command_result',
		messageId: randomUUID(),
		sequence: options.sequence,
	});
}

function commandResultPromise(options: {
	readonly attempt: GatewayControlAttempt;
	readonly expectedOperation: string;
	readonly messageId: string;
	readonly pendingResults: Map<string, PendingGatewayCommandResult>;
	readonly timeoutMs: number;
}): Promise<unknown> {
	const existingPendingResult = options.pendingResults.get(options.messageId);
	if (existingPendingResult !== undefined) {
		if (
			existingPendingResult.attempt !== options.attempt ||
			existingPendingResult.expectedOperation !== options.expectedOperation
		) {
			throw new Error('gateway control pending result identity collision');
		}
		clearTimeout(existingPendingResult.timeout);
		existingPendingResult.timeout = setTimeout(() => {
			if (options.pendingResults.get(options.messageId) === existingPendingResult) {
				options.pendingResults.delete(options.messageId);
			}
			existingPendingResult.reject(
				new Error(`gateway control command result timed out: ${options.messageId}`),
			);
		}, options.timeoutMs);
		existingPendingResult.timeout.unref?.();
		return existingPendingResult.promise;
	}
	let resolvePromise!: (payload: unknown) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<unknown>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	const pendingResult: PendingGatewayCommandResult = {
		attempt: options.attempt,
		expectedOperation: options.expectedOperation,
		promise,
		reject: rejectPromise,
		resolve: resolvePromise,
		timeout: setTimeout(() => {
			if (options.pendingResults.get(options.messageId) === pendingResult) {
				options.pendingResults.delete(options.messageId);
			}
			rejectPromise(new Error(`gateway control command result timed out: ${options.messageId}`));
		}, options.timeoutMs),
	};
	pendingResult.timeout.unref?.();
	options.pendingResults.set(options.messageId, pendingResult);
	return promise;
}

function buildCurrentAttemptOutboundEnvelope(options: {
	readonly attempt: GatewayControlAttempt;
	readonly identity: GatewayDisposableControlSessionIdentity;
	readonly intent: ControlEnvelope;
	readonly nowMs: number;
}): ControlEnvelope {
	return ControlEnvelopeSchema.parse({
		...options.intent,
		bootId: options.identity.processEpoch,
		connectionId: options.attempt.connectionId,
		controllerEpoch: options.identity.controllerEpoch,
		createdAtMs: options.nowMs,
		domain: 'gateway_control',
		peerId: options.identity.peerId,
		sequence: options.attempt.nextControllerSequence,
		sessionId: options.attempt.sessionId,
		zoneId: options.identity.zoneId,
	});
}

function admissionFailureMessage(
	classification: Exclude<GatewayControlAdmissionClassification, { readonly status: 'classified' }>,
): string {
	return `gateway control admission ${classification.status}: ${classification.reason}`;
}

function buildGatewayAdmissionFailureResponse(options: {
	readonly admissionStatus: 'dropped' | 'refused' | 'shed' | 'superseded';
	readonly message: Extract<GatewayControlRpcMessage, { readonly kind: 'command' }>;
	readonly responseToMessageId: string;
}): GatewayControlRpcMessage {
	return GatewayControlRpcMessageSchema.parse({
		kind: 'command_result',
		operation: options.message.operation,
		payload: {
			error: {
				errorClass: `gateway_control_admission_${options.admissionStatus}`,
				retryable: true,
				safeMessage: `Gateway control command was ${options.admissionStatus} before execution.`,
			},
			responseToMessageId: options.responseToMessageId,
			result: 'failed',
		},
	});
}

function buildGatewayCallerContextRejectionResponse(options: {
	readonly leaseRejectionReason: GatewayControlLeaseRejectionReason;
	readonly message: Extract<GatewayControlRpcMessage, { readonly kind: 'command' }>;
	readonly responseToMessageId: string;
}): GatewayControlRpcMessage {
	return GatewayControlRpcMessageSchema.parse({
		kind: 'command_result',
		operation: options.message.operation,
		payload: {
			leaseRejectionReason: options.leaseRejectionReason,
			responseToMessageId: options.responseToMessageId,
			result: 'rejected',
		},
	});
}

export function createGatewayDisposableControlSessionClient(
	options: GatewayDisposableControlSessionClientOptions,
): GatewayDisposableControlSessionClient {
	const commandAckTimeoutMs =
		options.commandAckTimeoutMs ?? CONTROL_SESSION_TIMING_MS.commandAckTimeout;
	const connectTimeoutMs = options.connectTimeoutMs ?? CONTROL_SESSION_TIMING_MS.connectTimeout;
	const now = options.now ?? (() => Date.now());
	const createSocket = options.createSocket ?? createGatewayDisposableControlSocket;
	const scheduleImmediate =
		options.scheduleImmediate ?? ((callback: () => void) => setImmediate(callback));
	const scheduleReconnectTimer =
		options.scheduleReconnectTimer ??
		((callback: () => void, delayMs: number): GatewayControlReconnectTimer => {
			const timeout = setTimeout(callback, delayMs);
			return {
				cancel: () => clearTimeout(timeout),
				unref: () => timeout.unref?.(),
			};
		});
	const pendingResults = new Map<string, PendingGatewayCommandResult>();
	let processAdmissionRegistration: GatewayControlProcessSessionRegistration | undefined;
	let reservedInitialAttachmentGeneration: number | undefined = options.nextAttachmentGeneration();
	let currentAttempt: GatewayControlAttempt | undefined;
	let closed = false;
	let hasAcceptedSession = false;
	let helloCount = 0;
	let lastHelloResponse: GatewayControlHelloResponse | undefined;
	let reconnectAttempts = 0;
	let reconnectEpisodeGeneration = 0;
	let reconnectGapStartedAtMs: number | undefined = now();
	let reconnectGapReason = 'initial connection';
	let reconnectExhausted = false;
	let reconnectTimer: GatewayControlReconnectTimer | undefined;
	let pendingAttemptStartIdentity:
		| {
				readonly attemptNumber: number;
				readonly reconnectEpisodeGeneration: number;
		  }
		| undefined;
	let stabilizationDeadlineTimer: GatewayControlReconnectTimer | undefined;
	let stabilizingAttempt: GatewayControlStabilizingAttempt | undefined;
	let initialHeaders = options.initialExtraHeaders;
	let resolveReady!: (response: GatewayControlHelloResponse) => void;
	let rejectReady!: (error: Error) => void;
	let readySettled = false;
	const ready = new Promise<GatewayControlHelloResponse>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	function rejectPendingResults(error: Error): void {
		for (const [messageId, pendingResult] of pendingResults) {
			clearTimeout(pendingResult.timeout);
			pendingResults.delete(messageId);
			pendingResult.reject(error);
		}
	}

	function notifyAttemptOutcome(outcome: GatewayControlAttemptOutcome): void {
		try {
			options.onAttemptOutcome?.(outcome);
		} catch {
			// Diagnostics cannot affect control-session ownership or reconnect behavior.
		}
	}

	function submitAttemptAdmission(optionsForAdmission: {
		readonly localExecutor: GatewayControlAdmissionExecutor<unknown>;
		readonly request: GatewayControlAdmissionExecutionRequest<unknown>;
	}): GatewayControlAdmissionSubmission {
		if (options.processAdmissionCoordinator === undefined) {
			return optionsForAdmission.localExecutor.submit(optionsForAdmission.request);
		}
		if (processAdmissionRegistration === undefined) {
			const closedAdmission = {
				reason: 'gateway control process session is not registered',
				status: 'closed',
			} as const;
			return {
				admission: closedAdmission,
				completion: Promise.resolve(closedAdmission),
			};
		}
		return options.processAdmissionCoordinator.submit({
			localExecutor: optionsForAdmission.localExecutor,
			registration: processAdmissionRegistration,
			request: optionsForAdmission.request,
		});
	}

	function destroyAttempt(attempt: GatewayControlAttempt, reason: string): void {
		if (currentAttempt === attempt) {
			currentAttempt = undefined;
		}
		attempt.accepted = false;
		attempt.socket.sendBuffer.splice(0, attempt.socket.sendBuffer.length);
		attempt.socket.removeAllListeners();
		attempt.socket.io.removeAllListeners();
		attempt.socket.disconnect();
		attempt.ingressAdmission.close(reason);
		attempt.egressAdmission.close(reason);
		rejectPendingResults(new Error(reason));
	}

	function reconnectExhaustionReason():
		| GatewayControlReconnectExhaustedTransition['exhaustionReason']
		| undefined {
		const gapStartedAtMs = reconnectGapStartedAtMs;
		if (closed || gapStartedAtMs === undefined) {
			return undefined;
		}
		if (reconnectAttempts >= GATEWAY_CONTROL_RECONNECT_MAX_ATTEMPTS) {
			return 'attempt_limit';
		}
		return now() - gapStartedAtMs >= GATEWAY_CONTROL_RECONNECT_DEADLINE_MS ? 'deadline' : undefined;
	}

	function reconnectBudgetAvailable(): boolean {
		return (
			!closed && reconnectGapStartedAtMs !== undefined && reconnectExhaustionReason() === undefined
		);
	}

	function cancelStabilizationDeadline(): void {
		stabilizationDeadlineTimer?.cancel();
		stabilizationDeadlineTimer = undefined;
	}

	function resetReconnectRecoveryEpisode(): void {
		cancelStabilizationDeadline();
		reconnectEpisodeGeneration += 1;
		reconnectAttempts = 0;
		reconnectExhausted = false;
		reconnectGapStartedAtMs = undefined;
		reconnectGapReason = '';
		stabilizingAttempt = undefined;
	}

	function recordStabilizingHeartbeat(attempt: GatewayControlAttempt): void {
		const stabilization = stabilizingAttempt;
		if (stabilization === undefined || stabilization.attempt !== attempt) {
			return;
		}
		stabilization.heartbeatCount += 1;
		if (
			stabilization.heartbeatCount >= GATEWAY_CONTROL_RECONNECT_STABILITY_HEARTBEATS &&
			now() - stabilization.acceptedAtMs >= GATEWAY_CONTROL_RECONNECT_STABILITY_MS
		) {
			resetReconnectRecoveryEpisode();
		}
	}

	function beginReconnectStabilization(attempt: GatewayControlAttempt): void {
		cancelStabilizationDeadline();
		stabilizingAttempt = {
			acceptedAtMs: now(),
			attempt,
			heartbeatCount: 0,
		};
		const gapStartedAtMs = reconnectGapStartedAtMs;
		if (gapStartedAtMs === undefined) {
			return;
		}
		const remainingDeadlineMs = Math.max(
			0,
			GATEWAY_CONTROL_RECONNECT_DEADLINE_MS - (now() - gapStartedAtMs),
		);
		stabilizationDeadlineTimer = scheduleReconnectTimer(() => {
			stabilizationDeadlineTimer = undefined;
			if (
				currentAttempt === attempt &&
				attempt.accepted &&
				stabilizingAttempt?.attempt === attempt &&
				reconnectGapStartedAtMs !== undefined
			) {
				notifyReconnectExhausted('deadline');
			}
		}, remainingDeadlineMs);
		stabilizationDeadlineTimer.unref?.();
	}

	function notifyReconnectExhausted(
		exhaustionReason: GatewayControlReconnectExhaustedTransition['exhaustionReason'],
	): void {
		if (reconnectExhausted) {
			return;
		}
		if (reconnectGapStartedAtMs === undefined) {
			return;
		}
		reconnectExhausted = true;
		const transition = {
			attempts: reconnectAttempts,
			exhaustionReason,
			gapReason: reconnectGapReason,
			gatewayEpoch: options.identity.gatewayEpoch,
			kind: 'reconnect_exhausted',
			processEpoch: options.identity.processEpoch,
			zoneId: options.identity.zoneId,
		} satisfies GatewayControlReconnectExhaustedTransition;
		try {
			options.onReconnectExhausted?.(transition);
		} catch {
			// The observer cannot prevent the control owner from committing exhaustion.
		}
	}

	function scheduleReconnect(): void {
		if (
			reconnectTimer !== undefined ||
			currentAttempt !== undefined ||
			!reconnectBudgetAvailable()
		) {
			const exhaustionReason = reconnectExhaustionReason();
			if (exhaustionReason !== undefined) {
				notifyReconnectExhausted(exhaustionReason);
				if (!readySettled) {
					readySettled = true;
					rejectReady(new Error('gateway control reconnect budget exhausted'));
				}
			}
			return;
		}
		const delayMs =
			reconnectAttempts === 0
				? 0
				: computeControlSessionManualReconnectDelayMs({
						attempt: reconnectAttempts - 1,
						...(options.reconnectJitterRandom === undefined
							? {}
							: { random: options.reconnectJitterRandom }),
					});
		reconnectTimer = scheduleReconnectTimer(() => {
			reconnectTimer = undefined;
			void startAttempt();
		}, delayMs);
		reconnectTimer.unref?.();
	}

	function fenceAttempt(attempt: GatewayControlAttempt, reason: string): void {
		if (currentAttempt !== attempt) {
			return;
		}
		const acceptedAttachmentGeneration = attempt.accepted
			? attempt.attachmentGeneration
			: undefined;
		if (stabilizingAttempt?.attempt === attempt) {
			cancelStabilizationDeadline();
			stabilizingAttempt = undefined;
		}
		destroyAttempt(attempt, reason);
		if (acceptedAttachmentGeneration !== undefined) {
			const transition = {
				attachmentGeneration: acceptedAttachmentGeneration,
				gapReason: reason,
				gatewayEpoch: options.identity.gatewayEpoch,
				kind: 'attachment_gap',
				observedAtMs: now(),
				processEpoch: options.identity.processEpoch,
				zoneId: options.identity.zoneId,
			} satisfies GatewayControlAttachmentGapTransition;
			try {
				options.onAttachmentGap?.(transition);
			} catch {
				// The observer cannot prevent the control owner from fencing the attachment.
			}
		}
		if (reconnectGapStartedAtMs === undefined) {
			reconnectEpisodeGeneration += 1;
			reconnectGapStartedAtMs = now();
			reconnectGapReason = reason;
		}
		scheduleReconnect();
	}

	function assertEnvelopeMatchesAttempt(
		attempt: GatewayControlAttempt,
		envelope: ControlEnvelope,
	): void {
		if (
			currentAttempt !== attempt ||
			!attempt.accepted ||
			envelope.bootId !== options.identity.processEpoch ||
			envelope.connectionId !== attempt.connectionId ||
			envelope.controllerEpoch !== options.identity.controllerEpoch ||
			envelope.domain !== 'gateway_control' ||
			envelope.peerId !== options.identity.peerId ||
			envelope.sessionId !== attempt.sessionId ||
			envelope.zoneId !== options.identity.zoneId
		) {
			throw new Error('gateway control message did not match the current attachment');
		}
	}

	async function sendGatewayCommandResponse(optionsForResponse: {
		readonly attempt: GatewayControlAttempt;
		readonly requestEnvelope: ControlEnvelope;
		readonly responsePayload: unknown;
	}): Promise<void> {
		const attempt = optionsForResponse.attempt;
		if (currentAttempt !== attempt || !attempt.accepted) {
			return;
		}
		const responseMessage = GatewayControlRpcMessageSchema.parse(
			optionsForResponse.responsePayload,
		);
		if (responseMessage.kind !== 'command_result') {
			throw new Error('gateway control command response must be a command_result');
		}
		const responseClassification = classifyGatewayControlAdmission({
			direction: 'controller_to_gateway',
			matchedPendingResult: responseMessage.kind === 'command_result',
			message: responseMessage,
		});
		if (responseClassification.status !== 'classified') {
			throw new Error(admissionFailureMessage(responseClassification));
		}
		const responseSubmission = submitAttemptAdmission({
			localExecutor: attempt.egressAdmission,
			request: {
				byteLength: measureControlSessionMessageBytes(
					buildGatewayResponseEnvelope({
						requestEnvelope: optionsForResponse.requestEnvelope,
						sequence: 1,
					}),
					responseMessage,
				),
				execute: async () => {
					if (currentAttempt !== attempt || !attempt.accepted) {
						return;
					}
					const responseEnvelope = buildGatewayResponseEnvelope({
						requestEnvelope: optionsForResponse.requestEnvelope,
						sequence: attempt.nextControllerSequence,
					});
					attempt.nextControllerSequence += 1;
					const receipt: unknown = await attempt.socket
						.timeout(commandAckTimeoutMs)
						.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, responseEnvelope, responseMessage);
					assertControlMessageReceiptAccepted(receipt);
					attempt.lastSeenControllerSequence = responseEnvelope.sequence;
				},
				id: responseMessage.payload.responseToMessageId,
				messageClass: responseClassification.messageClass,
				payload: responseMessage,
			},
		});
		if (
			responseSubmission.admission.status !== 'admitted' &&
			responseSubmission.admission.status !== 'replaced'
		) {
			throw new Error(`gateway control response admission ${responseSubmission.admission.status}`);
		}
		await responseSubmission.completion;
	}

	function bindAttemptHandlers(attempt: GatewayControlAttempt): void {
		attempt.socket.once('connect', () => {
			void attempt.socket
				.timeout(connectTimeoutMs)
				.emitWithAck(
					CONTROL_SESSION_EVENT_NAMES.hello,
					buildGatewayControlHello(options.identity, attempt.attachmentGeneration),
				)
				.then((payload: unknown) => {
					if (currentAttempt !== attempt) {
						return;
					}
					const response = GatewayControlHelloResponseSchema.parse(payload);
					notifyAttemptOutcome({
						attachmentGeneration: attempt.attachmentGeneration,
						kind: 'hello_response',
						outcome: response.outcome,
					});
					helloCount += 1;
					lastHelloResponse = response;
					if (response.controllerEpoch !== options.identity.controllerEpoch) {
						fenceAttempt(attempt, 'gateway control hello controller epoch mismatch');
						return;
					}
					if (
						response.outcome !== 'accepted' ||
						response.attachmentGeneration !== attempt.attachmentGeneration
					) {
						fenceAttempt(attempt, `gateway control hello rejected: ${response.outcome}`);
						return;
					}
					options.onHelloResponse?.(response);
					attempt.accepted = true;
					attempt.connectionId = response.connectionId;
					attempt.sessionId = response.sessionId;
					if (hasAcceptedSession && reconnectGapStartedAtMs !== undefined) {
						beginReconnectStabilization(attempt);
					} else {
						hasAcceptedSession = true;
						resetReconnectRecoveryEpisode();
					}
					if (!readySettled) {
						readySettled = true;
						resolveReady(response);
					}
				})
				.catch((error: unknown) => {
					fenceAttempt(
						attempt,
						error instanceof Error ? error.message : 'gateway control hello failed',
					);
				});
		});
		attempt.socket.once('connect_error', (error: Error) => {
			notifyAttemptOutcome({
				attachmentGeneration: attempt.attachmentGeneration,
				kind: 'connect_error',
			});
			fenceAttempt(attempt, `gateway control connect failed: ${error.message}`);
		});
		attempt.socket.once('disconnect', () => {
			fenceAttempt(attempt, 'gateway control attachment disconnected');
		});
		attempt.socket.on(
			CONTROL_SESSION_EVENT_NAMES.message,
			(envelopePayload: unknown, payload: unknown, acknowledge?: ControlMessageAcknowledge) => {
				try {
					const envelope = ControlEnvelopeSchema.parse(envelopePayload);
					const message = GatewayControlRpcMessageSchema.parse(payload);
					assertControlSessionMessageWithinBounds(envelope, message);
					assertEnvelopeMatchesAttempt(attempt, envelope);
					if (typeof acknowledge !== 'function') {
						fenceAttempt(attempt, 'gateway control message omitted acknowledgement callback');
						return;
					}
					const sequenceDecision = evaluateControlSequenceContinuity({
						advisorySequenceMode: 'contiguous',
						envelope,
						lastSeenSequence: attempt.lastSeenPeerSequence,
					});
					if (sequenceDecision.action === 'drop') {
						acknowledge?.(buildControlMessageReceipt());
						return;
					}
					if (sequenceDecision.action === 'stale') {
						fenceAttempt(attempt, sequenceDecision.safeMessage);
						return;
					}
					const responseToMessageId = extractDomainCommandResultResponseToMessageId(message);
					const pendingResult =
						responseToMessageId === undefined ? undefined : pendingResults.get(responseToMessageId);
					const matchedPendingResult =
						message.kind === 'command_result' &&
						pendingResult !== undefined &&
						pendingResult.attempt === attempt &&
						pendingResult.expectedOperation === message.operation;
					const inboundPrincipalResolution = options.resolveInboundStablePrincipal?.({
						envelope,
						message,
					});
					if (
						typeof inboundPrincipalResolution === 'object' &&
						inboundPrincipalResolution.status === 'rejected'
					) {
						attempt.lastSeenPeerSequence = sequenceDecision.nextLastSeenSequence;
						acknowledge(buildControlMessageReceipt());
						if (message.kind === 'command') {
							void sendGatewayCommandResponse({
								attempt,
								requestEnvelope: envelope,
								responsePayload: buildGatewayCallerContextRejectionResponse({
									leaseRejectionReason: inboundPrincipalResolution.leaseRejectionReason,
									message,
									responseToMessageId: envelope.messageId,
								}),
							}).catch((error: unknown) => {
								fenceAttempt(
									attempt,
									error instanceof Error
										? error.message
										: 'gateway caller-context rejection failed',
								);
							});
						}
						return;
					}
					const stablePrincipal =
						typeof inboundPrincipalResolution === 'string' ? inboundPrincipalResolution : undefined;
					const classification = classifyGatewayControlAdmission({
						direction: 'gateway_to_controller',
						matchedPendingResult,
						message,
						...(stablePrincipal === undefined ? {} : { stablePrincipal }),
					});
					if (classification.status === 'fence') {
						fenceAttempt(attempt, admissionFailureMessage(classification));
						return;
					}
					attempt.lastSeenPeerSequence = sequenceDecision.nextLastSeenSequence;
					if (message.kind === 'heartbeat') {
						recordStabilizingHeartbeat(attempt);
					}
					if (classification.status === 'refused') {
						acknowledge?.(buildControlMessageReceipt());
						if (message.kind === 'command') {
							void sendGatewayCommandResponse({
								attempt,
								requestEnvelope: envelope,
								responsePayload: buildGatewayAdmissionFailureResponse({
									admissionStatus: 'refused',
									message,
									responseToMessageId: envelope.messageId,
								}),
							}).catch((error: unknown) => {
								fenceAttempt(
									attempt,
									error instanceof Error ? error.message : 'gateway control refusal failed',
								);
							});
						}
						return;
					}
					const submission = submitAttemptAdmission({
						localExecutor: attempt.ingressAdmission,
						request: {
							byteLength: measureControlSessionMessageBytes(envelope, message),
							...(classification.coalesceKey === undefined
								? {}
								: { coalesceKey: classification.coalesceKey }),
							execute: async () => {
								if (currentAttempt !== attempt || !attempt.accepted) {
									return;
								}
								if (
									matchedPendingResult &&
									pendingResult !== undefined &&
									responseToMessageId !== undefined
								) {
									clearTimeout(pendingResult.timeout);
									pendingResults.delete(responseToMessageId);
									pendingResult.resolve(message);
									return;
								}
								if (options.dispatcher === undefined) {
									throw new Error('no gateway control dispatcher configured');
								}
								options.dispatcher.validate({
									attachmentGeneration: attempt.attachmentGeneration,
									envelope,
									payload: message,
								});
								const responsePayload = await options.dispatcher.dispatch({
									attachmentGeneration: attempt.attachmentGeneration,
									envelope,
									payload: message,
								});
								if (
									responsePayload === undefined ||
									currentAttempt !== attempt ||
									!attempt.accepted
								) {
									return;
								}
								await sendGatewayCommandResponse({
									attempt,
									requestEnvelope: envelope,
									responsePayload,
								});
							},
							id: envelope.messageId,
							messageClass: classification.messageClass,
							payload: message,
							...(classification.stablePrincipal === undefined
								? {}
								: { stablePrincipal: classification.stablePrincipal }),
							...(message.kind !== 'command'
								? {}
								: {
										onCancel: (reason: string) => {
											if (reason !== 'replaced' || currentAttempt !== attempt) {
												return;
											}
											void sendGatewayCommandResponse({
												attempt,
												requestEnvelope: envelope,
												responsePayload: buildGatewayAdmissionFailureResponse({
													admissionStatus: 'superseded',
													message,
													responseToMessageId: envelope.messageId,
												}),
											}).catch((error: unknown) => {
												fenceAttempt(
													attempt,
													error instanceof Error
														? error.message
														: 'gateway control supersession result failed',
												);
											});
										},
									}),
						},
					});
					switch (submission.admission.status) {
						case 'admitted':
						case 'replaced':
							acknowledge?.(buildControlMessageReceipt());
							void submission.completion.catch((error: unknown) => {
								fenceAttempt(
									attempt,
									error instanceof Error ? error.message : 'gateway control ingress failed',
								);
							});
							return;
						case 'fence':
						case 'closed':
							fenceAttempt(
								attempt,
								`gateway control ingress admission ${submission.admission.status}`,
							);
							return;
						case 'dropped':
						case 'refused':
						case 'shed':
							acknowledge?.(buildControlMessageReceipt());
							if (message.kind === 'command') {
								void sendGatewayCommandResponse({
									attempt,
									requestEnvelope: envelope,
									responsePayload: buildGatewayAdmissionFailureResponse({
										admissionStatus: submission.admission.status,
										message,
										responseToMessageId: envelope.messageId,
									}),
								}).catch((error: unknown) => {
									fenceAttempt(
										attempt,
										error instanceof Error
											? error.message
											: 'gateway control admission result failed',
									);
								});
							}
					}
				} catch (error: unknown) {
					acknowledge?.(
						buildControlMessageExceptionRejectionReceipt({
							error,
							processingErrorClass: 'gateway_control_message_processing_failed',
							safeMessage: 'gateway control message was rejected',
						}),
					);
					fenceAttempt(
						attempt,
						error instanceof Error ? error.message : 'gateway control message processing failed',
					);
				}
			},
		);
	}

	async function startAttempt(): Promise<void> {
		reconnectGapStartedAtMs ??= now();
		if (
			!reconnectBudgetAvailable() ||
			currentAttempt !== undefined ||
			pendingAttemptStartIdentity !== undefined
		) {
			scheduleReconnect();
			return;
		}
		const attemptNumber = reconnectAttempts;
		const attemptStartIdentity = {
			attemptNumber,
			reconnectEpisodeGeneration,
		} as const;
		pendingAttemptStartIdentity = attemptStartIdentity;
		reconnectAttempts += 1;
		let extraHeaders: Readonly<Record<string, string>>;
		try {
			extraHeaders = attemptNumber === 0 ? initialHeaders : await options.refreshExtraHeaders();
		} catch {
			if (pendingAttemptStartIdentity !== attemptStartIdentity) {
				return;
			}
			pendingAttemptStartIdentity = undefined;
			if (
				closed ||
				reconnectEpisodeGeneration !== attemptStartIdentity.reconnectEpisodeGeneration
			) {
				return;
			}
			scheduleReconnect();
			return;
		}
		if (pendingAttemptStartIdentity !== attemptStartIdentity) {
			return;
		}
		pendingAttemptStartIdentity = undefined;
		if (
			closed ||
			reconnectEpisodeGeneration !== attemptStartIdentity.reconnectEpisodeGeneration ||
			currentAttempt !== undefined
		) {
			scheduleReconnect();
			return;
		}
		initialHeaders = {};
		const attachmentGeneration =
			reservedInitialAttachmentGeneration ?? options.nextAttachmentGeneration();
		reservedInitialAttachmentGeneration = undefined;
		const attempt: GatewayControlAttempt = {
			accepted: false,
			attachmentGeneration,
			egressAdmission: createGatewayControlAdmissionExecutor({ scheduleImmediate }),
			ingressAdmission: createGatewayControlAdmissionExecutor({ scheduleImmediate }),
			lastSeenControllerSequence: 0,
			lastSeenPeerSequence: 0,
			nextControllerSequence: 1,
			socket: createSocket({
				endpoint: options.endpoint,
				extraHeaders,
				timeoutMs: connectTimeoutMs,
			}),
		};
		currentAttempt = attempt;
		bindAttemptHandlers(attempt);
		attempt.socket.connect();
	}

	function closeClient(reason: string): void {
		if (closed) {
			return;
		}
		closed = true;
		pendingAttemptStartIdentity = undefined;
		cancelStabilizationDeadline();
		if (reconnectTimer !== undefined) {
			reconnectTimer.cancel();
			reconnectTimer = undefined;
		}
		if (currentAttempt !== undefined) {
			destroyAttempt(currentAttempt, reason);
		}
		if (
			options.processAdmissionCoordinator !== undefined &&
			processAdmissionRegistration !== undefined
		) {
			options.processAdmissionCoordinator.unregisterSession(processAdmissionRegistration, reason);
			processAdmissionRegistration = undefined;
		}
	}

	if (options.processAdmissionCoordinator !== undefined) {
		const initialAttachmentGeneration = reservedInitialAttachmentGeneration;
		if (initialAttachmentGeneration === undefined) {
			throw new Error('gateway control initial attachment generation was not reserved');
		}
		const registration = options.processAdmissionCoordinator.registerSession(
			{
				attachmentGeneration: initialAttachmentGeneration,
				controllerEpoch: options.identity.controllerEpoch,
				gatewayEpoch: options.identity.gatewayEpoch,
				processEpoch: options.identity.processEpoch,
				zoneId: options.identity.zoneId,
			},
			{
				onSuperseded: (reason) => closeClient(reason),
			},
		);
		if (registration.status !== 'admitted') {
			throw new Error(`gateway control process session capacity refused: ${registration.reason}`);
		}
		processAdmissionRegistration = registration.registration;
	}

	void startAttempt().catch((error: unknown) => {
		if (!readySettled) {
			readySettled = true;
			rejectReady(error instanceof Error ? error : new Error(String(error)));
		}
	});

	return {
		ready,
		close: () => closeClient('gateway control session closed'),
		fenceCurrentSession: (fenceOptions) => {
			const attempt = currentAttempt;
			if (
				attempt === undefined ||
				!attempt.accepted ||
				attempt.attachmentGeneration !== fenceOptions.expectedAttachmentGeneration ||
				attempt.sessionId !== fenceOptions.expectedSessionId
			) {
				return { status: 'not-current' };
			}
			const fencedSession = {
				attachmentGeneration: attempt.attachmentGeneration,
				sessionId: attempt.sessionId,
				status: 'fenced',
			} as const;
			fenceAttempt(attempt, fenceOptions.reason);
			return fencedSession;
		},
		emitApplicationMessage: async (envelope, domainMessage, payload, emitOptions) => {
			const attempt = currentAttempt;
			if (attempt === undefined || !attempt.accepted || !attempt.socket.connected) {
				throw new Error('gateway control attachment is not connected');
			}
			const message = GatewayControlRpcMessageSchema.parse(payload);
			assertControlSessionMessageWithinBounds(envelope, message);
			assertControlSessionDispatchAllowed({
				domainMessage,
				envelope,
				policyByOperation: options.policyByOperation,
				...(options.policyByKind === undefined ? {} : { policyByKind: options.policyByKind }),
			});
			assertEnvelopeMatchesAttempt(attempt, envelope);
			const classification = classifyGatewayControlAdmission({
				controllerSafetyOperation:
					message.operation === 'recovery_command' ||
					(message.operation === 'operation_cancel' &&
						message.kind === 'command' &&
						message.payload.initiatedBy === 'controller'),
				direction: 'controller_to_gateway',
				matchedPendingResult: false,
				message,
			});
			if (classification.status !== 'classified') {
				const failureMessage = admissionFailureMessage(classification);
				if (classification.status === 'fence') {
					fenceAttempt(attempt, failureMessage);
				}
				throw new Error(failureMessage);
			}
			let applicationResult: unknown;
			const submission = submitAttemptAdmission({
				localExecutor: attempt.egressAdmission,
				request: {
					byteLength: measureControlSessionMessageBytes(envelope, message),
					...(classification.coalesceKey === undefined
						? {}
						: { coalesceKey: classification.coalesceKey }),
					execute: async () => {
						if (currentAttempt !== attempt || !attempt.accepted || !attempt.socket.connected) {
							return;
						}
						const outboundEnvelope = buildCurrentAttemptOutboundEnvelope({
							attempt,
							identity: options.identity,
							intent: envelope,
							nowMs: now(),
						});
						attempt.nextControllerSequence += 1;
						const resultPromise =
							outboundEnvelope.kind === 'command' && outboundEnvelope.operation !== undefined
								? commandResultPromise({
										attempt,
										expectedOperation: outboundEnvelope.operation,
										messageId: outboundEnvelope.messageId,
										pendingResults,
										timeoutMs:
											emitOptions?.commandResultTimeoutMs ??
											options.commandResultTimeoutMsByOperation?.[outboundEnvelope.operation] ??
											commandAckTimeoutMs,
									})
								: undefined;
						resultPromise?.catch(() => undefined);
						const receipt: unknown = await attempt.socket
							.timeout(commandAckTimeoutMs)
							.emitWithAck(CONTROL_SESSION_EVENT_NAMES.message, outboundEnvelope, message);
						assertControlMessageReceiptAccepted(receipt);
						attempt.lastSeenControllerSequence = outboundEnvelope.sequence;
						applicationResult = resultPromise === undefined ? undefined : await resultPromise;
					},
					id: envelope.messageId,
					messageClass: classification.messageClass,
					payload: message,
				},
			});
			switch (submission.admission.status) {
				case 'admitted':
				case 'replaced': {
					if (
						envelope.deliveryPolicy === 'latest_wins' ||
						envelope.deliveryPolicy === 'droppable'
					) {
						void submission.completion.catch((error: unknown) => {
							fenceAttempt(
								attempt,
								error instanceof Error ? error.message : 'gateway control egress failed',
							);
						});
						return undefined;
					}
					let completion: Awaited<typeof submission.completion>;
					try {
						completion = await submission.completion;
					} catch (error) {
						fenceAttempt(
							attempt,
							error instanceof Error ? error.message : 'gateway control egress failed',
						);
						throw error;
					}
					if (completion.status === 'executed') {
						return applicationResult;
					}
					return undefined;
				}
				case 'fence':
				case 'closed': {
					const failureMessage = `gateway control egress admission ${submission.admission.status}`;
					fenceAttempt(attempt, failureMessage);
					throw new Error(failureMessage);
				}
				case 'dropped':
				case 'refused':
				case 'shed':
					return undefined;
			}
			throw new Error('unsupported gateway control admission result');
		},
		getDiagnostics: () => ({
			accepted: currentAttempt?.accepted ?? false,
			...(currentAttempt === undefined
				? {}
				: { attachmentGeneration: currentAttempt.attachmentGeneration }),
			connected: currentAttempt?.socket.connected ?? false,
			endpointPath: options.endpoint.path,
			helloCount,
			...(lastHelloResponse === undefined ? {} : { lastHelloResponse }),
			ready: currentAttempt?.accepted ?? false,
			reconnectAttempts,
			reconnectExhausted,
			...(currentAttempt?.socket.io.engine?.transport?.name === undefined
				? {}
				: { transportName: currentAttempt.socket.io.engine.transport.name }),
		}),
	};
}
