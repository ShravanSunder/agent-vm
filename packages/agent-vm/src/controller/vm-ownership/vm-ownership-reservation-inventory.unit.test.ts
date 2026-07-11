import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listManagedVmOwnershipReservationPaths } from './vm-ownership-reservation-inventory.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-reservation-inventory-'));
	temporaryDirectories.push(temporaryDirectory);
	return temporaryDirectory;
}

async function createPrivateReservation(
	reservationRoot: string,
	reservationId: string,
): Promise<string> {
	const reservationDirectory = path.join(reservationRoot, reservationId);
	const reservationPath = path.join(reservationDirectory, 'reservation-v1.json');
	await mkdir(reservationDirectory, { mode: 0o700, recursive: true });
	await chmod(reservationRoot, 0o700);
	await chmod(reservationDirectory, 0o700);
	await writeFile(reservationPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
	await chmod(reservationPath, 0o600);
	return reservationPath;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (temporaryDirectory) => {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}),
	);
});

describe('listManagedVmOwnershipReservationPaths', () => {
	it('returns an empty inventory when the reservation root does not exist', async () => {
		const temporaryDirectory = await createTemporaryDirectory();

		await expect(
			listManagedVmOwnershipReservationPaths(path.join(temporaryDirectory, 'missing')),
		).resolves.toEqual([]);
	});

	it('returns sorted reservation paths from a private canonical inventory', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const reservationRoot = path.join(temporaryDirectory, 'reservations');
		const reservationB = await createPrivateReservation(reservationRoot, 'reservation-b');
		const reservationA = await createPrivateReservation(reservationRoot, 'reservation-a');

		await expect(listManagedVmOwnershipReservationPaths(reservationRoot)).resolves.toEqual([
			reservationA,
			reservationB,
		]);
	});

	it('refuses a symbolic-link or non-directory reservation root', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const privateDirectory = path.join(temporaryDirectory, 'private-directory');
		const symbolicLinkRoot = path.join(temporaryDirectory, 'symbolic-link-root');
		const regularFileRoot = path.join(temporaryDirectory, 'regular-file-root');
		await mkdir(privateDirectory, { mode: 0o700 });
		await symlink(privateDirectory, symbolicLinkRoot);
		await writeFile(regularFileRoot, 'not a directory\n', { encoding: 'utf8', mode: 0o600 });

		await expect(listManagedVmOwnershipReservationPaths(symbolicLinkRoot)).rejects.toThrow(
			/not a private directory/u,
		);
		await expect(listManagedVmOwnershipReservationPaths(regularFileRoot)).rejects.toThrow(
			/not a private directory/u,
		);
	});

	it('refuses unexpected regular-file and symbolic-link entries under the root', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const regularEntryRoot = path.join(temporaryDirectory, 'regular-entry-root');
		const symbolicLinkEntryRoot = path.join(temporaryDirectory, 'symbolic-link-entry-root');
		const symbolicLinkTarget = path.join(temporaryDirectory, 'symbolic-link-target');
		await mkdir(regularEntryRoot, { mode: 0o700 });
		await mkdir(symbolicLinkEntryRoot, { mode: 0o700 });
		await mkdir(symbolicLinkTarget, { mode: 0o700 });
		await writeFile(path.join(regularEntryRoot, 'unexpected.txt'), 'unexpected\n', {
			encoding: 'utf8',
			mode: 0o600,
		});
		await symlink(symbolicLinkTarget, path.join(symbolicLinkEntryRoot, 'reservation-link'));

		await expect(listManagedVmOwnershipReservationPaths(regularEntryRoot)).rejects.toThrow(
			/Unexpected VM ownership reservation entry/u,
		);
		await expect(listManagedVmOwnershipReservationPaths(symbolicLinkEntryRoot)).rejects.toThrow(
			/Unexpected VM ownership reservation entry/u,
		);
	});

	it('refuses a non-regular or symbolic-link reservation file', async () => {
		const temporaryDirectory = await createTemporaryDirectory();
		const directoryFileRoot = path.join(temporaryDirectory, 'directory-file-root');
		const symbolicLinkFileRoot = path.join(temporaryDirectory, 'symbolic-link-file-root');
		const directoryReservation = path.join(directoryFileRoot, 'reservation-directory');
		const symbolicLinkReservation = path.join(symbolicLinkFileRoot, 'reservation-link');
		const symbolicLinkTarget = path.join(temporaryDirectory, 'reservation-target.json');
		await mkdir(directoryReservation, { mode: 0o700, recursive: true });
		await mkdir(path.join(directoryReservation, 'reservation-v1.json'), { mode: 0o700 });
		await mkdir(symbolicLinkReservation, { mode: 0o700, recursive: true });
		await writeFile(symbolicLinkTarget, '{}\n', { encoding: 'utf8', mode: 0o600 });
		await symlink(symbolicLinkTarget, path.join(symbolicLinkReservation, 'reservation-v1.json'));

		await expect(listManagedVmOwnershipReservationPaths(directoryFileRoot)).rejects.toThrow(
			/not a regular file/u,
		);
		await expect(listManagedVmOwnershipReservationPaths(symbolicLinkFileRoot)).rejects.toThrow(
			/not a regular file/u,
		);
	});

	it.each([
		{ privateSegment: 'root', unsafeMode: 0o755 },
		{ privateSegment: 'reservation-directory', unsafeMode: 0o750 },
		{ privateSegment: 'reservation-file', unsafeMode: 0o640 },
	] as const)(
		'refuses non-private $privateSegment permissions',
		async ({ privateSegment, unsafeMode }) => {
			const temporaryDirectory = await createTemporaryDirectory();
			const reservationRoot = path.join(temporaryDirectory, privateSegment);
			const reservationPath = await createPrivateReservation(reservationRoot, 'reservation-a');
			const unsafePath =
				privateSegment === 'root'
					? reservationRoot
					: privateSegment === 'reservation-directory'
						? path.dirname(reservationPath)
						: reservationPath;
			await chmod(unsafePath, unsafeMode);

			await expect(listManagedVmOwnershipReservationPaths(reservationRoot)).rejects.toThrow();
		},
	);
});
