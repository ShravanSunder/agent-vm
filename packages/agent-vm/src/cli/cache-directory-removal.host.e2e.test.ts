import { execFile } from 'node:child_process';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
	cacheDirectoryRemovalScript,
	removeDeploymentCacheDirectory,
} from './cache-directory-removal.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRemovalFixture(): Promise<{
	readonly root: string;
	readonly target: string;
	readonly protectedDirectory: string;
}> {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cache-descriptor-proof-')));
	temporaryDirectories.push(root);
	const target = path.join(root, 'cache', 'zones', 'worker', 'framework-cache');
	const protectedDirectory = path.join(root, 'durable');
	await Promise.all([
		mkdir(path.join(target, 'nested'), { recursive: true }),
		mkdir(protectedDirectory),
	]);
	await Promise.all([
		writeFile(path.join(target, 'nested', 'entry'), 'cache'),
		writeFile(path.join(protectedDirectory, 'protected'), 'durable'),
	]);
	return { root, target, protectedDirectory };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map(async (directory) => await rm(directory, { recursive: true, force: true })),
	);
});

describe('descriptor-anchored cache removal', () => {
	it('keeps deleting the opened directory when an ancestor is replaced after opening', async () => {
		const { root, target, protectedDirectory } = await createRemovalFixture();
		const ancestor = path.join(root, 'cache', 'zones');
		await mkdir(path.join(protectedDirectory, 'worker', 'framework-cache'), { recursive: true });
		await writeFile(
			path.join(protectedDirectory, 'worker', 'framework-cache', 'protected'),
			'durable',
		);
		const substitutionScript = `
import os
import sys
original_fchdir = os.fchdir
def substitute_ancestor(descriptor):
    os.rename(sys.argv[2], sys.argv[2] + "-original")
    os.symlink(sys.argv[3], sys.argv[2])
    original_fchdir(descriptor)
os.fchdir = substitute_ancestor
`;

		await execFileAsync('python3', [
			'-I',
			'-c',
			substitutionScript + cacheDirectoryRemovalScript,
			target,
			ancestor,
			protectedDirectory,
		]);

		await expect(
			readFile(path.join(protectedDirectory, 'worker', 'framework-cache', 'protected'), 'utf8'),
		).resolves.toBe('durable');
		await expect(
			access(path.join(`${ancestor}-original`, 'worker', 'framework-cache')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('refuses a descendant substituted with a symlink at recursive deletion', async () => {
		const { target, protectedDirectory } = await createRemovalFixture();
		const substitutionScript = `
import os
import shutil
import sys
original_rmtree = shutil.rmtree
def substitute_descendant(directory):
    os.rename(directory, directory + "-original")
    os.symlink(sys.argv[2], directory)
    original_rmtree(directory)
substitute_descendant.avoids_symlink_attacks = original_rmtree.avoids_symlink_attacks
shutil.rmtree = substitute_descendant
`;

		await expect(
			execFileAsync('python3', [
				'-I',
				'-c',
				substitutionScript + cacheDirectoryRemovalScript,
				target,
				protectedDirectory,
			]),
		).rejects.toThrow();

		await expect(readFile(path.join(protectedDirectory, 'protected'), 'utf8')).resolves.toBe(
			'durable',
		);
		await expect(readFile(path.join(target, 'nested-original', 'entry'), 'utf8')).resolves.toBe(
			'cache',
		);
	});

	it('fails before deletion when symlink-resistant recursion is unavailable', async () => {
		const { target } = await createRemovalFixture();
		const unsupportedScript = 'import shutil\nshutil.rmtree.avoids_symlink_attacks = False\n';

		await expect(
			execFileAsync('python3', [
				'-I',
				'-c',
				unsupportedScript + cacheDirectoryRemovalScript,
				target,
			]),
		).rejects.toThrow();

		await expect(readFile(path.join(target, 'nested', 'entry'), 'utf8')).resolves.toBe('cache');
	});

	it('unlinks internal symlinks without deleting their targets', async () => {
		const { root, target, protectedDirectory } = await createRemovalFixture();
		await symlink(protectedDirectory, path.join(target, 'linked'));

		await removeDeploymentCacheDirectory(path.join(root, 'cache'), target);

		await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readFile(path.join(protectedDirectory, 'protected'), 'utf8')).resolves.toBe(
			'durable',
		);
	});
});
