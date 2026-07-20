export interface GatewayRuntimeRetainedByteMeasurements {
	readonly kernelSendBufferedBytes: number;
	readonly nodeWritableBufferedBytes: number;
	readonly parserBufferedBytes: number;
	readonly sourceOwnedApplicationChunkBytes: number;
}

export interface GatewayRuntimeRetainedByteLimits {
	readonly maxKernelSendBufferedBytes: number;
	readonly maxNodeWritableBufferedBytes: number;
	readonly maxParserBufferedBytes: number;
	readonly maxSourceOwnedApplicationChunkBytes: number;
}

export type GatewayRuntimeChunkSenderPhase =
	| 'idle'
	| 'reading-source'
	| 'writing-chunk'
	| 'waiting-for-drain'
	| 'disconnected';

export interface GatewayRuntimeChunkSenderState {
	readonly currentRetainedBytes: GatewayRuntimeRetainedByteMeasurements;
	readonly highWaterRetainedBytes: GatewayRuntimeRetainedByteMeasurements;
	readonly ownedApplicationChunkCount: 0 | 1;
	readonly phase: GatewayRuntimeChunkSenderPhase;
	readonly retainedByteLimits: GatewayRuntimeRetainedByteLimits;
}

export type GatewayRuntimeChunkSenderEvent =
	| { readonly kind: 'disconnected' }
	| { readonly kind: 'drain' }
	| {
			readonly kernelSendBufferedBytes: number;
			readonly kind: 'retained-bytes-observed';
			readonly nodeWritableBufferedBytes: number;
			readonly parserBufferedBytes: number;
	  }
	| { readonly chunk: Uint8Array; readonly kind: 'source-chunk-read' }
	| { readonly kind: 'start' }
	| { readonly kind: 'write-result'; readonly writableWithoutDrain: boolean };

export type GatewayRuntimeChunkSenderEffect =
	| { readonly chunk: Uint8Array; readonly kind: 'encode-and-write' }
	| { readonly kind: 'read-source' };

export interface GatewayRuntimeChunkSenderTransition {
	readonly effects: readonly GatewayRuntimeChunkSenderEffect[];
	readonly state: GatewayRuntimeChunkSenderState;
}

const ZERO_RETAINED_BYTES = Object.freeze({
	kernelSendBufferedBytes: 0,
	nodeWritableBufferedBytes: 0,
	parserBufferedBytes: 0,
	sourceOwnedApplicationChunkBytes: 0,
}) satisfies GatewayRuntimeRetainedByteMeasurements;

function assertNonnegativeSafeInteger(value: number, fieldName: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${fieldName} must be a nonnegative safe integer.`);
	}
}

function assertPositiveSafeInteger(value: number, fieldName: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${fieldName} must be a positive safe integer.`);
	}
}

function assertUnreachable(value: never): never {
	throw new Error(`Unhandled Gateway runtime flow-control event: ${JSON.stringify(value)}`);
}

function assertWithinLimit(value: number, limit: number, measurementName: string): void {
	assertNonnegativeSafeInteger(value, measurementName);
	if (value > limit) {
		throw new Error(`${measurementName} exceeds its configured retained-byte limit.`);
	}
}

function highWaterMeasurements(
	current: GatewayRuntimeRetainedByteMeasurements,
	previousHighWater: GatewayRuntimeRetainedByteMeasurements,
): GatewayRuntimeRetainedByteMeasurements {
	return Object.freeze({
		kernelSendBufferedBytes: Math.max(
			current.kernelSendBufferedBytes,
			previousHighWater.kernelSendBufferedBytes,
		),
		nodeWritableBufferedBytes: Math.max(
			current.nodeWritableBufferedBytes,
			previousHighWater.nodeWritableBufferedBytes,
		),
		parserBufferedBytes: Math.max(
			current.parserBufferedBytes,
			previousHighWater.parserBufferedBytes,
		),
		sourceOwnedApplicationChunkBytes: Math.max(
			current.sourceOwnedApplicationChunkBytes,
			previousHighWater.sourceOwnedApplicationChunkBytes,
		),
	});
}

function transitionChunkSender(
	state: GatewayRuntimeChunkSenderState,
	effects: readonly GatewayRuntimeChunkSenderEffect[] = [],
): GatewayRuntimeChunkSenderTransition {
	return { effects, state };
}

export function createGatewayRuntimeChunkSenderState(
	retainedByteLimits: GatewayRuntimeRetainedByteLimits,
): GatewayRuntimeChunkSenderState {
	assertPositiveSafeInteger(
		retainedByteLimits.maxKernelSendBufferedBytes,
		'maxKernelSendBufferedBytes',
	);
	assertPositiveSafeInteger(
		retainedByteLimits.maxNodeWritableBufferedBytes,
		'maxNodeWritableBufferedBytes',
	);
	assertPositiveSafeInteger(retainedByteLimits.maxParserBufferedBytes, 'maxParserBufferedBytes');
	assertPositiveSafeInteger(
		retainedByteLimits.maxSourceOwnedApplicationChunkBytes,
		'maxSourceOwnedApplicationChunkBytes',
	);
	return {
		currentRetainedBytes: ZERO_RETAINED_BYTES,
		highWaterRetainedBytes: ZERO_RETAINED_BYTES,
		ownedApplicationChunkCount: 0,
		phase: 'idle',
		retainedByteLimits: Object.freeze({ ...retainedByteLimits }),
	};
}

export function reduceGatewayRuntimeChunkSenderState(
	state: GatewayRuntimeChunkSenderState,
	event: GatewayRuntimeChunkSenderEvent,
): GatewayRuntimeChunkSenderTransition {
	if (event.kind === 'disconnected') {
		if (state.phase === 'disconnected') return transitionChunkSender(state);
		const currentRetainedBytes = Object.freeze({
			...state.currentRetainedBytes,
			sourceOwnedApplicationChunkBytes: 0,
		});
		return transitionChunkSender({
			...state,
			currentRetainedBytes,
			ownedApplicationChunkCount: 0,
			phase: 'disconnected',
		});
	}
	if (state.phase === 'disconnected') return transitionChunkSender(state);

	switch (event.kind) {
		case 'start': {
			if (state.phase !== 'idle') {
				throw new Error('Gateway runtime chunk sender can only start from idle.');
			}
			return transitionChunkSender({ ...state, phase: 'reading-source' }, [
				{ kind: 'read-source' },
			]);
		}
		case 'source-chunk-read': {
			if (state.phase !== 'reading-source' || state.ownedApplicationChunkCount !== 0) {
				throw new Error('Gateway runtime chunk sender already owns an application chunk.');
			}
			assertWithinLimit(
				event.chunk.byteLength,
				state.retainedByteLimits.maxSourceOwnedApplicationChunkBytes,
				'source-owned application chunk',
			);
			const currentRetainedBytes = Object.freeze({
				...state.currentRetainedBytes,
				sourceOwnedApplicationChunkBytes: event.chunk.byteLength,
			});
			return transitionChunkSender(
				{
					...state,
					currentRetainedBytes,
					highWaterRetainedBytes: highWaterMeasurements(
						currentRetainedBytes,
						state.highWaterRetainedBytes,
					),
					ownedApplicationChunkCount: 1,
					phase: 'writing-chunk',
				},
				[{ chunk: event.chunk, kind: 'encode-and-write' }],
			);
		}
		case 'write-result': {
			if (state.phase !== 'writing-chunk' || state.ownedApplicationChunkCount !== 1) {
				throw new Error('Gateway runtime chunk sender has no application chunk being written.');
			}
			const currentRetainedBytes = Object.freeze({
				...state.currentRetainedBytes,
				sourceOwnedApplicationChunkBytes: 0,
			});
			const nextState = {
				...state,
				currentRetainedBytes,
				ownedApplicationChunkCount: 0 as const,
				phase: event.writableWithoutDrain
					? ('reading-source' as const)
					: ('waiting-for-drain' as const),
			};
			return transitionChunkSender(
				nextState,
				event.writableWithoutDrain ? [{ kind: 'read-source' }] : [],
			);
		}
		case 'drain': {
			if (state.phase !== 'waiting-for-drain') {
				throw new Error('Gateway runtime chunk sender received drain while not waiting for drain.');
			}
			return transitionChunkSender({ ...state, phase: 'reading-source' }, [
				{ kind: 'read-source' },
			]);
		}
		case 'retained-bytes-observed': {
			assertWithinLimit(
				event.kernelSendBufferedBytes,
				state.retainedByteLimits.maxKernelSendBufferedBytes,
				'kernel send buffer',
			);
			assertWithinLimit(
				event.nodeWritableBufferedBytes,
				state.retainedByteLimits.maxNodeWritableBufferedBytes,
				'Node writable buffer',
			);
			assertWithinLimit(
				event.parserBufferedBytes,
				state.retainedByteLimits.maxParserBufferedBytes,
				'parser buffer',
			);
			const currentRetainedBytes = Object.freeze({
				kernelSendBufferedBytes: event.kernelSendBufferedBytes,
				nodeWritableBufferedBytes: event.nodeWritableBufferedBytes,
				parserBufferedBytes: event.parserBufferedBytes,
				sourceOwnedApplicationChunkBytes:
					state.currentRetainedBytes.sourceOwnedApplicationChunkBytes,
			});
			return transitionChunkSender({
				...state,
				currentRetainedBytes,
				highWaterRetainedBytes: highWaterMeasurements(
					currentRetainedBytes,
					state.highWaterRetainedBytes,
				),
			});
		}
	}
	return assertUnreachable(event);
}

export type GatewayRuntimeClientReadPhase =
	| 'flowing'
	| 'downstream-paused'
	| 'discard-draining'
	| 'completed';

export type GatewayRuntimeStreamTerminalOutcome = string;

export type GatewayRuntimeClientFrame =
	| {
			readonly chunk: Uint8Array;
			readonly kind: 'stream-data';
			readonly streamId: string;
	  }
	| {
			readonly kind: 'authoritative-stream-terminal';
			readonly outcome: GatewayRuntimeStreamTerminalOutcome;
			readonly streamId: string;
	  }
	| { readonly kind: 'control'; readonly method: string };

export interface GatewayRuntimeClientReadState {
	readonly pauseDeadlineMilliseconds: number;
	readonly phase: GatewayRuntimeClientReadPhase;
	readonly streamId: string;
}

export type GatewayRuntimeClientReadEvent =
	| { readonly kind: 'attachment-retired' }
	| { readonly kind: 'downstream-pressure' }
	| { readonly kind: 'downstream-resumed' }
	| { readonly frame: GatewayRuntimeClientFrame; readonly kind: 'frame-received' }
	| { readonly kind: 'local-cancel' }
	| { readonly kind: 'local-close' }
	| { readonly kind: 'pause-deadline-expired' };

export type GatewayRuntimeClientReadEffect =
	| { readonly kind: 'cancel-pause-deadline' }
	| {
			readonly kind: 'complete-stream';
			readonly outcome: GatewayRuntimeStreamTerminalOutcome;
			readonly streamId: string;
	  }
	| { readonly kind: 'discard-stream-data'; readonly streamId: string }
	| { readonly frame: GatewayRuntimeClientFrame; readonly kind: 'forward-frame' }
	| { readonly kind: 'pause-socket-read' }
	| { readonly kind: 'resume-socket-read' }
	| { readonly afterMilliseconds: number; readonly kind: 'schedule-pause-deadline' };

export interface GatewayRuntimeClientReadTransition {
	readonly effects: readonly GatewayRuntimeClientReadEffect[];
	readonly state: GatewayRuntimeClientReadState;
}

function transitionClientRead(
	state: GatewayRuntimeClientReadState,
	effects: readonly GatewayRuntimeClientReadEffect[] = [],
): GatewayRuntimeClientReadTransition {
	return { effects, state };
}

function enterDiscardDraining(
	state: GatewayRuntimeClientReadState,
): GatewayRuntimeClientReadTransition {
	return transitionClientRead({ ...state, phase: 'discard-draining' }, [
		{ kind: 'cancel-pause-deadline' },
		{ kind: 'resume-socket-read' },
	]);
}

export function createGatewayRuntimeClientReadState(options: {
	readonly pauseDeadlineMilliseconds: number;
	readonly streamId: string;
}): GatewayRuntimeClientReadState {
	assertPositiveSafeInteger(options.pauseDeadlineMilliseconds, 'pauseDeadlineMilliseconds');
	if (options.streamId.length === 0) throw new Error('streamId must not be empty.');
	return {
		pauseDeadlineMilliseconds: options.pauseDeadlineMilliseconds,
		phase: 'flowing',
		streamId: options.streamId,
	};
}

export function reduceGatewayRuntimeClientReadState(
	state: GatewayRuntimeClientReadState,
	event: GatewayRuntimeClientReadEvent,
): GatewayRuntimeClientReadTransition {
	switch (event.kind) {
		case 'downstream-pressure': {
			if (state.phase !== 'flowing') {
				throw new Error('Gateway runtime client read can only pause while flowing.');
			}
			return transitionClientRead({ ...state, phase: 'downstream-paused' }, [
				{ kind: 'pause-socket-read' },
				{
					afterMilliseconds: state.pauseDeadlineMilliseconds,
					kind: 'schedule-pause-deadline',
				},
			]);
		}
		case 'downstream-resumed': {
			if (state.phase !== 'downstream-paused') {
				throw new Error('Gateway runtime client read can only resume from a downstream pause.');
			}
			return transitionClientRead({ ...state, phase: 'flowing' }, [
				{ kind: 'cancel-pause-deadline' },
				{ kind: 'resume-socket-read' },
			]);
		}
		case 'pause-deadline-expired': {
			if (state.phase !== 'downstream-paused') {
				throw new Error('Gateway runtime pause deadline expired without a downstream pause.');
			}
			return enterDiscardDraining(state);
		}
		case 'attachment-retired':
		case 'local-cancel':
		case 'local-close': {
			if (state.phase === 'downstream-paused') return enterDiscardDraining(state);
			if (state.phase === 'completed') return transitionClientRead(state);
			return transitionClientRead({ ...state, phase: 'discard-draining' });
		}
		case 'frame-received': {
			if (state.phase === 'completed') return transitionClientRead(state);
			const frame = event.frame;
			if (
				state.phase === 'discard-draining' &&
				frame.kind === 'stream-data' &&
				frame.streamId === state.streamId
			) {
				return transitionClientRead(state, [
					{ kind: 'discard-stream-data', streamId: state.streamId },
				]);
			}
			if (
				state.phase === 'discard-draining' &&
				frame.kind === 'authoritative-stream-terminal' &&
				frame.streamId === state.streamId
			) {
				return transitionClientRead({ ...state, phase: 'completed' }, [
					{ frame, kind: 'forward-frame' },
					{
						kind: 'complete-stream',
						outcome: frame.outcome,
						streamId: state.streamId,
					},
				]);
			}
			return transitionClientRead(state, [{ frame, kind: 'forward-frame' }]);
		}
	}
	return assertUnreachable(event);
}
