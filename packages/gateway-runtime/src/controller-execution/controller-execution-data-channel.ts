import type {
	ControllerExecutionDataBinding,
	ControllerExecutionDataFrame,
	ControllerExecutionDataHandshake,
} from '@agent-vm/controller-execution-contracts/controller-execution-data-boundary';

import {
	createControllerExecutionWorkScheduler,
	ControllerExecutionWorkCapacityError,
	type ControllerExecutionWorkLaneLimits,
	type ControllerExecutionWorkScheduler,
} from './controller-execution-work-scheduler.js';

export type ControllerExecutionChannelBinding = ControllerExecutionDataBinding;
export type ControllerExecutionChannelFrame = ControllerExecutionDataFrame;

export type ControllerExecutionDataChannelAdmission =
	| {
			readonly frame: Extract<ControllerExecutionChannelFrame, { readonly kind: 'data' }>;
			readonly kind: 'data';
			readonly payload: Uint8Array;
	  }
	| {
			readonly frame: Extract<ControllerExecutionChannelFrame, { readonly kind: 'cancel' | 'eof' }>;
			readonly kind: 'terminal';
	  };

export type ControllerExecutionDeadlineKind = 'heartbeat' | 'recovery-admission' | 'safety-cancel';

export interface ControllerExecutionDataChannelClock {
	readonly now: () => number;
}

export interface ControllerExecutionDataChannelScheduler {
	readonly schedule: (callback: () => void, delayMs: number) => void;
}

export interface CreateControllerExecutionDataChannelOptions {
	readonly binding: ControllerExecutionChannelBinding;
	readonly deadlineMilliseconds: Readonly<Record<ControllerExecutionDeadlineKind, number>>;
	readonly limits: {
		readonly initialCreditBytes: number;
		readonly maxQueuedBytes: number;
	};
	readonly workLaneLimits: Readonly<
		Record<'codec' | 'execution', ControllerExecutionWorkLaneLimits>
	>;
	readonly runtime: {
		readonly clock: ControllerExecutionDataChannelClock;
		readonly scheduler: ControllerExecutionDataChannelScheduler;
	};
}

export type ControllerExecutionDataChannelRejectionReason =
	| 'ambiguous-operation'
	| 'binding-mismatch'
	| 'duplicate-terminal-frame'
	| 'execution-capacity-exceeded'
	| 'invalid-credit'
	| 'invalid-sequence'
	| 'over-credit-payload'
	| 'queue-capacity-exceeded';

export type ControllerExecutionDataChannelClosureRejectionReason = Exclude<
	ControllerExecutionDataChannelRejectionReason,
	'ambiguous-operation' | 'duplicate-terminal-frame'
>;

export type ControllerExecutionDataChannelReceiveResult =
	| {
			readonly kind: 'accepted';
			readonly availableCreditBytes: number;
			readonly nextSequence: number;
	  }
	| {
			readonly kind: 'terminal';
			readonly terminalKind: 'cancel' | 'eof';
	  }
	| {
			readonly kind: 'rejected';
			readonly reason: ControllerExecutionDataChannelRejectionReason;
	  };

export type ControllerExecutionDataChannelHandshakeResult =
	| { readonly kind: 'authenticated' }
	| { readonly kind: 'rejected'; readonly reason: 'binding-mismatch' };

export type ControllerExecutionDataChannelReconnectResult = {
	readonly kind: 'rejected';
	readonly reason: 'ambiguous-operation' | 'binding-mismatch';
};

export type ControllerExecutionDataChannelState =
	| {
			readonly closureKind: 'ambiguous';
			readonly kind: 'closed';
			readonly queuedBytes: number;
			readonly redispatchAllowed: false;
	  }
	| {
			readonly availableCreditBytes: number;
			readonly kind: 'open';
			readonly nextSequence: number;
			readonly queuedBytes: number;
			readonly redispatchAllowed: false;
	  }
	| {
			readonly closureKind: 'terminal';
			readonly kind: 'closed';
			readonly queuedBytes: number;
			readonly redispatchAllowed: false;
			readonly terminalKind: 'cancel' | 'eof';
	  }
	| {
			readonly closureKind: 'rejected';
			readonly kind: 'closed';
			readonly queuedBytes: number;
			readonly reason: ControllerExecutionDataChannelClosureRejectionReason;
			readonly redispatchAllowed: false;
	  };

type ControllerExecutionDataChannelLifecycle =
	| { readonly closureKind: 'open' }
	| { readonly closureKind: 'ambiguous' }
	| {
			readonly closureKind: 'rejected';
			readonly reason: ControllerExecutionDataChannelClosureRejectionReason;
	  }
	| { readonly closureKind: 'terminal'; readonly terminalKind: 'cancel' | 'eof' };

export interface ControllerExecutionDataChannel {
	readonly binding: ControllerExecutionChannelBinding;
	readonly authenticateHandshake: (
		candidateBinding: ControllerExecutionDataHandshake,
	) => ControllerExecutionDataChannelHandshakeResult;
	readonly receive: (
		admission: ControllerExecutionDataChannelAdmission,
	) => Promise<ControllerExecutionDataChannelReceiveResult>;
	readonly consumeQueuedBytes: (options: { readonly consumedBytes: number }) =>
		| {
				readonly availableCreditBytes: number;
				readonly kind: 'credit-granted';
				readonly queuedBytes: number;
		  }
		| { readonly kind: 'rejected'; readonly reason: 'invalid-consumption' };
	readonly notifyTransportClosed: () => void;
	readonly reconnect: (
		candidateBinding: ControllerExecutionDataHandshake,
	) => ControllerExecutionDataChannelReconnectResult;
	readonly state: () => ControllerExecutionDataChannelState;
	readonly waitForIndependentDeadline: (
		deadlineKind: ControllerExecutionDeadlineKind,
	) => Promise<{ readonly kind: ControllerExecutionDeadlineKind; readonly met: boolean }>;
	readonly workScheduler: ControllerExecutionWorkScheduler;
}

export function createControllerExecutionDataChannel(
	options: CreateControllerExecutionDataChannelOptions,
): ControllerExecutionDataChannel {
	if (
		!Number.isSafeInteger(options.limits.initialCreditBytes) ||
		options.limits.initialCreditBytes < 0
	) {
		throw new Error('initialCreditBytes must be a non-negative safe integer.');
	}

	const maxQueuedBytes = options.limits.maxQueuedBytes;
	if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 0) {
		throw new Error('maxQueuedBytes must be a non-negative safe integer.');
	}
	for (const [deadlineKind, deadlineMilliseconds] of Object.entries(options.deadlineMilliseconds)) {
		if (!Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds <= 0) {
			throw new Error(`${deadlineKind} deadline must be a positive safe integer.`);
		}
	}

	const workScheduler = createControllerExecutionWorkScheduler({
		deadlinesMs: options.deadlineMilliseconds,
		limits: options.workLaneLimits,
		runtime: options.runtime,
	});
	let availableCreditBytes = options.limits.initialCreditBytes;
	const maximumCreditBytes = options.limits.initialCreditBytes;
	let lifecycle: ControllerExecutionDataChannelLifecycle = { closureKind: 'open' };
	let nextSequence = 0;
	let queuedBytes = 0;

	const rejectAndClose = (
		reason: ControllerExecutionDataChannelClosureRejectionReason,
	): ControllerExecutionDataChannelReceiveResult => {
		if (lifecycle.closureKind === 'open') {
			lifecycle = { closureKind: 'rejected', reason };
		}
		return { kind: 'rejected', reason };
	};

	const receiveFrame = (
		admission: ControllerExecutionDataChannelAdmission,
	): ControllerExecutionDataChannelReceiveResult => {
		const frame = admission.frame;
		if (!bindingsMatch(options.binding, frame)) {
			return rejectAndClose('binding-mismatch');
		}
		if (lifecycle.closureKind !== 'open') {
			return lifecycle.closureKind === 'terminal' && lifecycle.terminalKind === frame.kind
				? { kind: 'rejected', reason: 'duplicate-terminal-frame' }
				: { kind: 'rejected', reason: 'ambiguous-operation' };
		}
		if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== nextSequence) {
			return rejectAndClose('invalid-sequence');
		}
		if (
			!Number.isSafeInteger(frame.creditBytes) ||
			frame.creditBytes < 0 ||
			frame.creditBytes !== availableCreditBytes
		) {
			return rejectAndClose('invalid-credit');
		}
		if (admission.kind === 'terminal') {
			const terminalFrame = admission.frame;
			lifecycle = { closureKind: 'terminal', terminalKind: terminalFrame.kind };
			return { kind: 'terminal', terminalKind: terminalFrame.kind };
		}
		const dataFrame = admission.frame;
		const payloadByteLength = admission.payload.byteLength;
		if (payloadByteLength > dataFrame.creditBytes || payloadByteLength > availableCreditBytes) {
			return rejectAndClose('over-credit-payload');
		}
		if (queuedBytes + payloadByteLength > maxQueuedBytes) {
			return rejectAndClose('queue-capacity-exceeded');
		}

		availableCreditBytes -= payloadByteLength;
		queuedBytes += payloadByteLength;
		nextSequence += 1;
		return { kind: 'accepted', availableCreditBytes, nextSequence };
	};

	return {
		authenticateHandshake: (candidateBinding) =>
			bindingsMatch(options.binding, candidateBinding)
				? { kind: 'authenticated' }
				: { kind: 'rejected', reason: 'binding-mismatch' },
		binding: options.binding,
		consumeQueuedBytes: ({ consumedBytes }) => {
			if (
				lifecycle.closureKind !== 'open' ||
				!Number.isSafeInteger(consumedBytes) ||
				consumedBytes <= 0 ||
				consumedBytes > queuedBytes
			) {
				return { kind: 'rejected', reason: 'invalid-consumption' };
			}
			queuedBytes -= consumedBytes;
			availableCreditBytes = Math.min(maximumCreditBytes, availableCreditBytes + consumedBytes);
			return { availableCreditBytes, kind: 'credit-granted', queuedBytes };
		},
		notifyTransportClosed: (): void => {
			if (lifecycle.closureKind === 'open') lifecycle = { closureKind: 'ambiguous' };
		},
		receive: async (admission): Promise<ControllerExecutionDataChannelReceiveResult> => {
			try {
				return await workScheduler.runBulkTask('execution', async () => receiveFrame(admission));
			} catch (error: unknown) {
				if (
					error instanceof ControllerExecutionWorkCapacityError &&
					error.workKind === 'execution'
				) {
					return rejectAndClose('execution-capacity-exceeded');
				}
				throw error;
			}
		},
		reconnect: (candidateBinding) => {
			if (!bindingsMatch(options.binding, candidateBinding)) {
				return { kind: 'rejected', reason: 'binding-mismatch' };
			}
			return { kind: 'rejected', reason: 'ambiguous-operation' };
		},
		state: (): ControllerExecutionDataChannelState => {
			if (lifecycle.closureKind === 'open') {
				return {
					availableCreditBytes,
					kind: 'open',
					nextSequence,
					queuedBytes,
					redispatchAllowed: false,
				};
			}
			if (lifecycle.closureKind === 'terminal') {
				return {
					closureKind: 'terminal',
					kind: 'closed',
					queuedBytes,
					redispatchAllowed: false,
					terminalKind: lifecycle.terminalKind,
				};
			}
			if (lifecycle.closureKind === 'ambiguous') {
				return {
					closureKind: 'ambiguous',
					kind: 'closed',
					queuedBytes,
					redispatchAllowed: false,
				};
			}
			return {
				closureKind: 'rejected',
				kind: 'closed',
				queuedBytes,
				reason: lifecycle.reason,
				redispatchAllowed: false,
			};
		},
		waitForIndependentDeadline: async (deadlineKind) => {
			const result = await workScheduler.runCriticalTask(
				deadlineKind,
				async (): Promise<void> => undefined,
			);
			return { kind: deadlineKind, met: result.met };
		},
		workScheduler,
	};
}

function bindingsMatch(
	expected: ControllerExecutionChannelBinding,
	candidate: ControllerExecutionChannelBinding,
): boolean {
	return (
		expected.audience === candidate.audience &&
		expected.channelId === candidate.channelId &&
		expected.controllerEpoch === candidate.controllerEpoch &&
		expected.executionFingerprint === candidate.executionFingerprint &&
		expected.gatewayEpoch === candidate.gatewayEpoch &&
		expected.operationId === candidate.operationId &&
		expected.runtimeEpoch === candidate.runtimeEpoch &&
		expected.stablePrincipal === candidate.stablePrincipal
	);
}
