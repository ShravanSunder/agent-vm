import { randomUUID } from 'node:crypto';

import {
	CONTROL_SESSION_TIMING_MS,
	ControlEnvelopeSchema,
	assertControlEnvelopeMatchesDomainMessage,
	assertControlMessageReceiptAccepted,
	buildControlMessageExceptionRejectionReceipt,
	buildControlMessageReceipt,
	evaluateControlSequenceContinuity,
	extractDomainCommandResultResponseToMessageId,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcMessageSchema,
	assertGatewayControlEnvelopeDeliveryPolicy,
	classifyGatewayControlAdmission,
	type GatewayControlControllerToGatewayEvents,
	type GatewayControlGatewayToControllerEvents,
	type GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';
import type { Socket } from 'socket.io';

import {
	createGatewayControlAdmissionPressureE2eActuator,
	registerGatewayControlAdmissionPressureE2eActuator,
} from './gateway-control-admission-pressure-e2e-testing.js';
import {
	buildGatewayControlAdmissionFailureResult,
	createGatewayControlSessionAdmissionRuntime,
	measureGatewayControlApplicationMessageBytes,
} from './gateway-control-admission-runtime.js';
import { GatewayControlSessionUnavailableError } from './gateway-control-endpoint-contracts.js';
import type {
	GatewayControlAcceptedSession,
	GatewayControlApplicationMessageHandler,
	GatewayControlApplicationMessageIntent,
	GatewayControlEmitApplicationMessageOptions,
	PendingGatewayControlCommandResult,
} from './gateway-control-endpoint-contracts.js';

export type GatewayControlSocket = Socket<
	GatewayControlControllerToGatewayEvents,
	GatewayControlGatewayToControllerEvents
>;

export interface GatewayControlApplicationMessageRuntimePorts {
	readonly applicationMessageHandler?: GatewayControlApplicationMessageHandler;
	assertInboundEnvelopeMatchesAcceptedSession(
		socket: GatewayControlSocket,
		envelope: ControlEnvelope,
	): void;
	closeForProtocolFailure(socket: GatewayControlSocket, safeMessage: string): void;
	closeForResponseFailure(socket: GatewayControlSocket, error: unknown): void;
	commandResultTimeoutMsFor(
		envelope: ControlEnvelope,
		options: GatewayControlEmitApplicationMessageOptions | undefined,
	): number;
	getAcceptedSession(): GatewayControlAcceptedSession | undefined;
	getAcceptedSocket(): GatewayControlSocket | undefined;
	getLastSeenControllerSequence(): number;
	readonly pendingCommandResults: Map<string, PendingGatewayControlCommandResult>;
	recordLastSeenControllerSequence(sequence: number): void;
	recordLastSeenPeerSequence(sequence: number): void;
	reservePeerSequence(): number;
}

export interface GatewayControlApplicationMessageRuntime {
	bindSocket(socket: GatewayControlSocket): void;
	close(reason: string): void;
	emitApplicationMessage(
		intent: GatewayControlApplicationMessageIntent,
		options?: GatewayControlEmitApplicationMessageOptions,
	): Promise<unknown>;
	reset(reason: string): void;
}

function buildGatewayControlResponseEnvelope(options: {
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

export function createGatewayControlApplicationMessageRuntime(
	ports: GatewayControlApplicationMessageRuntimePorts,
): GatewayControlApplicationMessageRuntime {
	let admissionRuntime = createGatewayControlSessionAdmissionRuntime();
	registerGatewayControlAdmissionPressureE2eActuator(
		createGatewayControlAdmissionPressureE2eActuator({
			getAcceptedSession: () => ports.getAcceptedSession(),
			getEgress: () => admissionRuntime.egress,
			getIngress: () => admissionRuntime.ingress,
		}),
	);

	const submitGatewayControlEgress = async (optionsForEgress: {
		readonly classification: Extract<
			ReturnType<typeof classifyGatewayControlAdmission>,
			{ readonly status: 'classified' }
		>;
		readonly emitOptions?: GatewayControlEmitApplicationMessageOptions;
		readonly intent: GatewayControlApplicationMessageIntent;
	}): Promise<unknown> => {
		const session = ports.getAcceptedSession();
		const socket = ports.getAcceptedSocket();
		if (session === undefined || socket === undefined || !socket.connected) {
			throw new GatewayControlSessionUnavailableError();
		}
		const previewEnvelope = ControlEnvelopeSchema.parse(
			optionsForEgress.intent.buildEnvelope({
				acceptedSession: session,
				sequence: Number.MAX_SAFE_INTEGER,
			}),
		);
		if (
			previewEnvelope.bootId !== session.bootId ||
			previewEnvelope.connectionId !== session.connectionId ||
			previewEnvelope.controllerEpoch !== session.controllerEpoch ||
			previewEnvelope.peerId !== session.peerId ||
			previewEnvelope.sessionId !== session.sessionId ||
			previewEnvelope.zoneId !== session.zoneId
		) {
			throw new Error('gateway control envelope session identity does not match accepted session');
		}
		assertControlEnvelopeMatchesDomainMessage(
			previewEnvelope,
			optionsForEgress.intent.domainMessage,
		);
		assertGatewayControlEnvelopeDeliveryPolicy(previewEnvelope);
		if (previewEnvelope.deliveryPolicy === 'forbidden_bulk') {
			throw new Error('forbidden bulk message cannot be sent on the gateway control session');
		}
		let applicationResult: unknown;
		const submission = admissionRuntime.egress.submit({
			byteLength: measureGatewayControlApplicationMessageBytes(
				previewEnvelope,
				optionsForEgress.intent.payload,
			),
			...(optionsForEgress.classification.coalesceKey === undefined
				? {}
				: { coalesceKey: optionsForEgress.classification.coalesceKey }),
			execute: async () => {
				if (
					ports.getAcceptedSession() !== session ||
					ports.getAcceptedSocket() !== socket ||
					!socket.connected
				) {
					throw new Error('gateway control attachment changed before admitted send');
				}
				const sequence = ports.reservePeerSequence();
				const envelope = ControlEnvelopeSchema.parse(
					optionsForEgress.intent.buildEnvelope({ acceptedSession: session, sequence }),
				);
				assertControlEnvelopeMatchesDomainMessage(envelope, optionsForEgress.intent.domainMessage);
				assertGatewayControlEnvelopeDeliveryPolicy(envelope);
				const commandResultPromise =
					envelope.kind === 'command'
						? waitForGatewayControlCommandResult({
								connectionId: session.connectionId,
								messageId: envelope.messageId,
								operation: envelope.operation ?? '<none>',
								pendingCommandResults: ports.pendingCommandResults,
								sessionId: session.sessionId,
								timeoutMs: ports.commandResultTimeoutMsFor(envelope, optionsForEgress.emitOptions),
							})
						: undefined;
				commandResultPromise?.catch(() => undefined);
				try {
					const receiptPayload = await socket
						.timeout(CONTROL_SESSION_TIMING_MS.commandAckTimeout)
						.emitWithAck('control:message', envelope, optionsForEgress.intent.payload);
					assertControlMessageReceiptAccepted(receiptPayload);
					applicationResult = receiptPayload;
					ports.recordLastSeenPeerSequence(sequence);
					if (commandResultPromise !== undefined) {
						applicationResult = await commandResultPromise;
					}
				} catch (error: unknown) {
					ports.closeForResponseFailure(socket, error);
					throw error;
				}
			},
			id: previewEnvelope.messageId,
			messageClass: optionsForEgress.classification.messageClass,
			payload: optionsForEgress.intent.payload,
			...(optionsForEgress.classification.authoritySchedulingKey === undefined
				? {}
				: { stablePrincipal: optionsForEgress.classification.authoritySchedulingKey }),
		});
		if (submission.admission.status !== 'admitted' && submission.admission.status !== 'replaced') {
			throw new Error(
				`gateway control egress admission ${submission.admission.status}: ${'reason' in submission.admission ? submission.admission.reason : 'not admitted'}`,
			);
		}
		const completion = await submission.completion;
		if (completion.status !== 'executed') {
			throw new Error(
				completion.status === 'closed'
					? completion.reason
					: `gateway control egress ${completion.status} before send`,
			);
		}
		return applicationResult;
	};

	const emitApplicationMessage = async (
		intent: GatewayControlApplicationMessageIntent,
		emitOptions?: GatewayControlEmitApplicationMessageOptions,
	): Promise<unknown> => {
		const message = GatewayControlRpcMessageSchema.parse(intent.payload);
		const classification = admissionRuntime.classifyGatewayEgress({
			...(emitOptions?.admissionPrincipal === undefined
				? {}
				: { admissionPrincipal: emitOptions.admissionPrincipal }),
			message,
		});
		if (classification.status !== 'classified') {
			throw new Error(
				`gateway control egress classification ${classification.status}: ${classification.reason}`,
			);
		}
		return await submitGatewayControlEgress({
			classification,
			...(emitOptions === undefined ? {} : { emitOptions }),
			intent: { ...intent, payload: message },
		});
	};

	const responseIntent = (
		requestEnvelope: ControlEnvelope,
		payload: GatewayControlRpcMessage,
	): GatewayControlApplicationMessageIntent => ({
		buildEnvelope: ({ sequence }) =>
			buildGatewayControlResponseEnvelope({ requestEnvelope, sequence }),
		domainMessage: {
			kind: 'command_result',
			...(requestEnvelope.operation === undefined ? {} : { operation: requestEnvelope.operation }),
		},
		payload,
	});

	const submitAdmissionFailure = async (
		envelope: ControlEnvelope,
		message: GatewayControlRpcMessage,
		status: string,
	): Promise<unknown> =>
		await submitGatewayControlEgress({
			classification: { messageClass: 'safety', status: 'classified' },
			intent: responseIntent(
				envelope,
				buildGatewayControlAdmissionFailureResult({
					operation: message.operation ?? '<none>',
					responseToMessageId: envelope.messageId,
					status,
				}),
			),
		});

	const bindSocket = (socket: GatewayControlSocket): void => {
		socket.on('control:message', (envelopePayload, payload, acknowledge) => {
			void (async () => {
				try {
					const envelope = ControlEnvelopeSchema.parse(envelopePayload);
					const gatewayPayload = GatewayControlRpcMessageSchema.parse(payload);
					if (envelope.deliveryPolicy === 'forbidden_bulk') {
						throw new Error('forbidden bulk message cannot be sent on the gateway control session');
					}
					ports.assertInboundEnvelopeMatchesAcceptedSession(socket, envelope);
					if (typeof acknowledge !== 'function') {
						ports.closeForProtocolFailure(
							socket,
							'gateway control message did not provide a receipt callback',
						);
						return;
					}
					const responseToMessageId = extractDomainCommandResultResponseToMessageId(gatewayPayload);
					const sequenceDecision = evaluateControlSequenceContinuity({
						advisorySequenceMode: 'contiguous',
						envelope,
						lastSeenSequence: ports.getLastSeenControllerSequence(),
					});
					if (sequenceDecision.action === 'drop') {
						acknowledge(buildControlMessageReceipt());
						return;
					}
					if (sequenceDecision.action === 'stale') {
						ports.closeForProtocolFailure(socket, sequenceDecision.safeMessage);
						return;
					}
					ports.recordLastSeenControllerSequence(sequenceDecision.nextLastSeenSequence);
					if (envelope.kind === 'command_result' && responseToMessageId !== undefined) {
						const pendingResult = ports.pendingCommandResults.get(responseToMessageId);
						const matchedPendingResult =
							pendingResult !== undefined &&
							pendingResult.connectionId === envelope.connectionId &&
							pendingResult.operation === gatewayPayload.operation &&
							pendingResult.sessionId === envelope.sessionId;
						const classification = classifyGatewayControlAdmission({
							direction: 'controller_to_gateway',
							matchedPendingResult,
							message: gatewayPayload,
						});
						if (classification.status !== 'classified' || pendingResult === undefined) {
							ports.closeForProtocolFailure(
								socket,
								'gateway control command_result did not match an exact pending command',
							);
							return;
						}
						const submission = admissionRuntime.ingress.submit({
							byteLength: measureGatewayControlApplicationMessageBytes(envelope, gatewayPayload),
							execute: async () => {
								clearTimeout(pendingResult.timeout);
								ports.pendingCommandResults.delete(responseToMessageId);
								pendingResult.resolve(gatewayPayload);
							},
							id: envelope.messageId,
							messageClass: 'safety',
							payload: gatewayPayload,
						});
						if (submission.admission.status !== 'admitted') {
							ports.closeForProtocolFailure(
								socket,
								`gateway control command_result admission ${submission.admission.status}`,
							);
							return;
						}
						acknowledge(buildControlMessageReceipt());
						void submission.completion.catch((error: unknown) => {
							ports.closeForResponseFailure(socket, error);
						});
						return;
					}
					if (ports.applicationMessageHandler === undefined) {
						throw new Error('no gateway control application message handler configured');
					}
					const applicationMessageHandler = ports.applicationMessageHandler;
					assertControlEnvelopeMatchesDomainMessage(
						envelope,
						applicationMessageHandler.messageIdentity({
							envelope,
							payload: gatewayPayload,
						}),
					);
					assertGatewayControlEnvelopeDeliveryPolicy(envelope);
					const classification = classifyGatewayControlAdmission({
						controllerSafetyOperation:
							gatewayPayload.kind === 'command' &&
							(gatewayPayload.operation === 'operation_cancel' ||
								gatewayPayload.operation === 'recovery_command'),
						direction: 'controller_to_gateway',
						message: gatewayPayload,
					});
					if (classification.status === 'fence') {
						ports.closeForProtocolFailure(socket, classification.reason);
						return;
					}
					if (classification.status === 'refused') {
						acknowledge(buildControlMessageReceipt());
						if (envelope.kind === 'command') {
							void submitAdmissionFailure(envelope, gatewayPayload, classification.reason).catch(
								(error: unknown) => ports.closeForResponseFailure(socket, error),
							);
						}
						return;
					}
					const ingressCoalesceKey =
						envelope.kind === 'command' && classification.messageClass === 'liveness'
							? `${classification.coalesceKey ?? 'liveness'}:${envelope.messageId}`
							: classification.coalesceKey;
					const submission = admissionRuntime.ingress.submit({
						byteLength: measureGatewayControlApplicationMessageBytes(envelope, gatewayPayload),
						...(ingressCoalesceKey === undefined ? {} : { coalesceKey: ingressCoalesceKey }),
						execute: async () => {
							let responsePayload: unknown;
							try {
								responsePayload = await applicationMessageHandler.handle({
									envelope,
									payload: gatewayPayload,
								});
							} catch (error: unknown) {
								if (
									envelope.kind !== 'command' ||
									applicationMessageHandler.buildHandlerFailureResult === undefined
								) {
									throw error;
								}
								responsePayload = await applicationMessageHandler.buildHandlerFailureResult(
									{ envelope, payload: gatewayPayload },
									error,
								);
							}
							if (envelope.kind !== 'command' || responsePayload === undefined) return;
							const parsedResponsePayload = GatewayControlRpcMessageSchema.parse(responsePayload);
							await submitGatewayControlEgress({
								classification: { messageClass: 'safety', status: 'classified' },
								intent: responseIntent(envelope, parsedResponsePayload),
							});
						},
						id: envelope.messageId,
						messageClass: classification.messageClass,
						payload: gatewayPayload,
						...(classification.stablePrincipal === undefined
							? {}
							: { stablePrincipal: classification.stablePrincipal }),
					});
					if (
						submission.admission.status === 'admitted' ||
						submission.admission.status === 'replaced'
					) {
						acknowledge(buildControlMessageReceipt());
						void submission.completion.catch((error: unknown) => {
							ports.closeForResponseFailure(socket, error);
						});
						return;
					}
					if (submission.admission.status === 'fence') {
						ports.closeForProtocolFailure(socket, submission.admission.reason);
						return;
					}
					acknowledge(buildControlMessageReceipt());
					if (envelope.kind === 'command') {
						void submitAdmissionFailure(
							envelope,
							gatewayPayload,
							submission.admission.status,
						).catch((error: unknown) => ports.closeForResponseFailure(socket, error));
					}
				} catch (error: unknown) {
					acknowledge?.(
						buildControlMessageExceptionRejectionReceipt({
							error,
							processingErrorClass: 'gateway_control_message_processing_failed',
							safeMessage: 'gateway control message was rejected',
						}),
					);
				}
			})();
		});
	};

	return {
		bindSocket,
		close: (reason) => admissionRuntime.close(reason),
		emitApplicationMessage,
		reset: (reason) => {
			admissionRuntime.close(reason);
			admissionRuntime = createGatewayControlSessionAdmissionRuntime();
		},
	};
}

function waitForGatewayControlCommandResult(options: {
	readonly connectionId: string;
	readonly messageId: string;
	readonly operation: string;
	readonly pendingCommandResults: Map<string, PendingGatewayControlCommandResult>;
	readonly sessionId: string;
	readonly timeoutMs: number;
}): Promise<unknown> {
	const existingPendingResult = options.pendingCommandResults.get(options.messageId);
	if (existingPendingResult !== undefined) {
		if (
			existingPendingResult.connectionId !== options.connectionId ||
			existingPendingResult.operation !== options.operation ||
			existingPendingResult.sessionId !== options.sessionId
		) {
			throw new Error('gateway control pending result identity collision');
		}
		clearTimeout(existingPendingResult.timeout);
		existingPendingResult.timeout = setTimeout(() => {
			if (options.pendingCommandResults.get(options.messageId) === existingPendingResult) {
				options.pendingCommandResults.delete(options.messageId);
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
	const pendingResult: PendingGatewayControlCommandResult = {
		connectionId: options.connectionId,
		operation: options.operation,
		promise,
		reject: rejectPromise,
		resolve: resolvePromise,
		sessionId: options.sessionId,
		timeout: setTimeout(() => {
			if (options.pendingCommandResults.get(options.messageId) === pendingResult) {
				options.pendingCommandResults.delete(options.messageId);
			}
			rejectPromise(new Error(`gateway control command result timed out: ${options.messageId}`));
		}, options.timeoutMs),
	};
	pendingResult.timeout.unref?.();
	options.pendingCommandResults.set(options.messageId, pendingResult);
	return promise;
}
