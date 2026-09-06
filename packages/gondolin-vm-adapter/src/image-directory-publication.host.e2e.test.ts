import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { publishImageDirectory } from './image-directory-publication.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { recursive: true, force: true })),
	);
});

describe('native no-replace image publication', () => {
	it.each(['empty-directory', 'nonempty-directory', 'dangling-symlink'])(
		'preserves an existing %s destination',
		async (destinationKind) => {
			const root = await mkdtemp(path.join(os.tmpdir(), 'image-no-replace-'));
			temporaryDirectories.push(root);
			const stagingPath = path.join(root, 'staging');
			const finalPath = path.join(root, 'final');
			await mkdir(stagingPath);
			await writeFile(path.join(stagingPath, 'complete'), 'staged');
			if (destinationKind === 'dangling-symlink') await symlink('absent', finalPath);
			else await mkdir(finalPath);
			if (destinationKind === 'nonempty-directory')
				await writeFile(path.join(finalPath, 'evidence'), 'preserve');

			await expect(publishImageDirectory(stagingPath, finalPath)).rejects.toMatchObject({
				code: 'EEXIST',
			});
			await expect(readFile(path.join(stagingPath, 'complete'), 'utf8')).resolves.toBe('staged');
			if (destinationKind === 'empty-directory')
				await expect(readdir(finalPath)).resolves.toEqual([]);
			if (destinationKind === 'nonempty-directory')
				await expect(readFile(path.join(finalPath, 'evidence'), 'utf8')).resolves.toBe('preserve');
		},
	);
	it('publishes one complete directory without replacement under concurrent processes', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-no-replace-race-'));
		temporaryDirectories.push(root);
		const firstPath = path.join(root, 'first');
		const secondPath = path.join(root, 'second');
		const finalPath = path.join(root, 'final');
		await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
		await Promise.all([
			writeFile(path.join(firstPath, 'asset'), 'first'),
			writeFile(path.join(secondPath, 'asset'), 'second'),
		]);

		const results = await Promise.allSettled([
			publishImageDirectory(firstPath, finalPath),
			publishImageDirectory(secondPath, finalPath),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(['first', 'second']).toContain(await readFile(path.join(finalPath, 'asset'), 'utf8'));
	});
});
