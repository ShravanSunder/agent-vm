import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
	lstat: vi.fn(),
	realpath: vi.fn(),
	mkdir: vi.fn(),
	open: vi.fn(),
	unlink: vi.fn(),
}));
vi.mock('node:fs/promises', () => filesystem);

import { writeSharedStagingBytes } from './shared-staging-file-copy.js';

afterEach(() => vi.resetAllMocks());

describe('shared staging sink backpressure', () => {
	it('does not request more source bytes while the destination write is stalled', async () => {
		// Arrange: real sink loop with a paused filesystem write, no disk or timers.
		filesystem.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false });
		filesystem.realpath.mockResolvedValue('/owned-staging');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const file = {
			close: vi.fn(async () => {}),
			write: vi.fn(async (_chunk: Uint8Array, _offset: number, length: number) => {
				entered.resolve();
				await release.promise;
				return { bytesWritten: length };
			}),
		};
		filesystem.open.mockResolvedValue(file);
		let producedChunks = 0;
		const chunk = new Uint8Array(64 * 1024);
		const contents = (async function* (): AsyncIterable<Uint8Array> {
			for (let index = 0; index < 256; index += 1) {
				producedChunks += 1;
				yield chunk;
			}
		})();
		// Act
		const writing = writeSharedStagingBytes({
			destinationRoot: '/owned-staging',
			relativePath: 'file',
			contents,
			signal: new AbortController().signal,
		});
		await entered.promise;
		// Assert: 16 MiB total, but only one 64 KiB source chunk requested at the stall.
		try {
			expect(producedChunks).toBe(1);
		} finally {
			release.resolve();
		}
		await writing;
		expect(producedChunks).toBe(256);
		expect(file.write).toHaveBeenCalledTimes(256);
		expect(filesystem.unlink).not.toHaveBeenCalled();
	});
});
