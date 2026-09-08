import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	copySharedStagingFile,
	readSharedStagingFile,
	writeSharedStagingBytes,
	writeSharedStagingInput,
} from './shared-staging-file-copy.js';

const roots: string[] = [];
async function fixture(): Promise<{ sourceRoot: string; destinationRoot: string; root: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'shared-staging-copy-'));
	roots.push(root);
	const sourceRoot = path.join(root, 'source');
	const destinationRoot = path.join(root, 'destination');
	await mkdir(sourceRoot);
	await mkdir(destinationRoot);
	return { root, sourceRoot, destinationRoot };
}
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

describe('host RealFS staging publication bytes', () => {
	it.each(['source-error', 'cancelled', 'short', 'long', 'digest-mismatch'] as const)(
		'cleans an unverified input after %s without touching its sibling',
		async (failure) => {
			// Arrange
			const current = await fixture();
			const abort = new AbortController();
			const bytes = new Uint8Array([0, 255, 1]);
			await writeFile(path.join(current.destinationRoot, 'sentinel'), 'keep');
			const contents = (async function* (): AsyncIterable<Uint8Array> {
				yield bytes;
				if (failure === 'source-error') throw new Error('source failed');
				if (failure === 'cancelled') abort.abort();
				if (failure === 'long') yield bytes;
			})();
			// Act / Assert
			await expect(
				writeSharedStagingInput({
					destinationRoot: current.destinationRoot,
					relativePath: 'input.bin',
					contents,
					expected: {
						byteLength: failure === 'short' ? 4 : 3,
						sha256:
							failure === 'digest-mismatch'
								? '0'.repeat(64)
								: createHash('sha256').update(bytes).digest('hex'),
					},
					signal: abort.signal,
				}),
			).rejects.toThrow();
			await expect(readFile(path.join(current.destinationRoot, 'input.bin'))).rejects.toMatchObject(
				{ code: 'ENOENT' },
			);
			expect(await readFile(path.join(current.destinationRoot, 'sentinel'), 'utf8')).toBe('keep');
		},
	);

	it('stages verified binary input with exclusive destination creation', async () => {
		// Arrange
		const current = await fixture();
		const bytes = new Uint8Array([0, 255, 128, 10]);
		const request = {
			destinationRoot: current.destinationRoot,
			relativePath: 'nested/input.bin',
			expected: {
				byteLength: bytes.length,
				sha256: createHash('sha256').update(bytes).digest('hex'),
			},
			signal: new AbortController().signal,
		};
		const contents = async function* (): AsyncIterable<Uint8Array> {
			yield bytes;
		};
		// Act
		await writeSharedStagingInput({ ...request, contents: contents() });
		// Assert
		expect(await readFile(path.join(current.destinationRoot, request.relativePath))).toEqual(
			Buffer.from(bytes),
		);
		await expect(
			writeSharedStagingInput({ ...request, contents: contents() }),
		).rejects.toMatchObject({ code: 'EEXIST' });
	});

	it.each(['source-error', 'cancelled', 'size-limit'] as const)(
		'cleans attachment sink after %s',
		async (failure) => {
			// Arrange
			const current = await fixture();
			const abort = new AbortController();
			const contents = (async function* (): AsyncIterable<Uint8Array> {
				yield new Uint8Array([1]);
				if (failure === 'source-error') throw new Error('source failed');
				if (failure === 'cancelled') abort.abort();
				if (failure === 'size-limit') {
					const chunk = new Uint8Array(64 * 1024);
					for (let index = 0; index < 256; index += 1) yield chunk;
				}
			})();
			// Act / Assert
			await expect(
				writeSharedStagingBytes({
					destinationRoot: current.destinationRoot,
					relativePath: 'attachment.bin',
					contents,
					signal: abort.signal,
				}),
			).rejects.toThrow();
			await expect(
				readFile(path.join(current.destinationRoot, 'attachment.bin')),
			).rejects.toMatchObject({ code: 'ENOENT' });
		},
	);

	it('reads at most one fixed-size chunk per demand and rejects source truncation', async () => {
		// Arrange
		const current = await fixture();
		const filename = path.join(current.sourceRoot, 'report.bin');
		await writeFile(filename, new Uint8Array(128 * 1024));
		const reader = readSharedStagingFile({
			root: current.sourceRoot,
			relativePath: 'report.bin',
			signal: new AbortController().signal,
		})[Symbol.asyncIterator]();
		// Act / Assert
		const first = await reader.next();
		expect(first.value?.byteLength).toBe(64 * 1024);
		await writeFile(filename, new Uint8Array());
		await expect(reader.next()).rejects.toThrow();
	});

	it('copies binary bytes to a separate inode and preserves them after producer mutation', async () => {
		// Arrange
		const current = await fixture();
		const content = Buffer.from([0, 255, 128, 13, 10]);
		await writeFile(path.join(current.sourceRoot, 'report.bin'), content);
		const producer = await open(path.join(current.sourceRoot, 'report.bin'), 'r+');
		try {
			// Act
			const result = await copySharedStagingFile({
				...current,
				relativePath: 'report.bin',
				signal: new AbortController().signal,
			});
			await producer.write(Buffer.from('xxxxx'), 0, 5, 0);
			// Assert
			expect(result).toEqual({
				byteLength: 5,
				sha256: createHash('sha256').update(content).digest('hex'),
			});
			expect(await readFile(path.join(current.destinationRoot, 'report.bin'))).toEqual(content);
		} finally {
			await producer.close();
		}
	});

	it.each(['../outside', '/outside', 'a/../outside', 'a//file', 'a\\file'])(
		'rejects path %s without touching sentinels',
		async (relativePath) => {
			// Arrange
			const current = await fixture();
			const sentinel = path.join(current.root, 'outside');
			await writeFile(sentinel, 'untouched');
			// Act / Assert
			await expect(
				copySharedStagingFile({ ...current, relativePath, signal: new AbortController().signal }),
			).rejects.toThrow();
			expect(await readFile(sentinel, 'utf8')).toBe('untouched');
		},
	);

	it.each(['leaf', 'parent'])('rejects a %s symlink', async (kind) => {
		// Arrange
		const current = await fixture();
		await writeFile(path.join(current.root, 'outside'), 'private');
		await symlink(kind === 'leaf' ? '../outside' : '..', path.join(current.sourceRoot, 'link'));
		// Act / Assert
		await expect(
			copySharedStagingFile({
				...current,
				relativePath: kind === 'leaf' ? 'link' : 'link/outside',
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
	});

	it('preserves an existing destination and accepts an empty source', async () => {
		// Arrange
		const current = await fixture();
		await writeFile(path.join(current.sourceRoot, 'empty'), '');
		await writeFile(path.join(current.destinationRoot, 'empty'), 'existing');
		// Act / Assert
		await expect(
			copySharedStagingFile({
				...current,
				relativePath: 'empty',
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
		expect(await readFile(path.join(current.destinationRoot, 'empty'), 'utf8')).toBe('existing');
		await rm(path.join(current.destinationRoot, 'empty'));
		expect(
			await copySharedStagingFile({
				...current,
				relativePath: 'empty',
				signal: new AbortController().signal,
			}),
		).toMatchObject({ byteLength: 0 });
	});
});
