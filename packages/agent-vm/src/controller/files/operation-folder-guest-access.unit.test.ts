import type {
	ManagedVm,
	ManagedVmExecProcess,
	ManagedVmExecOutputChunk,
} from '@agent-vm/managed-vm';
import { describe, expect, it, vi } from 'vitest';

import {
	assertOperationRelativePath,
	createOperationFolderGuestAccess,
} from './operation-folder-guest-access.js';

function arrange(
	chunks: readonly ManagedVmExecOutputChunk[],
	exitCode = 0,
): {
	readonly exec: ReturnType<typeof vi.fn<ManagedVm['exec']>>;
	readonly files: ReturnType<typeof createOperationFolderGuestAccess>;
	readonly observation: { consumed: number };
} {
	const observation = { consumed: 0 };
	const result = Promise.resolve({
		exitCode,
		ok: exitCode === 0,
		stderr: '',
		stdout: '',
		stderrBuffer: new Uint8Array(),
		stdoutBuffer: new Uint8Array(),
		json: (): never => {
			throw new Error('No buffered payload.');
		},
		lines: () => [],
		toString: () => '',
	});
	const process: ManagedVmExecProcess = Object.assign(result, {
		result,
		write: async () => {},
		end: async () => {},
		resize: () => {},
		[Symbol.asyncIterator]: async function* () {},
		lines: async function* () {},
		output: async function* () {
			for (const chunk of chunks) {
				observation.consumed += 1;
				yield chunk;
			}
		},
	});
	const exec = vi.fn<ManagedVm['exec']>(() => process);
	const files = createOperationFolderGuestAccess({
		vm: { exec },
		root: '/work/operation',
		pythonExecutable: '/usr/local/bin/python3',
		program: 'fixed program',
		signal: new AbortController().signal,
	});
	return { exec, files, observation };
}

describe('operation-folder VM byte access', () => {
	it('starts and consumes file output only on demand, ignoring stderr as payload', async () => {
		// Arrange
		const bytes = new Uint8Array([0, 255, 128]);
		const fixture = arrange([
			{ stream: 'stdout', data: bytes, text: 'not binary' },
			{ stream: 'stderr', data: new Uint8Array([99]), text: 'private diagnostic' },
		]);
		// Act
		const iterable = fixture.files.read('result.bin');
		// Assert
		expect(fixture.exec).not.toHaveBeenCalled();
		const iterator = iterable[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toBe(bytes);
		expect(fixture.observation.consumed).toBe(1);
		expect((await iterator.next()).done).toBe(true);
		expect(fixture.exec).toHaveBeenCalledWith(
			[
				'/usr/local/bin/python3',
				'-I',
				'-c',
				'fixed program',
				'read',
				'/work/operation',
				'result.bin',
			],
			expect.objectContaining({
				output: { stdout: { kind: 'pipe' }, stderr: { kind: 'pipe' } },
				pty: false,
			}),
		);
	});

	it('reports a failed source completion even after its bytes were consumed', async () => {
		// Arrange
		const fixture = arrange([{ stream: 'stdout', data: new Uint8Array([1]), text: '' }], 74);
		// Act / Assert
		const iterator = fixture.files.read('file')[Symbol.asyncIterator]();
		expect((await iterator.next()).done).toBe(false);
		await expect(iterator.next()).rejects.toMatchObject({ reason: 'integrity-mismatch' });
	});

	it.each(['../secret', '/etc/passwd', '.', 'a//b', 'a/../b', 'bad\\path', 'bad\npath'])(
		'rejects %s before launching a process',
		(relativePath) => {
			// Arrange / Act / Assert
			expect(() => assertOperationRelativePath(relativePath)).toThrow();
		},
	);

	it('rejects an unbounded metadata response', async () => {
		// Arrange
		const fixture = arrange([{ stream: 'stdout', data: new Uint8Array(32 * 1024 + 1), text: '' }]);
		// Act / Assert
		await expect(fixture.files.list('')).rejects.toMatchObject({ reason: 'size-limit' });
	});

	it.each([
		'../secret',
		'/etc/passwd',
		'nested/../../secret',
		'nested//file',
		'nested/./file',
		'bad\\path',
		'bad\0path',
		'bad\npath',
		'bad\u007fpath',
		'📁'.repeat(64),
		`${'nested/'.repeat(33)}file`,
	])('rejects %j at every filesystem operation before VM dispatch', async (relativePath) => {
		// Arrange: exercise the actual wrapper methods, not only the path predicate.
		const fixture = arrange([]);
		const invalid = { reason: 'invalid-path' };
		// Act / Assert
		await expect(
			fixture.files.read(relativePath)[Symbol.asyncIterator]().next(),
		).rejects.toMatchObject(invalid);
		await expect(fixture.files.list(relativePath)).rejects.toMatchObject(invalid);
		await expect(fixture.files.createDirectory(relativePath)).rejects.toMatchObject(invalid);
		await expect(fixture.files.removeOwned(relativePath)).rejects.toMatchObject(invalid);
		await expect(
			fixture.files.publish({
				temporaryRelativePath: relativePath,
				finalName: 'complete.bin',
				byteLength: 0,
				sha256: 'a'.repeat(64),
			}),
		).rejects.toMatchObject(invalid);
		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it.each(['../outside', '/outside', 'nested/file', 'bad\0name'])(
		'rejects publication name %j before VM dispatch',
		async (finalName) => {
			// Arrange
			const fixture = arrange([]);
			// Act / Assert
			await expect(
				fixture.files.publish({
					temporaryRelativePath: 'incoming.part',
					finalName,
					byteLength: 0,
					sha256: 'a'.repeat(64),
				}),
			).rejects.toMatchObject({ reason: 'invalid-path' });
			expect(fixture.exec).not.toHaveBeenCalled();
		},
	);
});
