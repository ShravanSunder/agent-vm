import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { OperationFileIdentity } from './operation-file-relay.js';
import {
	assertOperationRelativePath,
	operationFolderFileLimit,
	OperationFolderAccessError,
} from './operation-folder-guest-access.js';

export class SharedStagingCopyCleanupError extends Error {}

export async function* readSharedStagingFile(props: {
	readonly root: string;
	readonly relativePath: string;
	readonly signal: AbortSignal;
}): AsyncIterable<Uint8Array> {
	const filename = await resolveStagingFile(props.root, props.relativePath, false);
	props.signal.throwIfAborted();
	const file = await open(
		filename,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const status = await file.stat();
		if (!status.isFile()) throw new OperationFolderAccessError('invalid-path');
		if (status.size > operationFolderFileLimit) throw new OperationFolderAccessError('size-limit');
		const buffer = Buffer.alloc(64 * 1024);
		let byteLength = 0;
		while (true) {
			props.signal.throwIfAborted();
			// oxlint-disable-next-line no-await-in-loop -- downstream demand controls each bounded read.
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			byteLength += bytesRead;
			if (byteLength > operationFolderFileLimit) throw new OperationFolderAccessError('size-limit');
			yield buffer.subarray(0, bytesRead);
		}
		if (byteLength !== status.size) throw new OperationFolderAccessError('integrity-mismatch');
	} finally {
		await file.close();
	}
}

/** Bounded host sink; the relay separately verifies source completion and digest. */
export async function writeSharedStagingBytes(props: {
	readonly destinationRoot: string;
	readonly relativePath: string;
	readonly contents: AsyncIterable<Uint8Array>;
	readonly signal: AbortSignal;
}): Promise<void> {
	props.signal.throwIfAborted();
	const filename = await resolveStagingFile(props.destinationRoot, props.relativePath, true);
	const file = await open(filename, 'wx', 0o600);
	let complete = false;
	try {
		let byteLength = 0;
		for await (const chunk of props.contents) {
			props.signal.throwIfAborted();
			byteLength += chunk.byteLength;
			if (byteLength > operationFolderFileLimit) throw new OperationFolderAccessError('size-limit');
			let offset = 0;
			while (offset < chunk.byteLength) {
				// oxlint-disable-next-line no-await-in-loop -- finish partial writes before requesting another chunk.
				const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
				if (bytesWritten === 0) throw new OperationFolderAccessError('transfer-failed');
				offset += bytesWritten;
			}
		}
		props.signal.throwIfAborted();
		await file.close();
		complete = true;
	} finally {
		try {
			await file.close();
		} finally {
			if (!complete) await removeIncompleteCopy(filename);
		}
	}
}

async function removeIncompleteCopy(destinationPath: string): Promise<void> {
	try {
		await unlink(destinationPath);
	} catch (error) {
		throw new SharedStagingCopyCleanupError('Unverified staging file cleanup failed.', {
			cause: error,
		});
	}
}

/** Roots are controller-owned; callers hold producer/destination publication authority. */
async function resolveStagingFile(
	root: string,
	relativePath: string,
	createParents: boolean,
): Promise<string> {
	if (!path.isAbsolute(root) || path.parse(root).root === root)
		throw new OperationFolderAccessError('invalid-path');
	assertOperationRelativePath(relativePath);
	const rootStatus = await lstat(root);
	if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink())
		throw new OperationFolderAccessError('invalid-path');
	let directory = await realpath(root);
	const components = relativePath.split('/');
	const filename = components.pop();
	if (filename === undefined) throw new OperationFolderAccessError('invalid-path');
	for (const component of components) {
		directory = path.join(directory, component);
		if (createParents) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- validate each owned parent before descending.
				await mkdir(directory, { mode: 0o700 });
			} catch (error) {
				if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
			}
		}
		// oxlint-disable-next-line no-await-in-loop -- symlinks must be rejected component by component.
		const status = await lstat(directory);
		if (!status.isDirectory() || status.isSymbolicLink())
			throw new OperationFolderAccessError('invalid-path');
	}
	return path.join(directory, filename);
}

async function copyFileBytes(props: {
	readonly source: FileHandle;
	readonly destination: FileHandle;
	readonly signal: AbortSignal;
	readonly maximumBytes: number;
}): Promise<OperationFileIdentity> {
	const buffer = Buffer.alloc(64 * 1024);
	const digest = createHash('sha256');
	let byteLength = 0;
	while (true) {
		props.signal.throwIfAborted();
		// oxlint-disable-next-line no-await-in-loop -- one fixed buffer enforces bounded memory and backpressure.
		const { bytesRead } = await props.source.read(buffer, 0, buffer.length, null);
		if (bytesRead === 0) break;
		byteLength += bytesRead;
		if (byteLength > props.maximumBytes) throw new OperationFolderAccessError('size-limit');
		digest.update(buffer.subarray(0, bytesRead));
		let offset = 0;
		while (offset < bytesRead) {
			props.signal.throwIfAborted();
			// oxlint-disable-next-line no-await-in-loop -- partial writes finish before source reads reuse the buffer.
			const { bytesWritten } = await props.destination.write(
				buffer,
				offset,
				bytesRead - offset,
				null,
			);
			if (bytesWritten === 0) throw new OperationFolderAccessError('transfer-failed');
			offset += bytesWritten;
		}
	}
	return { byteLength, sha256: digest.digest('hex') };
}

/** Independent destination inode: a producer-held descriptor cannot change delivered bytes. */
export async function copySharedStagingFile(props: {
	readonly sourceRoot: string;
	readonly destinationRoot: string;
	readonly relativePath: string;
	readonly signal: AbortSignal;
	readonly maximumBytes?: number;
}): Promise<OperationFileIdentity> {
	props.signal.throwIfAborted();
	const maximumBytes = props.maximumBytes ?? operationFolderFileLimit;
	if (
		!Number.isSafeInteger(maximumBytes) ||
		maximumBytes < 0 ||
		maximumBytes > operationFolderFileLimit
	)
		throw new OperationFolderAccessError('size-limit');
	const sourcePath = await resolveStagingFile(props.sourceRoot, props.relativePath, false);
	const destinationPath = await resolveStagingFile(props.destinationRoot, props.relativePath, true);
	const source = await open(
		sourcePath,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	let destination: FileHandle | undefined;
	let complete = false;
	try {
		const before = await source.stat();
		if (!before.isFile()) throw new OperationFolderAccessError('invalid-path');
		if (before.size > maximumBytes) throw new OperationFolderAccessError('size-limit');
		destination = await open(destinationPath, 'wx', 0o600);
		const identity = await copyFileBytes({
			source,
			destination,
			signal: props.signal,
			maximumBytes,
		});
		const after = await source.stat();
		if (
			identity.byteLength !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			throw new OperationFolderAccessError('integrity-mismatch');
		props.signal.throwIfAborted();
		await destination.close();
		await source.close();
		complete = true;
		return identity;
	} finally {
		try {
			await source.close();
		} finally {
			if (destination !== undefined && !complete) {
				try {
					await destination.close();
				} finally {
					await removeIncompleteCopy(destinationPath);
				}
			}
		}
	}
}

/** Stages approved input bytes directly on host disk for the Gog RealFS mount. */
export async function writeSharedStagingInput(props: {
	readonly destinationRoot: string;
	readonly relativePath: string;
	readonly contents: AsyncIterable<Uint8Array>;
	readonly expected: OperationFileIdentity;
	readonly signal: AbortSignal;
}): Promise<void> {
	const expected = { ...props.expected };
	if (
		!Number.isSafeInteger(expected.byteLength) ||
		expected.byteLength < 0 ||
		expected.byteLength > operationFolderFileLimit
	)
		throw new OperationFolderAccessError('size-limit');
	props.signal.throwIfAborted();
	const destinationPath = await resolveStagingFile(props.destinationRoot, props.relativePath, true);
	const destination = await open(destinationPath, 'wx', 0o600);
	let complete = false;
	try {
		let byteLength = 0;
		const digest = createHash('sha256');
		for await (const chunk of props.contents) {
			props.signal.throwIfAborted();
			byteLength += chunk.byteLength;
			if (byteLength > expected.byteLength)
				throw new OperationFolderAccessError('integrity-mismatch');
			digest.update(chunk);
			let offset = 0;
			while (offset < chunk.byteLength) {
				// oxlint-disable-next-line no-await-in-loop -- input transport advances only after destination write completion.
				const { bytesWritten } = await destination.write(
					chunk,
					offset,
					chunk.byteLength - offset,
					null,
				);
				if (bytesWritten === 0) throw new OperationFolderAccessError('transfer-failed');
				offset += bytesWritten;
			}
		}
		if (byteLength !== expected.byteLength || digest.digest('hex') !== expected.sha256)
			throw new OperationFolderAccessError('integrity-mismatch');
		props.signal.throwIfAborted();
		await destination.close();
		complete = true;
	} finally {
		try {
			await destination.close();
		} finally {
			if (!complete) await removeIncompleteCopy(destinationPath);
		}
	}
}
