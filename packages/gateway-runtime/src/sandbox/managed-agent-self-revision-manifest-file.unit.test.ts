import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	MANAGED_AGENT_SELF_REVISION_MANIFEST_FILE_NAME,
	readManagedAgentSelfRevisionManifestFile,
	writeManagedAgentSelfRevisionManifestFile,
} from './managed-agent-self-revision-manifest-file.js';

describe('managed agent self revision manifest file', () => {
	const temporaryRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryRoots.splice(0).map(async (temporaryRoot) => {
				await rm(temporaryRoot, { force: true, recursive: true });
			}),
		);
	});

	async function createWorkspaceRoot(): Promise<string> {
		const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'managed-self-manifest-'));
		temporaryRoots.push(workspaceRoot);
		return workspaceRoot;
	}

	it('atomically writes, flushes, closes, renames, and reads the bounded manifest', async () => {
		const workspaceRoot = await createWorkspaceRoot();
		const manifest = {
			contentDigest: `sha256:${'a'.repeat(64)}`,
			profileAssignmentRevision: 'assignment-v1',
			revision: 7,
		} as const;

		await writeManagedAgentSelfRevisionManifestFile({ manifest, workspaceRoot });

		const manifestPath = path.join(workspaceRoot, MANAGED_AGENT_SELF_REVISION_MANIFEST_FILE_NAME);
		expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
		await expect(readManagedAgentSelfRevisionManifestFile({ workspaceRoot })).resolves.toEqual(
			manifest,
		);
		expect((await readFile(manifestPath, 'utf8')).endsWith('\n')).toBe(true);
	});

	it('rejects the retired root write option', async () => {
		const workspaceRoot = await createWorkspaceRoot();
		const manifest = {
			contentDigest: `sha256:${'a'.repeat(64)}`,
			profileAssignmentRevision: 'assignment-v1',
			revision: 7,
		} as const;

		await expect(
			writeManagedAgentSelfRevisionManifestFile({
				manifest,
				// @ts-expect-error -- the retired root option is not accepted.
				selfRoot: workspaceRoot,
			}),
		).rejects.toThrow('Managed agent workspace root must be absolute.');
	});

	it('orders file flush and handle close before rename, then flushes the parent directory', async () => {
		const calls: string[] = [];
		await writeManagedAgentSelfRevisionManifestFile(
			{
				manifest: {
					contentDigest: `sha256:${'b'.repeat(64)}`,
					profileAssignmentRevision: 'assignment-v1',
					revision: 1,
				},
				workspaceRoot: '/agent',
			},
			{
				fileOperations: {
					openDirectory: async () => ({
						close: async () => {
							calls.push('close-directory');
						},
						sync: async () => {
							calls.push('sync-directory');
						},
					}),
					openTemporaryFile: async () => ({
						close: async () => {
							calls.push('close-file');
						},
						sync: async () => {
							calls.push('sync-file');
						},
						writeFile: async () => {
							calls.push('write-file');
						},
					}),
					rename: async () => {
						calls.push('rename');
					},
					remove: async () => {
						calls.push('remove-temporary');
					},
				},
			},
		);

		expect(calls).toEqual([
			'write-file',
			'sync-file',
			'close-file',
			'rename',
			'sync-directory',
			'close-directory',
			'remove-temporary',
		]);
	});

	it('closes and removes the temporary file when rename fails', async () => {
		const calls: string[] = [];
		await expect(
			writeManagedAgentSelfRevisionManifestFile(
				{
					manifest: {
						contentDigest: `sha256:${'c'.repeat(64)}`,
						profileAssignmentRevision: 'assignment-v1',
						revision: 1,
					},
					workspaceRoot: '/agent',
				},
				{
					fileOperations: {
						openDirectory: async () => {
							throw new Error('directory must not open');
						},
						openTemporaryFile: async () => ({
							close: async () => {
								calls.push('close-file');
							},
							sync: async () => {
								calls.push('sync-file');
							},
							writeFile: async () => {
								calls.push('write-file');
							},
						}),
						rename: async () => {
							calls.push('rename');
							throw new Error('rename failed');
						},
						remove: async () => {
							calls.push('remove-temporary');
						},
					},
				},
			),
		).rejects.toThrow('rename failed');
		expect(calls).toEqual(['write-file', 'sync-file', 'close-file', 'rename', 'remove-temporary']);
	});

	it('rejects oversized or malformed manifest files', async () => {
		const workspaceRoot = await createWorkspaceRoot();
		const manifestPath = path.join(workspaceRoot, MANAGED_AGENT_SELF_REVISION_MANIFEST_FILE_NAME);
		await writeFile(manifestPath, 'x'.repeat(8192));

		await expect(readManagedAgentSelfRevisionManifestFile({ workspaceRoot })).rejects.toThrow(
			/bounded/u,
		);
		await rm(manifestPath);
		await expect(access(manifestPath)).rejects.toThrow();
		await writeFile(manifestPath, '{"schemaVersion":2}\n');
		await expect(readManagedAgentSelfRevisionManifestFile({ workspaceRoot })).rejects.toThrow(
			/manifest/u,
		);
	});
});
