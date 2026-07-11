import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const ownershipReservationFileName = 'reservation-v1.json';

function permissionMode(status: { readonly mode: number }): number {
	return status.mode & 0o777;
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function standaloneVmOwnershipReservationRoot(runtimeDirectory: string): string {
	return path.join(path.resolve(runtimeDirectory), 'vm-ownership', 'standalone-reservations');
}

export async function listManagedVmOwnershipReservationPaths(
	reservationRoot: string,
): Promise<readonly string[]> {
	const canonicalReservationRoot = path.resolve(reservationRoot);
	try {
		const rootStatus = await lstat(canonicalReservationRoot);
		if (
			!rootStatus.isDirectory() ||
			rootStatus.isSymbolicLink() ||
			permissionMode(rootStatus) !== 0o700
		) {
			throw new Error(
				`VM ownership reservation root '${canonicalReservationRoot}' is not a private directory.`,
			);
		}
	} catch (error) {
		if (isMissingPathError(error)) {
			return [];
		}
		throw error;
	}

	const entries = await readdir(canonicalReservationRoot, { withFileTypes: true });
	const reservationPaths: string[] = [];
	for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(
				`Unexpected VM ownership reservation entry '${entry.name}' under '${canonicalReservationRoot}'.`,
			);
		}
		const reservationPath = path.join(
			canonicalReservationRoot,
			entry.name,
			ownershipReservationFileName,
		);
		// oxlint-disable-next-line no-await-in-loop -- each security-sensitive path is validated before it is admitted to the returned inventory.
		const reservationDirectoryStatus = await lstat(path.join(canonicalReservationRoot, entry.name));
		if (
			!reservationDirectoryStatus.isDirectory() ||
			reservationDirectoryStatus.isSymbolicLink() ||
			permissionMode(reservationDirectoryStatus) !== 0o700
		) {
			throw new Error(`VM ownership reservation directory '${entry.name}' is not private.`);
		}
		// oxlint-disable-next-line no-await-in-loop -- preserve deterministic path-by-path validation and first unsafe-entry reporting.
		const reservationStatus = await lstat(reservationPath);
		if (
			!reservationStatus.isFile() ||
			reservationStatus.isSymbolicLink() ||
			permissionMode(reservationStatus) !== 0o600
		) {
			throw new Error(`VM ownership reservation '${reservationPath}' is not a regular file.`);
		}
		reservationPaths.push(reservationPath);
	}
	return reservationPaths;
}
