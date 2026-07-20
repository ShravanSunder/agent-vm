import { Buffer } from 'node:buffer';

import {
	ControllerExecutionDataCreditSchema,
	ControllerExecutionDataFrameSchema,
	ControllerExecutionDataHandshakeSchema,
	type ControllerExecutionDataCredit,
	type ControllerExecutionDataFrame,
	type ControllerExecutionDataHandshake,
} from '@agent-vm/controller-execution-contracts/controller-execution-data-boundary';

import {
	type ControllerExecutionDataChannel,
	type ControllerExecutionDataChannelRejectionReason,
	type ControllerExecutionDataChannelReceiveResult,
} from './controller-execution-data-channel.js';
import { ControllerExecutionWorkCapacityError } from './controller-execution-work-scheduler.js';

const policyViolationCloseCode = 1008;

export type ControllerExecutionWebSocketSessionReceiveRejectionReason =
	| ControllerExecutionDataChannelRejectionReason
	| 'consumer-failed'
	| 'codec-capacity-exceeded'
	| 'execution-capacity-exceeded'
	| 'handshake-required'
	| 'invalid-message'
	| 'message-too-large'
	| 'session-closed'
	| 'transport-failed'
	| 'upgrade-not-authenticated';

export type ControllerExecutionWebSocketSessionReceiveResult =
	| ControllerExecutionDataChannelReceiveResult
	| {
			readonly kind: 'rejected';
			readonly reason: ControllerExecutionWebSocketSessionReceiveRejectionReason;
	  };

export type ControllerExecutionWebSocketCreditResult =
	| ControllerExecutionDataCredit
	| {
			readonly kind: 'rejected';
			readonly reason:
				| 'codec-capacity-exceeded'
				| 'execution-capacity-exceeded'
				| 'invalid-consumption'
				| 'session-closed'
				| 'transport-failed';
	  };

export interface ControllerExecutionWebSocketSession {
	readonly activateAuthenticatedUpgrade: () =>
		| { readonly kind: 'accepted' }
		| { readonly kind: 'rejected'; readonly reason: 'session-closed' };
	readonly consumeData: (props: {
		readonly consumedBytes: number;
	}) => Promise<ControllerExecutionWebSocketCreditResult>;
	readonly notifyTransportClosed: () => void;
	readonly receiveText: (text: string) => Promise<ControllerExecutionWebSocketSessionReceiveResult>;
}

type ControllerExecutionDecodedMessage =
	| {
			readonly handshake: ControllerExecutionDataHandshake;
			readonly kind: 'handshake';
	  }
	| {
			readonly frame: Extract<ControllerExecutionDataFrame, { readonly kind: 'data' }>;
			readonly kind: 'data-frame';
			readonly payload: Uint8Array;
	  }
	| {
			readonly frame: Extract<ControllerExecutionDataFrame, { readonly kind: 'cancel' | 'eof' }>;
			readonly kind: 'terminal-frame';
	  }
	| {
			readonly kind: 'rejected';
			readonly reason: 'handshake-required' | 'invalid-message' | 'message-too-large';
	  };

export interface CreateControllerExecutionWebSocketSessionOptions {
	readonly channel: ControllerExecutionDataChannel;
	readonly close: (request: { readonly code: number; readonly reason: string }) => Promise<void>;
	readonly limits: { readonly maxMessageBytes: number };
	readonly onData: (data: Uint8Array) => Promise<void>;
	readonly onTerminal: (terminal: { readonly terminalKind: 'cancel' | 'eof' }) => Promise<void>;
	readonly sendText: (text: string) => Promise<void>;
}

export function createControllerExecutionWebSocketSession(
	options: CreateControllerExecutionWebSocketSessionOptions,
): ControllerExecutionWebSocketSession {
	if (
		!Number.isSafeInteger(options.limits.maxMessageBytes) ||
		options.limits.maxMessageBytes <= 0
	) {
		throw new Error(
			'Controller execution WebSocket maxMessageBytes must be a positive safe integer.',
		);
	}

	let sessionState: 'awaiting-upgrade' | 'awaiting-handshake' | 'active' | 'closed' =
		'awaiting-upgrade';
	let closePromise: Promise<void> | undefined;

	const closeOnce = async (reason: string): Promise<void> => {
		if (closePromise === undefined) {
			sessionState = 'closed';
			closePromise = options.close({ code: policyViolationCloseCode, reason });
		}
		await closePromise;
	};

	const rejectAndClose = async (
		reason: ControllerExecutionWebSocketSessionReceiveRejectionReason,
	): Promise<ControllerExecutionWebSocketSessionReceiveResult> => {
		await closeOnce(reason);
		return { kind: 'rejected', reason };
	};

	const decodeMessage = async (text: string): Promise<ControllerExecutionDecodedMessage> =>
		await options.channel.workScheduler.runBulkTask(
			'codec',
			async (): Promise<ControllerExecutionDecodedMessage> => {
				if (Buffer.byteLength(text, 'utf8') > options.limits.maxMessageBytes) {
					return { kind: 'rejected', reason: 'message-too-large' };
				}
				let parsedMessage: unknown;
				try {
					parsedMessage = JSON.parse(text) as unknown;
				} catch {
					return { kind: 'rejected', reason: 'invalid-message' };
				}
				if (sessionState === 'awaiting-handshake') {
					const handshakeResult = ControllerExecutionDataHandshakeSchema.safeParse(parsedMessage);
					if (handshakeResult.success) {
						return { handshake: handshakeResult.data, kind: 'handshake' };
					}
					return {
						kind: 'rejected',
						reason: ControllerExecutionDataFrameSchema.safeParse(parsedMessage).success
							? 'handshake-required'
							: 'invalid-message',
					};
				}
				const frameResult = ControllerExecutionDataFrameSchema.safeParse(parsedMessage);
				if (!frameResult.success) return { kind: 'rejected', reason: 'invalid-message' };
				return frameResult.data.kind === 'data'
					? {
							frame: frameResult.data,
							kind: 'data-frame',
							payload: Uint8Array.from(Buffer.from(frameResult.data.payloadBase64, 'base64')),
						}
					: { frame: frameResult.data, kind: 'terminal-frame' };
			},
		);

	const encodeCredit = async (credit: ControllerExecutionDataCredit): Promise<string> =>
		await options.channel.workScheduler.runBulkTask(
			'codec',
			async (): Promise<string> =>
				JSON.stringify(ControllerExecutionDataCreditSchema.parse(credit)),
		);

	const capacityReason = (
		error: unknown,
	): 'codec-capacity-exceeded' | 'execution-capacity-exceeded' | undefined =>
		error instanceof ControllerExecutionWorkCapacityError
			? `${error.workKind}-capacity-exceeded`
			: undefined;

	return {
		activateAuthenticatedUpgrade: () => {
			if (sessionState !== 'awaiting-upgrade') {
				return { kind: 'rejected', reason: 'session-closed' };
			}
			sessionState = 'awaiting-handshake';
			return { kind: 'accepted' };
		},
		consumeData: async ({ consumedBytes }) => {
			if (sessionState !== 'active') {
				return { kind: 'rejected', reason: 'session-closed' };
			}
			const creditResult = options.channel.consumeQueuedBytes({ consumedBytes });
			if (creditResult.kind === 'rejected') return creditResult;
			const channelState = options.channel.state();
			if (channelState.kind !== 'open') {
				return { kind: 'rejected', reason: 'session-closed' };
			}
			const credit = {
				...options.channel.binding,
				availableCreditBytes: creditResult.availableCreditBytes,
				kind: 'credit',
				nextSequence: channelState.nextSequence,
				queuedBytes: creditResult.queuedBytes,
			} satisfies ControllerExecutionDataCredit;
			try {
				await options.sendText(await encodeCredit(credit));
			} catch (error: unknown) {
				const boundedReason = capacityReason(error);
				if (boundedReason !== undefined) {
					await closeOnce(boundedReason);
					return { kind: 'rejected', reason: boundedReason };
				}
				await closeOnce('transport-failed');
				return { kind: 'rejected', reason: 'transport-failed' };
			}
			return credit;
		},
		notifyTransportClosed: (): void => {
			sessionState = 'closed';
			options.channel.notifyTransportClosed();
		},
		receiveText: async (text) => {
			if (sessionState === 'awaiting-upgrade') {
				return await rejectAndClose('upgrade-not-authenticated');
			}
			if (sessionState === 'closed') {
				return { kind: 'rejected', reason: 'session-closed' };
			}
			let decodedMessage: ControllerExecutionDecodedMessage;
			try {
				decodedMessage = await decodeMessage(text);
			} catch (error: unknown) {
				const boundedReason = capacityReason(error);
				if (boundedReason !== undefined) return await rejectAndClose(boundedReason);
				throw error;
			}
			if (decodedMessage.kind === 'rejected') {
				return await rejectAndClose(decodedMessage.reason);
			}

			if (sessionState === 'awaiting-handshake') {
				if (decodedMessage.kind !== 'handshake') return await rejectAndClose('invalid-message');
				const authentication = options.channel.authenticateHandshake(decodedMessage.handshake);
				if (authentication.kind === 'rejected') {
					return await rejectAndClose(authentication.reason);
				}
				sessionState = 'active';
				const channelState = options.channel.state();
				if (channelState.kind !== 'open') {
					return await rejectAndClose('ambiguous-operation');
				}
				const initialCredit = {
					...options.channel.binding,
					availableCreditBytes: channelState.availableCreditBytes,
					kind: 'credit',
					nextSequence: channelState.nextSequence,
					queuedBytes: channelState.queuedBytes,
				} satisfies ControllerExecutionDataCredit;
				try {
					await options.sendText(await encodeCredit(initialCredit));
				} catch (error: unknown) {
					const boundedReason = capacityReason(error);
					if (boundedReason !== undefined) return await rejectAndClose(boundedReason);
					return await rejectAndClose('transport-failed');
				}
				return {
					availableCreditBytes: channelState.availableCreditBytes,
					kind: 'accepted',
					nextSequence: channelState.nextSequence,
				};
			}

			if (decodedMessage.kind === 'handshake') return await rejectAndClose('invalid-message');
			const receiveResult = await options.channel.receive(
				decodedMessage.kind === 'data-frame'
					? { frame: decodedMessage.frame, kind: 'data', payload: decodedMessage.payload }
					: { frame: decodedMessage.frame, kind: 'terminal' },
			);
			if (receiveResult.kind === 'rejected') {
				return await rejectAndClose(receiveResult.reason);
			}
			try {
				if (decodedMessage.kind === 'data-frame') {
					await options.channel.workScheduler.runBulkTask('execution', async (): Promise<void> => {
						await options.onData(decodedMessage.payload);
					});
				} else {
					await options.channel.workScheduler.runBulkTask('execution', async (): Promise<void> => {
						await options.onTerminal({ terminalKind: decodedMessage.frame.kind });
					});
				}
			} catch (error: unknown) {
				const boundedReason = capacityReason(error);
				if (boundedReason !== undefined) return await rejectAndClose(boundedReason);
				return await rejectAndClose('consumer-failed');
			}
			return receiveResult;
		},
	};
}
