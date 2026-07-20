/* oxlint-disable eslint/no-await-in-loop -- source reads, writes, observations, and drain waits are the serialized backpressure contract. */
import type { Writable } from 'node:stream';

import {
	createGatewayRuntimeChunkSenderState,
	reduceGatewayRuntimeChunkSenderState,
	type GatewayRuntimeChunkSenderState,
	type GatewayRuntimeRetainedByteLimits,
	type GatewayRuntimeRetainedByteMeasurements,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';

export interface GatewayRuntimeExternalRetainedByteMeasurements {
	readonly kernelSendBufferedBytes: number;
	readonly parserBufferedBytes: number;
}

export interface GatewayRuntimeWritablePressureEvidence {
	readonly retainedBytes: GatewayRuntimeRetainedByteMeasurements;
	readonly retainedByteHighWater: GatewayRuntimeRetainedByteMeasurements;
}

export interface SendGatewayRuntimeApplicationChunksOptions {
	readonly encodeChunk: (applicationChunk: Uint8Array) => Uint8Array;
	readonly maxTotalApplicationBytes: number;
	readonly observeExternalRetainedBytes?: () =>
		| GatewayRuntimeExternalRetainedByteMeasurements
		| Promise<GatewayRuntimeExternalRetainedByteMeasurements>;
	readonly onWritablePressure?: (
		evidence: GatewayRuntimeWritablePressureEvidence,
	) => void | Promise<void>;
	readonly retainedByteLimits: GatewayRuntimeRetainedByteLimits;
	readonly source: AsyncIterable<Uint8Array>;
	readonly writable: Writable;
}

interface GatewayRuntimeChunkSendEvidence {
	readonly chunkReadCount: number;
	readonly chunkWriteCount: number;
	readonly drainCount: number;
	readonly highWaterRetainedBytes: GatewayRuntimeRetainedByteMeasurements;
	readonly totalApplicationBytes: number;
	readonly writablePressureCount: number;
}

export type GatewayRuntimeChunkSendResult =
	| (GatewayRuntimeChunkSendEvidence & { readonly kind: 'completed' })
	| (GatewayRuntimeChunkSendEvidence & { readonly kind: 'disconnected' })
	| (GatewayRuntimeChunkSendEvidence & {
			readonly attemptedChunkBytes: number;
			readonly kind: 'total-byte-limit-exceeded';
	  });

type WritableTermination =
	| { readonly kind: 'closed' }
	| { readonly error: Error; readonly kind: 'error' };

interface WritableTerminationObserver {
	readonly dispose: () => void;
	readonly termination: Promise<WritableTermination>;
}

function assertPositiveSafeInteger(value: number, fieldName: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${fieldName} must be a positive safe integer.`);
	}
}

function observeWritableTermination(writable: Writable): WritableTerminationObserver {
	let settled = false;
	let resolveTermination: (termination: WritableTermination) => void;
	const termination = new Promise<WritableTermination>((resolve) => {
		resolveTermination = resolve;
	});
	const settle = (result: WritableTermination): void => {
		if (settled) return;
		settled = true;
		resolveTermination(result);
	};
	const onClose = (): void => settle({ kind: 'closed' });
	const onError = (error: Error): void => settle({ error, kind: 'error' });
	writable.once('close', onClose);
	writable.once('error', onError);
	if (writable.destroyed) onClose();
	return {
		dispose: () => {
			writable.off('close', onClose);
			writable.off('error', onError);
		},
		termination,
	};
}

async function stopSource(sourceIterator: AsyncIterator<Uint8Array>): Promise<void> {
	if (sourceIterator.return !== undefined) await sourceIterator.return();
}

function createEvidence(
	state: GatewayRuntimeChunkSenderState,
	counts: {
		readonly chunkReadCount: number;
		readonly chunkWriteCount: number;
		readonly drainCount: number;
		readonly totalApplicationBytes: number;
		readonly writablePressureCount: number;
	},
): GatewayRuntimeChunkSendEvidence {
	return {
		...counts,
		highWaterRetainedBytes: state.highWaterRetainedBytes,
	};
}

async function recordRetainedBytes(options: {
	readonly observeExternalRetainedBytes:
		| SendGatewayRuntimeApplicationChunksOptions['observeExternalRetainedBytes']
		| undefined;
	readonly state: GatewayRuntimeChunkSenderState;
	readonly writable: Writable;
}): Promise<GatewayRuntimeChunkSenderState> {
	const externalMeasurements =
		(await options.observeExternalRetainedBytes?.()) ??
		({ kernelSendBufferedBytes: 0, parserBufferedBytes: 0 } as const);
	return reduceGatewayRuntimeChunkSenderState(options.state, {
		kernelSendBufferedBytes: externalMeasurements.kernelSendBufferedBytes,
		kind: 'retained-bytes-observed',
		nodeWritableBufferedBytes: options.writable.writableLength,
		parserBufferedBytes: externalMeasurements.parserBufferedBytes,
	}).state;
}

async function waitForDrainOrTermination(options: {
	readonly termination: Promise<WritableTermination>;
	readonly writable: Writable;
}): Promise<'drained' | WritableTermination> {
	let onDrain!: () => void;
	const drained = new Promise<'drained'>((resolve) => {
		onDrain = () => resolve('drained');
		options.writable.once('drain', onDrain);
	});
	try {
		return await Promise.race([drained, options.termination]);
	} finally {
		options.writable.off('drain', onDrain);
	}
}

/**
 * Drive one bounded application chunk at a time into a writable transport.
 *
 * `write() === true` means accepted into bounded transport buffers. It does not
 * mean delivered or acknowledged by the peer.
 */
export async function sendGatewayRuntimeApplicationChunks(
	options: SendGatewayRuntimeApplicationChunksOptions,
): Promise<GatewayRuntimeChunkSendResult> {
	assertPositiveSafeInteger(options.maxTotalApplicationBytes, 'maxTotalApplicationBytes');
	const sourceIterator = options.source[Symbol.asyncIterator]();
	const terminationObserver = observeWritableTermination(options.writable);
	let state = reduceGatewayRuntimeChunkSenderState(
		createGatewayRuntimeChunkSenderState(options.retainedByteLimits),
		{ kind: 'start' },
	).state;
	let chunkReadCount = 0;
	let chunkWriteCount = 0;
	let drainCount = 0;
	let sourceIteratorTerminated = false;
	let totalApplicationBytes = 0;
	let writablePressureCount = 0;
	const terminateSourceIterator = async (): Promise<void> => {
		if (sourceIteratorTerminated) return;
		sourceIteratorTerminated = true;
		await stopSource(sourceIterator);
	};

	const currentEvidence = (): GatewayRuntimeChunkSendEvidence =>
		createEvidence(state, {
			chunkReadCount,
			chunkWriteCount,
			drainCount,
			totalApplicationBytes,
			writablePressureCount,
		});
	try {
		while (state.phase === 'reading-source') {
			const sourceRead = sourceIterator.next();
			const nextEvent = await Promise.race([
				sourceRead.then((result) => ({ kind: 'source' as const, result })),
				terminationObserver.termination,
			]);
			if (nextEvent.kind === 'error') throw nextEvent.error;
			if (nextEvent.kind === 'closed') {
				state = reduceGatewayRuntimeChunkSenderState(state, { kind: 'disconnected' }).state;
				await terminateSourceIterator();
				return { ...currentEvidence(), kind: 'disconnected' };
			}
			if (nextEvent.result.done === true) {
				sourceIteratorTerminated = true;
				return { ...currentEvidence(), kind: 'completed' };
			}

			const applicationChunk = nextEvent.result.value;
			chunkReadCount += 1;
			if (totalApplicationBytes + applicationChunk.byteLength > options.maxTotalApplicationBytes) {
				await terminateSourceIterator();
				return {
					...currentEvidence(),
					attemptedChunkBytes: applicationChunk.byteLength,
					kind: 'total-byte-limit-exceeded',
				};
			}

			state = reduceGatewayRuntimeChunkSenderState(state, {
				chunk: applicationChunk,
				kind: 'source-chunk-read',
			}).state;
			const encodedChunk = options.encodeChunk(applicationChunk);
			const writableWithoutDrain = options.writable.write(encodedChunk);
			chunkWriteCount += 1;
			totalApplicationBytes += applicationChunk.byteLength;
			state = reduceGatewayRuntimeChunkSenderState(state, {
				kind: 'write-result',
				writableWithoutDrain,
			}).state;
			state = await recordRetainedBytes({
				observeExternalRetainedBytes: options.observeExternalRetainedBytes,
				state,
				writable: options.writable,
			});
			if (writableWithoutDrain) continue;

			writablePressureCount += 1;
			const drainOrTermination = waitForDrainOrTermination({
				termination: terminationObserver.termination,
				writable: options.writable,
			});
			await options.onWritablePressure?.({
				retainedBytes: state.currentRetainedBytes,
				retainedByteHighWater: state.highWaterRetainedBytes,
			});
			const outcome = await drainOrTermination;
			if (outcome !== 'drained') {
				if (outcome.kind === 'error') throw outcome.error;
				state = reduceGatewayRuntimeChunkSenderState(state, { kind: 'disconnected' }).state;
				await terminateSourceIterator();
				return { ...currentEvidence(), kind: 'disconnected' };
			}
			drainCount += 1;
			state = reduceGatewayRuntimeChunkSenderState(state, { kind: 'drain' }).state;
		}
		return { ...currentEvidence(), kind: 'completed' };
	} catch (error: unknown) {
		try {
			await terminateSourceIterator();
		} catch (sourceTerminationError: unknown) {
			const sourceTerminationMessage =
				sourceTerminationError instanceof Error
					? sourceTerminationError.message
					: 'unknown source termination failure';
			const sendFailureMessage = error instanceof Error ? error.message : 'unknown send failure';
			throw new Error(
				`Gateway runtime source termination failed after '${sendFailureMessage}': ${sourceTerminationMessage}`,
				{ cause: sourceTerminationError },
			);
		}
		throw error;
	} finally {
		terminationObserver.dispose();
	}
}
