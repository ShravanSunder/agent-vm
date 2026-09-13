import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listSharedStagingFiles } from './shared-staging-manifest.js';

const ownedRoots: string[] = [];
async function createRoot(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'shared-staging-manifest-'));
	ownedRoots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(
		ownedRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

describe('bounded stopped-producer manifest', () => {
	it('lists regular nested files without following symlinks or treating directories as files', async () => {
		// Arrange
		const root = await createRoot();
		await mkdir(path.join(root, 'nested'));
		await writeFile(path.join(root, 'report'), 'bytes');
		await writeFile(path.join(root, 'nested', 'part'), 'partial');
		await symlink('nested', path.join(root, 'alias'));
		// Act
		const result = await listSharedStagingFiles(root, new AbortController().signal);
		// Assert
		expect(result.regularFiles.toSorted()).toEqual(['nested/part', 'report']);
		expect(result.unsupportedPaths).toEqual(['alias']);
	});

	it('rejects excessive depth without an unbounded recursive traversal', async () => {
		// Arrange
		const root = await createRoot();
		await mkdir(path.join(root, ...Array.from({ length: 33 }, () => 'child')), { recursive: true });
		// Act / Assert
		await expect(listSharedStagingFiles(root, new AbortController().signal)).rejects.toMatchObject({
			reason: 'invalid-path',
		});
	});

	it('rejects cancellation before opening the producer tree', async () => {
		// Arrange
		const root = await createRoot();
		const abort = new AbortController();
		abort.abort(new Error('cancelled manifest'));
		// Act / Assert
		await expect(listSharedStagingFiles(root, abort.signal)).rejects.toThrow('cancelled manifest');
	});
});
