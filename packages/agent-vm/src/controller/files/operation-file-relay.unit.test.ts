import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { inspectOperationFileInput, relayOperationFile } from './operation-file-relay.js';

function fixture(): Parameters<typeof relayOperationFile>[0] & {
	observation: { consumed: number };
} {
	const observation = { consumed: 0 };
	return {
		observation,
		source: {
			read: async function* () {
				observation.consumed++;
				yield new Uint8Array([0, 255]);
				observation.consumed++;
				yield new Uint8Array([128, 1]);
			},
		},
		sourceRelativePath: 'report.bin',
		destination: {
			createDirectory: vi.fn(async () => {}),
			publish: vi.fn(async () => ({ kind: 'published' as const, cleanup: 'complete' as const })),
			removeOwned: vi.fn(async () => {}),
		},
		destinationWriter: {
			writeFileStream: vi.fn(async ({ contents }) => {
				for await (const chunk of contents) {
					void chunk; // fake destination admits one chunk at a time
				}
			}),
		},
		destinationRoot: '/workspace',
		destinationDirectory: 'operation-1',
		finalName: 'report.bin',
		signal: new AbortController().signal,
		authorityIsCurrent: () => true,
	};
}

describe('direct controller operation-file relay', () => {
	it('delivers a valid file whose name matches the usual internal temporary name', async () => {
		// Arrange
		const input = fixture();
		// Act
		const result = await relayOperationFile({ ...input, finalName: 'incoming.part' });
		// Assert
		expect(result).toMatchObject({
			kind: 'published',
			path: '/workspace/operation-1/incoming.part',
		});
		expect(input.destination.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				temporaryRelativePath: 'operation-1/incoming-other.part',
				finalName: 'incoming.part',
			}),
		);
	});

	it('preserves backpressure and publishes only after the destination consumes every byte', async () => {
		// Arrange
		const input = fixture();
		const paused = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		input.destinationWriter.writeFileStream = async ({ contents }) => {
			for await (const chunk of contents) {
				void chunk;
				paused.resolve();
				await release.promise;
			}
		};
		// Act
		const transfer = relayOperationFile(input);
		await paused.promise;
		// Assert
		expect(input.observation.consumed).toBe(1);
		expect(input.destination.publish).not.toHaveBeenCalled();
		release.resolve();
		expect(await transfer).toEqual({
			kind: 'published',
			path: '/workspace/operation-1/report.bin',
			identity: {
				byteLength: 4,
				sha256: createHash('sha256')
					.update(new Uint8Array([0, 255, 128, 1]))
					.digest('hex'),
			},
			cleanup: 'complete',
		});
	});

	it('hashes an input without materializing it', async () => {
		// Arrange
		const input = fixture();
		// Act
		const identity = await inspectOperationFileInput({
			source: input.source,
			relativePath: input.sourceRelativePath,
			signal: input.signal,
		});
		// Assert
		expect(identity.byteLength).toBe(4);
		expect(input.destinationWriter.writeFileStream).not.toHaveBeenCalled();
	});

	it('rejects changed approved input before publication', async () => {
		// Arrange
		const input = fixture();
		// Act
		const result = await relayOperationFile({
			...input,
			expectedIdentity: { byteLength: 4, sha256: '0'.repeat(64) },
		});
		// Assert
		expect(result).toMatchObject({ kind: 'failed', reason: 'integrity-mismatch' });
		expect(input.destination.publish).not.toHaveBeenCalled();
		expect(input.destination.removeOwned).toHaveBeenCalledExactlyOnceWith(
			'operation-1/incoming.part',
		);
	});

	it('never cleans a preexisting destination directory', async () => {
		// Arrange
		const input = fixture();
		input.destination.createDirectory = async () => {
			throw new Error('exists');
		};
		// Act / Assert
		expect(await relayOperationFile(input)).toMatchObject({ kind: 'failed' });
		expect(input.destination.removeOwned).not.toHaveBeenCalled();
		expect(input.observation.consumed).toBe(0);
	});

	it('does not call a source successful if the writer returns without draining it', async () => {
		// Arrange
		const input = fixture();
		input.destinationWriter.writeFileStream = async () => {};
		// Act / Assert
		expect(await relayOperationFile(input)).toMatchObject({
			kind: 'failed',
			reason: 'transfer-failed',
		});
		expect(input.destination.publish).not.toHaveBeenCalled();
	});

	it('preserves successful publication when owned temporary cleanup is pending', async () => {
		// Arrange
		const input = fixture();
		input.destination.publish = async () => ({ kind: 'published', cleanup: 'pending' });
		// Act / Assert
		expect(await relayOperationFile(input)).toMatchObject({
			kind: 'published',
			cleanup: 'pending',
		});
		expect(input.destination.removeOwned).not.toHaveBeenCalled();
	});

	it('does not publish source bytes when the reader fails after yielding them', async () => {
		// Arrange
		const input = fixture();
		input.source.read = async function* () {
			yield new Uint8Array([1]);
			throw new Error('source exited unsuccessfully');
		};
		// Act / Assert
		expect(await relayOperationFile(input)).toMatchObject({ kind: 'failed', cleanup: 'complete' });
		expect(input.destination.publish).not.toHaveBeenCalled();
	});

	it('rechecks current authority after destination completion and before publication', async () => {
		// Arrange
		const input = fixture();
		let current = true;
		input.destinationWriter.writeFileStream = async ({ contents }) => {
			for await (const chunk of contents) void chunk;
			current = false;
		};
		// Act / Assert
		expect(await relayOperationFile({ ...input, authorityIsCurrent: () => current })).toMatchObject(
			{ kind: 'failed', reason: 'unavailable' },
		);
		expect(input.destination.publish).not.toHaveBeenCalled();
	});

	it('reports pending cleanup without deleting the final name after lost publication acknowledgement', async () => {
		// Arrange
		const input = fixture();
		input.destination.publish = async () => {
			throw new Error('acknowledgement lost');
		};
		input.destination.removeOwned = vi.fn(async () => {
			throw new Error('temporary ownership unavailable');
		});
		// Act / Assert
		expect(await relayOperationFile(input)).toEqual({
			kind: 'failed',
			reason: 'transfer-failed',
			cleanup: 'pending',
		});
		expect(input.destination.removeOwned).toHaveBeenCalledExactlyOnceWith(
			'operation-1/incoming.part',
		);
	});
});
