import type { FileHandle } from 'node:fs/promises';

/** Test-only observation of real file handles; never retains the observed payload buffers. */
export function createPayloadMemoryProbe(expectedStalledWrites: number): {
	observe(handle: FileHandle): void;
	readonly stalled: Promise<void>;
	release(): void;
	snapshot(): {
		readonly readBytes: number;
		readonly writtenBytes: number;
		readonly pendingWriteBytes: number;
		readonly peakPendingWriteBytes: number;
		readonly peakArrayBufferGrowth: number;
		readonly peakHeapGrowth: number;
		readonly peakRssGrowth: number;
		readonly openHandles: number;
	};
} {
	const baseline = process.memoryUsage();
	const stalled = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let writesStarted = 0;
	let readBytes = 0;
	let writtenBytes = 0;
	let pendingWriteBytes = 0;
	let peakPendingWriteBytes = 0;
	let peakArrayBufferGrowth = 0;
	let peakHeapGrowth = 0;
	let peakRssGrowth = 0;
	let openHandles = 0;
	const sample = (): void => {
		const current = process.memoryUsage();
		peakArrayBufferGrowth = Math.max(
			peakArrayBufferGrowth,
			current.arrayBuffers - baseline.arrayBuffers,
		);
		peakHeapGrowth = Math.max(peakHeapGrowth, current.heapUsed - baseline.heapUsed);
		peakRssGrowth = Math.max(peakRssGrowth, current.rss - baseline.rss);
	};
	return {
		stalled: stalled.promise,
		release: () => resume.resolve(),
		snapshot: () => {
			sample();
			return {
				readBytes,
				writtenBytes,
				pendingWriteBytes,
				peakPendingWriteBytes,
				peakArrayBufferGrowth,
				peakHeapGrowth,
				peakRssGrowth,
				openHandles,
			};
		},
		observe: (handle) => {
			openHandles += 1;
			let closed = false;
			const originalRead = handle.read.bind(handle);
			const originalWrite = handle.write.bind(handle);
			const originalClose = handle.close.bind(handle);
			// Wrappers preserve native results/overloads and touch only this test-owned handle.
			Object.defineProperty(handle, 'read', {
				value: async (...args: unknown[]): Promise<unknown> => {
					const result: unknown = await Reflect.apply(originalRead, handle, args);
					if (
						typeof result !== 'object' ||
						result === null ||
						!('bytesRead' in result) ||
						typeof result.bytesRead !== 'number'
					)
						throw new Error('Unexpected native read result.');
					readBytes += result.bytesRead;
					sample();
					return result;
				},
			});
			Object.defineProperty(handle, 'write', {
				value: async (...args: unknown[]): Promise<unknown> => {
					const chunk = args[0];
					const length = args[2];
					if (!(chunk instanceof Uint8Array) || typeof length !== 'number')
						throw new Error('Payload proof expected a byte-range write.');
					pendingWriteBytes += length;
					peakPendingWriteBytes = Math.max(peakPendingWriteBytes, pendingWriteBytes);
					writesStarted += 1;
					sample();
					if (writesStarted === expectedStalledWrites) stalled.resolve();
					try {
						await resume.promise;
						const result: unknown = await Reflect.apply(originalWrite, handle, args);
						if (
							typeof result !== 'object' ||
							result === null ||
							!('bytesWritten' in result) ||
							typeof result.bytesWritten !== 'number'
						)
							throw new Error('Unexpected native write result.');
						writtenBytes += result.bytesWritten;
						return result;
					} finally {
						pendingWriteBytes -= length;
						sample();
					}
				},
			});
			Object.defineProperty(handle, 'close', {
				value: async (): Promise<void> => {
					await originalClose();
					if (!closed) {
						closed = true;
						openHandles -= 1;
					}
					sample();
				},
			});
		},
	};
}
