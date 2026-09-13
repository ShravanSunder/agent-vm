import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const pythonExecutable = path.resolve('.venv/bin/python');
const programUrl = new URL('../../guest-programs/operation-folder.py', import.meta.url);
const temporaryRoots: string[] = [];

async function fixture(): Promise<{ readonly directory: string; readonly root: string }> {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'operation-folder-proof-')));
	temporaryRoots.push(directory);
	const root = path.join(directory, 'operation');
	await mkdir(root, { mode: 0o700 });
	return { directory, root };
}

async function runHelper(
	action: string,
	root: string,
	relativePath: string,
	...extra: string[]
): Promise<{ stdout: Buffer; stderr: Buffer }> {
	return await executeFile(
		pythonExecutable,
		[fileURLToPath(programUrl), action, root, relativePath, ...extra],
		{ encoding: 'buffer', maxBuffer: 128 * 1024, timeout: 5_000 },
	);
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
	);
});

describe('fixed application guest filesystem program (real host Python/filesystem)', () => {
	it('reads every byte value and empty files without text conversion', async () => {
		// Arrange
		const { root } = await fixture();
		const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
		await writeFile(path.join(root, 'binary'), bytes);
		await writeFile(path.join(root, 'empty'), '');
		// Act
		const binary = await runHelper('read', root, 'binary');
		const empty = await runHelper('read', root, 'empty');
		// Assert
		expect(binary.stdout).toEqual(bytes);
		expect(binary.stderr.byteLength).toBe(0);
		expect(empty.stdout.byteLength).toBe(0);
	});

	it.each([
		'../outside',
		'/etc/passwd',
		'nested/../outside',
		'nested//file',
		'.',
		'nested/./file',
		'bad\\path',
	])('rejects the noncanonical relative path %s', async (relativePath) => {
		// Arrange
		const { root } = await fixture();
		// Act / Assert
		await expect(runHelper('read', root, relativePath)).rejects.toMatchObject({ code: 64 });
	});

	it('rejects symlink leaves, intermediate directories and the supplied root', async () => {
		// Arrange
		const { directory, root } = await fixture();
		await writeFile(path.join(directory, 'outside'), 'private sentinel');
		await symlink('../outside', path.join(root, 'link'));
		await symlink('..', path.join(root, 'directory-link'));
		await symlink(root, path.join(directory, 'root-link'));
		// Act / Assert
		for (const [selectedRoot, relativePath] of [
			[root, 'link'],
			[root, 'directory-link/outside'],
			[path.join(directory, 'root-link'), 'link'],
		] as const) {
			// oxlint-disable-next-line no-await-in-loop -- each independent escape must fail against the same sentinel.
			await expect(runHelper('read', selectedRoot, relativePath)).rejects.toMatchObject({
				code: 64,
			});
		}
		expect(await readFile(path.join(directory, 'outside'), 'utf8')).toBe('private sentinel');
	});

	it('publishes with a no-replace hard link only after checking size and hash', async () => {
		// Arrange
		const { root } = await fixture();
		const bytes = Buffer.from([0, 255, 1, 128]);
		const hash = createHash('sha256').update(bytes).digest('hex');
		await writeFile(path.join(root, 'incoming.part'), bytes);
		// Act
		const result = await runHelper(
			'publish',
			root,
			'incoming.part',
			'complete.bin',
			String(bytes.length),
			hash,
		);
		// Assert
		expect(JSON.parse(result.stdout.toString('utf8'))).toMatchObject({
			kind: 'published',
			cleanup: 'complete',
		});
		expect(await readFile(path.join(root, 'complete.bin'))).toEqual(bytes);
		await expect(readFile(path.join(root, 'incoming.part'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it.each(['fifo', 'socket', 'directory'] as const)(
		'rejects a real %s without reading bytes or waiting for a producer',
		async (kind) => {
			// Arrange: create actual special filesystem entries, not mocked stat values.
			const { root } = await fixture();
			await executeFile(
				pythonExecutable,
				[
					'-c',
					[
						'import os,socket,sys',
						'os.chdir(sys.argv[1])',
						'kind=sys.argv[2]',
						'if kind == "fifo": os.mkfifo("special")',
						'elif kind == "directory": os.mkdir("special")',
						'else:',
						'    endpoint=socket.socket(socket.AF_UNIX)',
						'    endpoint.bind("special")',
						'    endpoint.close()',
					].join('\n'),
					root,
					kind,
				],
				{ timeout: 5_000 },
			);
			// Act / Assert: a hung FIFO open times out and fails these assertions.
			await expect(runHelper('read', root, 'special')).rejects.toMatchObject({
				code: expect.any(Number),
				killed: false,
				signal: null,
				stdout: Buffer.alloc(0),
				stderr: Buffer.from('operation-file-request-failed\n'),
			});
			const listing = await runHelper('list', root, '');
			expect(JSON.parse(listing.stdout.toString('utf8'))).toEqual({
				entries: [{ name: 'special', kind: kind === 'directory' ? 'directory' : 'unsupported' }],
				limitReached: false,
			});
		},
	);

	it('rejects even an internal symlink and rechecks a file replaced after listing', async () => {
		// Arrange
		const { directory, root } = await fixture();
		await writeFile(path.join(directory, 'outside'), 'outside sentinel');
		await writeFile(path.join(root, 'selected'), 'original');
		await symlink('selected', path.join(root, 'internal-link'));
		await expect(runHelper('read', root, 'internal-link')).rejects.toMatchObject({
			code: 64,
			stdout: Buffer.alloc(0),
		});
		const before = await runHelper('list', root, '');
		expect(JSON.parse(before.stdout.toString('utf8')).entries).toContainEqual({
			name: 'selected',
			kind: 'file',
			byteLength: 8,
		});
		await unlink(path.join(root, 'selected'));
		await symlink('../outside', path.join(root, 'selected'));
		// Act / Assert: a previous listing is never authority to follow a new symlink.
		await expect(runHelper('read', root, 'selected')).rejects.toMatchObject({
			code: 64,
			stdout: Buffer.alloc(0),
		});
		expect(await readFile(path.join(directory, 'outside'), 'utf8')).toBe('outside sentinel');
	});

	it.each(['list', 'read', 'mkdir', 'remove', 'publish'])(
		'rejects an outside parent symlink during %s and preserves outside data',
		async (action) => {
			// Arrange
			const { directory, root } = await fixture();
			const sentinel = Buffer.from('outside sentinel');
			await writeFile(path.join(directory, 'outside'), sentinel);
			await symlink('..', path.join(root, 'outside-link'));
			const selectedPath =
				action === 'list'
					? 'outside-link'
					: action === 'mkdir'
						? 'outside-link/new-directory'
						: 'outside-link/outside';
			const extra =
				action === 'publish'
					? [
							'published',
							String(sentinel.byteLength),
							createHash('sha256').update(sentinel).digest('hex'),
						]
					: [];
			// Act / Assert
			await expect(runHelper(action, root, selectedPath, ...extra)).rejects.toMatchObject({
				code: 64,
				stdout: Buffer.alloc(0),
			});
			expect(await readFile(path.join(directory, 'outside'))).toEqual(sentinel);
			await expect(readFile(path.join(directory, 'published'))).rejects.toMatchObject({
				code: 'ENOENT',
			});
		},
	);

	it.each(['file', 'directory', 'symlink'] as const)(
		'preserves an existing %s destination rather than replacing or writing inside it',
		async (kind) => {
			// Arrange
			const { root } = await fixture();
			const bytes = Buffer.from('new bytes');
			const hash = createHash('sha256').update(bytes).digest('hex');
			await writeFile(path.join(root, 'incoming.part'), bytes);
			if (kind === 'file') await writeFile(path.join(root, 'destination'), 'original');
			if (kind === 'directory') await mkdir(path.join(root, 'destination'));
			if (kind === 'symlink') await symlink('incoming.part', path.join(root, 'destination'));
			// Act / Assert
			await expect(
				runHelper('publish', root, 'incoming.part', 'destination', String(bytes.length), hash),
			).rejects.toMatchObject({ code: 73 });
			expect(await readFile(path.join(root, 'incoming.part'))).toEqual(bytes);
			if (kind === 'file')
				expect(await readFile(path.join(root, 'destination'), 'utf8')).toBe('original');
		},
	);

	it('never publishes bytes that fail the expected digest', async () => {
		// Arrange
		const { root } = await fixture();
		await writeFile(path.join(root, 'incoming.part'), 'changed');
		// Act / Assert
		await expect(
			runHelper('publish', root, 'incoming.part', 'complete', '7', '0'.repeat(64)),
		).rejects.toMatchObject({ code: 74 });
		await expect(readFile(path.join(root, 'complete'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('bounds shallow listings and reports that the limit was reached', async () => {
		// Arrange
		const { root } = await fixture();
		await Promise.all(
			Array.from({ length: 260 }, (_, index) =>
				writeFile(path.join(root, `file-${String(index)}`), 'x'),
			),
		);
		// Act
		const result = await runHelper('list', root, '');
		const parsed: { entries: readonly unknown[]; limitReached: boolean } = JSON.parse(
			result.stdout.toString('utf8'),
		);
		// Assert
		expect(parsed.entries.length).toBeLessThanOrEqual(256);
		expect(parsed.limitReached).toBe(true);
		expect(result.stdout.byteLength).toBeLessThanOrEqual(32 * 1024);
	});
});
