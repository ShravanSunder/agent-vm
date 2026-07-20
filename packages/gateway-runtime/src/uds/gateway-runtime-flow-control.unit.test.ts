import {
	createGatewayRuntimeChunkSenderState,
	createGatewayRuntimeClientReadState,
	reduceGatewayRuntimeChunkSenderState,
	reduceGatewayRuntimeClientReadState,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { describe, expect, it } from 'vitest';

type GatewayRuntimeChunkSenderState = ReturnType<typeof createGatewayRuntimeChunkSenderState>;
type GatewayRuntimeClientReadState = ReturnType<typeof createGatewayRuntimeClientReadState>;

const SENDER_RETAINED_BYTE_LIMITS = {
	maxKernelSendBufferedBytes: 16,
	maxNodeWritableBufferedBytes: 12,
	maxParserBufferedBytes: 8,
	maxSourceOwnedApplicationChunkBytes: 4,
} as const;

const TARGET_STREAM_ID = 'stream-target';
const SIBLING_STREAM_ID = 'stream-sibling';
const PAUSE_DEADLINE_MILLISECONDS = 25;

function createSenderState(): GatewayRuntimeChunkSenderState {
	return createGatewayRuntimeChunkSenderState(SENDER_RETAINED_BYTE_LIMITS);
}

function createStartedSenderState(): GatewayRuntimeChunkSenderState {
	return reduceGatewayRuntimeChunkSenderState(createSenderState(), { kind: 'start' }).state;
}

function createClientReadState(): GatewayRuntimeClientReadState {
	return createGatewayRuntimeClientReadState({
		pauseDeadlineMilliseconds: PAUSE_DEADLINE_MILLISECONDS,
		streamId: TARGET_STREAM_ID,
	});
}

function createPausedClientReadState(): GatewayRuntimeClientReadState {
	return reduceGatewayRuntimeClientReadState(createClientReadState(), {
		kind: 'downstream-pressure',
	}).state;
}

function createDiscardDrainingClientReadState(): GatewayRuntimeClientReadState {
	return reduceGatewayRuntimeClientReadState(createPausedClientReadState(), {
		kind: 'pause-deadline-expired',
	}).state;
}

describe('Gateway runtime bounded chunk sender', () => {
	it('owns one application chunk while encoding and writing, then reads the next after an accepted write', () => {
		// Arrange
		const applicationChunk = new Uint8Array([1, 2, 3, 4]);
		const initialState = createSenderState();

		// Act
		const started = reduceGatewayRuntimeChunkSenderState(initialState, { kind: 'start' });
		const chunkRead = reduceGatewayRuntimeChunkSenderState(started.state, {
			chunk: applicationChunk,
			kind: 'source-chunk-read',
		});
		const writeAccepted = reduceGatewayRuntimeChunkSenderState(chunkRead.state, {
			kind: 'write-result',
			writableWithoutDrain: true,
		});

		// Assert
		expect(started.state).toMatchObject({
			ownedApplicationChunkCount: 0,
			phase: 'reading-source',
		});
		expect(started.effects).toEqual([{ kind: 'read-source' }]);
		expect(chunkRead.state).toMatchObject({
			currentRetainedBytes: { sourceOwnedApplicationChunkBytes: 4 },
			ownedApplicationChunkCount: 1,
			phase: 'writing-chunk',
		});
		expect(chunkRead.effects).toEqual([{ chunk: applicationChunk, kind: 'encode-and-write' }]);
		expect(writeAccepted.state).toMatchObject({
			currentRetainedBytes: { sourceOwnedApplicationChunkBytes: 0 },
			ownedApplicationChunkCount: 0,
			phase: 'reading-source',
		});
		expect(writeAccepted.effects).toEqual([{ kind: 'read-source' }]);
	});

	it('does not read another chunk under writable pressure until drain', () => {
		// Arrange
		const chunkRead = reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
			chunk: new Uint8Array([1, 2]),
			kind: 'source-chunk-read',
		});

		// Act
		const writePressured = reduceGatewayRuntimeChunkSenderState(chunkRead.state, {
			kind: 'write-result',
			writableWithoutDrain: false,
		});
		const drained = reduceGatewayRuntimeChunkSenderState(writePressured.state, { kind: 'drain' });

		// Assert
		expect(writePressured.state).toMatchObject({
			currentRetainedBytes: { sourceOwnedApplicationChunkBytes: 0 },
			ownedApplicationChunkCount: 0,
			phase: 'waiting-for-drain',
		});
		expect(writePressured.effects).toEqual([]);
		expect(drained.state.phase).toBe('reading-source');
		expect(drained.effects).toEqual([{ kind: 'read-source' }]);
	});

	it('rejects a second source chunk while the serializer owns one', () => {
		// Arrange
		const firstChunkRead = reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
			chunk: new Uint8Array([1]),
			kind: 'source-chunk-read',
		});

		// Act
		const readSecondChunk = (): unknown =>
			reduceGatewayRuntimeChunkSenderState(firstChunkRead.state, {
				chunk: new Uint8Array([2]),
				kind: 'source-chunk-read',
			});

		// Assert
		expect(readSecondChunk).toThrow(/application chunk/i);
	});

	it('stops source reads on disconnect and does not revive them on a late drain', () => {
		// Arrange
		const chunkRead = reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
			chunk: new Uint8Array([1]),
			kind: 'source-chunk-read',
		});
		const waitingForDrain = reduceGatewayRuntimeChunkSenderState(chunkRead.state, {
			kind: 'write-result',
			writableWithoutDrain: false,
		});

		// Act
		const disconnected = reduceGatewayRuntimeChunkSenderState(waitingForDrain.state, {
			kind: 'disconnected',
		});
		const lateDrain = reduceGatewayRuntimeChunkSenderState(disconnected.state, { kind: 'drain' });

		// Assert
		expect(disconnected.state.phase).toBe('disconnected');
		expect(disconnected.effects).toEqual([]);
		expect(lateDrain.state.phase).toBe('disconnected');
		expect(lateDrain.effects).toEqual([]);
	});

	it('records source, parser, Node, and kernel current and high-water retained bytes', () => {
		// Arrange
		const chunkRead = reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
			chunk: new Uint8Array([1, 2, 3, 4]),
			kind: 'source-chunk-read',
		});

		// Act
		const firstObservation = reduceGatewayRuntimeChunkSenderState(chunkRead.state, {
			kernelSendBufferedBytes: 15,
			kind: 'retained-bytes-observed',
			nodeWritableBufferedBytes: 11,
			parserBufferedBytes: 7,
		});
		const smallerObservation = reduceGatewayRuntimeChunkSenderState(firstObservation.state, {
			kernelSendBufferedBytes: 3,
			kind: 'retained-bytes-observed',
			nodeWritableBufferedBytes: 2,
			parserBufferedBytes: 1,
		});

		// Assert
		expect(smallerObservation.state).toMatchObject({
			currentRetainedBytes: {
				kernelSendBufferedBytes: 3,
				nodeWritableBufferedBytes: 2,
				parserBufferedBytes: 1,
				sourceOwnedApplicationChunkBytes: 4,
			},
			highWaterRetainedBytes: {
				kernelSendBufferedBytes: 15,
				nodeWritableBufferedBytes: 11,
				parserBufferedBytes: 7,
				sourceOwnedApplicationChunkBytes: 4,
			},
			retainedByteLimits: SENDER_RETAINED_BYTE_LIMITS,
		});
	});

	it.each([
		{
			limitName: 'source-owned application chunk',
			overflow: (): unknown =>
				reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
					chunk: new Uint8Array(5),
					kind: 'source-chunk-read',
				}),
		},
		{
			limitName: 'parser buffer',
			overflow: (): unknown =>
				reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
					kernelSendBufferedBytes: 0,
					kind: 'retained-bytes-observed',
					nodeWritableBufferedBytes: 0,
					parserBufferedBytes: 9,
				}),
		},
		{
			limitName: 'Node writable buffer',
			overflow: (): unknown =>
				reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
					kernelSendBufferedBytes: 0,
					kind: 'retained-bytes-observed',
					nodeWritableBufferedBytes: 13,
					parserBufferedBytes: 0,
				}),
		},
		{
			limitName: 'kernel send buffer',
			overflow: (): unknown =>
				reduceGatewayRuntimeChunkSenderState(createStartedSenderState(), {
					kernelSendBufferedBytes: 17,
					kind: 'retained-bytes-observed',
					nodeWritableBufferedBytes: 0,
					parserBufferedBytes: 0,
				}),
		},
	])('fails closed when the $limitName exceeds its configured cap', ({ overflow }) => {
		// Arrange
		const exceedConfiguredLimit = overflow;

		// Act
		const act = (): unknown => exceedConfiguredLimit();

		// Assert
		expect(act).toThrow(/limit/i);
	});
});

describe('Gateway runtime client read controller', () => {
	it('transitions from flowing to downstream-paused and back to flowing', () => {
		// Arrange
		const flowingState = createClientReadState();

		// Act
		const paused = reduceGatewayRuntimeClientReadState(flowingState, {
			kind: 'downstream-pressure',
		});
		const resumed = reduceGatewayRuntimeClientReadState(paused.state, {
			kind: 'downstream-resumed',
		});

		// Assert
		expect(paused.state.phase).toBe('downstream-paused');
		expect(paused.effects).toEqual([
			{ kind: 'pause-socket-read' },
			{
				afterMilliseconds: PAUSE_DEADLINE_MILLISECONDS,
				kind: 'schedule-pause-deadline',
			},
		]);
		expect(resumed.state.phase).toBe('flowing');
		expect(resumed.effects).toEqual([
			{ kind: 'cancel-pause-deadline' },
			{ kind: 'resume-socket-read' },
		]);
	});

	it('escapes a bounded pause into discard-draining without a remote acknowledgement', () => {
		// Arrange
		const pausedState = createPausedClientReadState();

		// Act
		const deadlineExpired = reduceGatewayRuntimeClientReadState(pausedState, {
			kind: 'pause-deadline-expired',
		});

		// Assert
		expect(deadlineExpired.state).toMatchObject({
			phase: 'discard-draining',
			streamId: TARGET_STREAM_ID,
		});
		expect(deadlineExpired.effects).toEqual([
			{ kind: 'cancel-pause-deadline' },
			{ kind: 'resume-socket-read' },
		]);
		expect(deadlineExpired.effects).not.toContainEqual({ kind: 'complete-stream' });
	});

	it.each([
		{ escapeEvent: { kind: 'local-cancel' } as const, escapeName: 'local cancel' },
		{ escapeEvent: { kind: 'local-close' } as const, escapeName: 'local close' },
		{ escapeEvent: { kind: 'attachment-retired' } as const, escapeName: 'attachment retirement' },
	])('uses $escapeName as an immediate local escape from a paused read', ({ escapeEvent }) => {
		// Arrange
		const pausedState = createPausedClientReadState();

		// Act
		const escaped = reduceGatewayRuntimeClientReadState(pausedState, escapeEvent);

		// Assert
		expect(escaped.state.phase).toBe('discard-draining');
		expect(escaped.effects).toEqual([
			{ kind: 'cancel-pause-deadline' },
			{ kind: 'resume-socket-read' },
		]);
		expect(escaped.effects).not.toContainEqual({ kind: 'complete-stream' });
	});

	it('discards only target-stream data while forwarding control and sibling frames', () => {
		// Arrange
		const discardDrainingState = createDiscardDrainingClientReadState();
		const targetDataFrame = {
			chunk: new Uint8Array([1]),
			kind: 'stream-data',
			streamId: TARGET_STREAM_ID,
		} as const;
		const siblingDataFrame = {
			chunk: new Uint8Array([2]),
			kind: 'stream-data',
			streamId: SIBLING_STREAM_ID,
		} as const;
		const controlFrame = { kind: 'control', method: 'gateway.heartbeat' } as const;
		const siblingTerminalFrame = {
			kind: 'authoritative-stream-terminal',
			outcome: 'completed',
			streamId: SIBLING_STREAM_ID,
		} as const;

		// Act
		const targetData = reduceGatewayRuntimeClientReadState(discardDrainingState, {
			frame: targetDataFrame,
			kind: 'frame-received',
		});
		const siblingData = reduceGatewayRuntimeClientReadState(targetData.state, {
			frame: siblingDataFrame,
			kind: 'frame-received',
		});
		const control = reduceGatewayRuntimeClientReadState(siblingData.state, {
			frame: controlFrame,
			kind: 'frame-received',
		});
		const siblingTerminal = reduceGatewayRuntimeClientReadState(control.state, {
			frame: siblingTerminalFrame,
			kind: 'frame-received',
		});

		// Assert
		expect(targetData.effects).toEqual([
			{ kind: 'discard-stream-data', streamId: TARGET_STREAM_ID },
		]);
		expect(siblingData.effects).toEqual([{ frame: siblingDataFrame, kind: 'forward-frame' }]);
		expect(control.effects).toEqual([{ frame: controlFrame, kind: 'forward-frame' }]);
		expect(siblingTerminal.effects).toEqual([
			{ frame: siblingTerminalFrame, kind: 'forward-frame' },
		]);
		expect(siblingTerminal.state.phase).toBe('discard-draining');
	});

	it('completes a discard-draining stream only on its authoritative terminal frame', () => {
		// Arrange
		const discardDrainingState = createDiscardDrainingClientReadState();
		const targetDataFrame = {
			chunk: new Uint8Array([1]),
			kind: 'stream-data',
			streamId: TARGET_STREAM_ID,
		} as const;
		const controlFrame = { kind: 'control', method: 'gateway.heartbeat' } as const;
		const targetTerminalFrame = {
			kind: 'authoritative-stream-terminal',
			outcome: 'cancelled',
			streamId: TARGET_STREAM_ID,
		} as const;

		// Act
		const targetData = reduceGatewayRuntimeClientReadState(discardDrainingState, {
			frame: targetDataFrame,
			kind: 'frame-received',
		});
		const control = reduceGatewayRuntimeClientReadState(targetData.state, {
			frame: controlFrame,
			kind: 'frame-received',
		});
		const targetTerminal = reduceGatewayRuntimeClientReadState(control.state, {
			frame: targetTerminalFrame,
			kind: 'frame-received',
		});

		// Assert
		expect(targetData.state.phase).toBe('discard-draining');
		expect(control.state.phase).toBe('discard-draining');
		expect(targetData.effects).not.toContainEqual({ kind: 'complete-stream' });
		expect(control.effects).not.toContainEqual({ kind: 'complete-stream' });
		expect(targetTerminal.state.phase).toBe('completed');
		expect(targetTerminal.effects).toEqual([
			{ frame: targetTerminalFrame, kind: 'forward-frame' },
			{ kind: 'complete-stream', outcome: 'cancelled', streamId: TARGET_STREAM_ID },
		]);
	});
});
