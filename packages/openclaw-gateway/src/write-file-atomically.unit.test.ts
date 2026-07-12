import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFileAtomically } from './write-file-atomically.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'openclaw-atomic-file-'));
	temporaryDirectories.push(directoryPath);
	return directoryPath;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('writeFileAtomically', () => {
	it('writes the requested mode', async () => {
		const directoryPath = await createTemporaryDirectory();
		const filePath = path.join(directoryPath, 'state.json');
		await writeFileAtomically(filePath, 'first', { mode: 0o600 });

		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it('atomically replaces an existing file', async () => {
		const directoryPath = await createTemporaryDirectory();
		const filePath = path.join(directoryPath, 'state.json');
		await writeFileAtomically(filePath, 'first');
		await writeFileAtomically(filePath, 'second');

		expect(await readFile(filePath, 'utf8')).toBe('second');
	});

	it('writes the temporary file beside the target before renaming it', async () => {
		const calls: string[] = [];
		const filePath = '/host/state/session.json';
		await writeFileAtomically(filePath, 'content', {
			fileOperations: {
				rename: async (temporaryFilePath, targetFilePath) => {
					calls.push(`rename:${temporaryFilePath}:${targetFilePath}`);
				},
				rm: async () => undefined,
				writeFile: async (temporaryFilePath) => {
					calls.push(`write:${temporaryFilePath}`);
				},
			},
		});

		expect(calls).toHaveLength(2);
		const temporaryFilePath = calls[0]?.slice('write:'.length);
		expect(path.dirname(temporaryFilePath ?? '')).toBe(path.dirname(filePath));
		expect(calls[1]).toBe(`rename:${temporaryFilePath}:${filePath}`);
	});

	it('removes the temporary file and preserves the rename failure', async () => {
		const renameError = new Error('rename failed');
		let temporaryFilePath: string | undefined;
		let removedFilePath: string | undefined;
		await expect(
			writeFileAtomically('/host/state/session.json', 'content', {
				fileOperations: {
					rename: async () => Promise.reject(renameError),
					rm: async (filePath) => {
						removedFilePath = filePath;
					},
					writeFile: async (filePath) => {
						temporaryFilePath = filePath;
					},
				},
			}),
		).rejects.toBe(renameError);
		expect(removedFilePath).toBe(temporaryFilePath);
	});

	it('reports both rename and cleanup failures', async () => {
		const cleanupError = new Error('cleanup failed');
		const operation = writeFileAtomically('/host/state/session.json', 'content', {
			fileOperations: {
				rename: async () => Promise.reject(new Error('rename failed')),
				rm: async () => Promise.reject(cleanupError),
				writeFile: async () => undefined,
			},
		});

		await expect(operation).rejects.toThrow(
			/Failed to replace.*rename failed.*failed to remove temporary file.*cleanup failed/u,
		);
		await expect(operation).rejects.toMatchObject({ cause: cleanupError });
	});
});
