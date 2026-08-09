import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type ControllerOwnershipLockErrorCode =
	| 'controller-already-active'
	| 'ownership-lock-storage-unsafe';

export class ControllerOwnershipLockError extends Error {
	public constructor(
		public readonly code: ControllerOwnershipLockErrorCode,
		options: { readonly cause?: unknown } = {},
	) {
		super(`Controller ownership lock refused operation: ${code}`, options);
		this.name = 'ControllerOwnershipLockError';
	}
}

export interface ControllerOwnershipLock {
	release(): Promise<void>;
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExistingPathError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function assertDirectoryWithoutSymlink(directoryPath: string): Promise<void> {
	try {
		const status = await lstat(directoryPath);
		if (!status.isDirectory() || status.isSymbolicLink()) {
			throw new ControllerOwnershipLockError('ownership-lock-storage-unsafe');
		}
	} catch (error) {
		if (!isMissingPathError(error)) {
			throw error;
		}
		await mkdir(directoryPath, { mode: 0o700, recursive: true });
		const createdStatus = await lstat(directoryPath);
		if (!createdStatus.isDirectory() || createdStatus.isSymbolicLink()) {
			throw new ControllerOwnershipLockError('ownership-lock-storage-unsafe');
		}
	}
}

async function prepareControllerOwnershipLockPath(runtimeDirectory: string): Promise<string> {
	if (!path.isAbsolute(runtimeDirectory)) {
		throw new ControllerOwnershipLockError('ownership-lock-storage-unsafe');
	}
	const canonicalRuntimeDirectory = path.resolve(runtimeDirectory);
	await assertDirectoryWithoutSymlink(canonicalRuntimeDirectory);
	const ownershipDirectory = path.join(canonicalRuntimeDirectory, 'vm-ownership');
	await assertDirectoryWithoutSymlink(ownershipDirectory);
	await chmod(ownershipDirectory, 0o700);

	const lockPath = path.join(ownershipDirectory, 'controller-ownership.lock');
	try {
		const lockFile = await open(lockPath, 'wx', 0o600);
		await lockFile.close();
	} catch (error) {
		if (!isExistingPathError(error)) {
			throw error;
		}
	}
	const lockStatus = await lstat(lockPath);
	if (!lockStatus.isFile() || lockStatus.isSymbolicLink()) {
		throw new ControllerOwnershipLockError('ownership-lock-storage-unsafe');
	}
	await chmod(lockPath, 0o600);
	return lockPath;
}

export async function acquireControllerOwnershipLock(options: {
	readonly runtimeDirectory: string;
}): Promise<ControllerOwnershipLock> {
	const lockPath = await prepareControllerOwnershipLockPath(options.runtimeDirectory);
	const { DatabaseSync } = await import('node:sqlite');
	let lockDatabase: DatabaseSync;
	try {
		lockDatabase = new DatabaseSync(lockPath);
	} catch (error) {
		throw new ControllerOwnershipLockError('ownership-lock-storage-unsafe', { cause: error });
	}
	let transactionAcquired = false;
	try {
		lockDatabase.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
		transactionAcquired = true;
	} catch (error) {
		const acquisitionError =
			error instanceof Error && /database is locked/iu.test(error.message)
				? new ControllerOwnershipLockError('controller-already-active', { cause: error })
				: new ControllerOwnershipLockError('ownership-lock-storage-unsafe', { cause: error });
		try {
			lockDatabase.close();
		} catch (closeError) {
			// oxlint-disable-next-line preserve-caught-error -- AggregateError.errors preserves closeError while cause retains the primary acquisition failure.
			throw new AggregateError(
				[acquisitionError, closeError],
				'Controller ownership lock acquisition and cleanup both failed',
				{ cause: error },
			);
		}
		throw acquisitionError;
	}

	let released = false;
	return {
		async release(): Promise<void> {
			if (released) {
				return;
			}
			released = true;
			let commitError: unknown;
			if (transactionAcquired) {
				try {
					lockDatabase.exec('COMMIT;');
				} catch (error) {
					commitError = error;
				}
			}
			let closeError: unknown;
			try {
				lockDatabase.close();
			} catch (error) {
				closeError = error;
			}
			if (commitError !== undefined && closeError !== undefined) {
				throw new AggregateError(
					[commitError, closeError],
					'Controller ownership lock release failed in multiple steps',
					{ cause: commitError },
				);
			}
			if (commitError !== undefined) {
				throw commitError;
			}
			if (closeError !== undefined) {
				throw closeError;
			}
		},
	};
}
