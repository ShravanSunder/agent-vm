import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	acquireControllerOwnershipLock,
	ControllerOwnershipLockError,
} from './controller-ownership-lock.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-controller-lock-'));
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectory) => {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}),
	);
});

describe('acquireControllerOwnershipLock', () => {
	it('excludes a concurrent owner and permits reacquisition after idempotent release', async () => {
		const runtimeDirectory = await createTemporaryDirectory();
		const firstLock = await acquireControllerOwnershipLock({ runtimeDirectory });

		const conflictError = await acquireControllerOwnershipLock({ runtimeDirectory }).catch(
			(error: unknown) => error,
		);
		expect(conflictError).toBeInstanceOf(ControllerOwnershipLockError);
		expect(conflictError).toMatchObject({ code: 'controller-already-active' });

		await expect(firstLock.release()).resolves.toBeUndefined();
		await expect(firstLock.release()).resolves.toBeUndefined();
		const replacementLock = await acquireControllerOwnershipLock({ runtimeDirectory });
		await expect(replacementLock.release()).resolves.toBeUndefined();
	});

	it('creates private ownership storage and lock-file modes', async () => {
		const runtimeDirectory = await createTemporaryDirectory();
		const lock = await acquireControllerOwnershipLock({ runtimeDirectory });
		try {
			const ownershipDirectory = path.join(runtimeDirectory, 'vm-ownership');
			const lockPath = path.join(ownershipDirectory, 'controller-ownership.lock');

			expect((await stat(ownershipDirectory)).mode & 0o777).toBe(0o700);
			expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
			expect((await lstat(lockPath)).isFile()).toBe(true);
		} finally {
			await lock.release();
		}
	});

	it('refuses symbolic-link ownership storage', async () => {
		const parentDirectory = await createTemporaryDirectory();
		const runtimeDirectory = path.join(parentDirectory, 'runtime');
		const outsideDirectory = path.join(parentDirectory, 'outside');
		await mkdir(runtimeDirectory, { mode: 0o700 });
		await mkdir(outsideDirectory, { mode: 0o700 });
		await symlink(outsideDirectory, path.join(runtimeDirectory, 'vm-ownership'));

		await expect(acquireControllerOwnershipLock({ runtimeDirectory })).rejects.toEqual(
			expect.objectContaining({
				code: 'ownership-lock-storage-unsafe',
				name: 'ControllerOwnershipLockError',
			}),
		);
	});

	it('refuses a symbolic-link or non-file lock path', async () => {
		const parentDirectory = await createTemporaryDirectory();
		const symbolicLinkRuntimeDirectory = path.join(parentDirectory, 'symbolic-link-runtime');
		const directoryLockRuntimeDirectory = path.join(parentDirectory, 'directory-lock-runtime');
		const outsideFile = path.join(parentDirectory, 'outside-lock');
		const unsafeRuntimeDirectories = [
			symbolicLinkRuntimeDirectory,
			directoryLockRuntimeDirectory,
		] as const;
		await Promise.all(
			unsafeRuntimeDirectories.map(
				async (runtimeDirectory) =>
					await mkdir(path.join(runtimeDirectory, 'vm-ownership'), {
						mode: 0o700,
						recursive: true,
					}),
			),
		);
		await writeFile(outsideFile, 'outside\n', { encoding: 'utf8', mode: 0o600 });
		await symlink(
			outsideFile,
			path.join(symbolicLinkRuntimeDirectory, 'vm-ownership', 'controller-ownership.lock'),
		);
		await mkdir(
			path.join(directoryLockRuntimeDirectory, 'vm-ownership', 'controller-ownership.lock'),
			{ mode: 0o700 },
		);

		const storageErrors = await Promise.all(
			unsafeRuntimeDirectories.map(
				async (runtimeDirectory) =>
					await acquireControllerOwnershipLock({ runtimeDirectory }).catch(
						(error: unknown) => error,
					),
			),
		);
		for (const storageError of storageErrors) {
			expect(storageError).toBeInstanceOf(ControllerOwnershipLockError);
			expect(storageError).toMatchObject({ code: 'ownership-lock-storage-unsafe' });
		}
	});
});
