import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type {
	GatewayRuntimeArtifactStorageBackend,
	GatewayRuntimeArtifactStorageWriter,
} from './artifact-store.js';

const maximumArtifactIdentifierCharacters = 240;
const maximumReadBytes = 16 * 1024 * 1024;
const artifactIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

type RuntimeFileArtifactStorageErrorCode =
	| 'commit-failed'
	| 'discard-failed'
	| 'invalid-artifact-id'
	| 'read-failed'
	| 'remove-failed'
	| 'write-failed';

class RuntimeFileArtifactStorageError extends Error {
	readonly code: RuntimeFileArtifactStorageErrorCode;

	constructor(code: RuntimeFileArtifactStorageErrorCode, message: string) {
		super(message);
		this.name = 'RuntimeFileArtifactStorageError';
		this.code = code;
	}
}

function storageError(
	code: RuntimeFileArtifactStorageErrorCode,
	message: string,
): RuntimeFileArtifactStorageError {
	return new RuntimeFileArtifactStorageError(code, message);
}

function validateArtifactId(artifactId: string): void {
	if (
		artifactId.length === 0 ||
		artifactId.length > maximumArtifactIdentifierCharacters ||
		!artifactIdentifierPattern.test(artifactId)
	) {
		throw storageError('invalid-artifact-id', 'Gateway runtime artifact identifier is invalid.');
	}
}

function validateReadRange(props: {
	readonly maxBytes: number;
	readonly offsetBytes: number;
}): void {
	if (
		!Number.isSafeInteger(props.maxBytes) ||
		props.maxBytes <= 0 ||
		props.maxBytes > maximumReadBytes ||
		!Number.isSafeInteger(props.offsetBytes) ||
		props.offsetBytes < 0
	) {
		throw storageError('read-failed', 'Gateway runtime artifact read range is invalid.');
	}
}

async function closeIgnoringFailure(fileHandle: FileHandle): Promise<void> {
	try {
		await fileHandle.close();
	} catch {
		// The owning operation returns one sanitized terminal storage error.
	}
}

async function tryRemoveFile(filePath: string): Promise<boolean> {
	try {
		await rm(filePath, { force: true });
		return true;
	} catch {
		return false;
	}
}

export async function createGatewayRuntimeFileArtifactStorageBackend(props: {
	readonly artifactsDirectoryPath: string;
}): Promise<GatewayRuntimeArtifactStorageBackend> {
	if (props.artifactsDirectoryPath.length === 0 || !path.isAbsolute(props.artifactsDirectoryPath)) {
		throw storageError('write-failed', 'Gateway runtime artifact directory must be absolute.');
	}
	const artifactsDirectoryPath = path.resolve(props.artifactsDirectoryPath);
	await mkdir(artifactsDirectoryPath, { recursive: true });

	function committedPath(artifactId: string): string {
		validateArtifactId(artifactId);
		return path.join(artifactsDirectoryPath, artifactId);
	}

	async function createWriter(artifactId: string): Promise<GatewayRuntimeArtifactStorageWriter> {
		const finalPath = committedPath(artifactId);
		const stagingPath = path.join(artifactsDirectoryPath, `.staged-${artifactId}-${randomUUID()}`);
		let fileHandle: FileHandle;
		try {
			fileHandle = await open(stagingPath, 'wx');
		} catch {
			throw storageError('write-failed', 'Gateway runtime artifact staging failed.');
		}
		let state: 'active' | 'cleanup-pending' | 'committed' | 'discarded' | 'failed-cleaned' =
			'active';

		function assertActive(): void {
			if (state !== 'active') {
				throw storageError('write-failed', 'Gateway runtime artifact writer is terminal.');
			}
		}

		async function write(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
			assertActive();
			try {
				let writtenBytes = 0;
				while (writtenBytes < chunk.byteLength) {
					if (signal?.aborted === true) {
						throw storageError('write-failed', 'Gateway runtime artifact write was cancelled.');
					}
					// oxlint-disable-next-line no-await-in-loop -- partial file writes must advance sequentially.
					const writeResult = await fileHandle.write(
						chunk,
						writtenBytes,
						chunk.byteLength - writtenBytes,
					);
					if (writeResult.bytesWritten <= 0) {
						throw storageError('write-failed', 'Gateway runtime artifact write made no progress.');
					}
					writtenBytes += writeResult.bytesWritten;
				}
			} catch {
				await closeIgnoringFailure(fileHandle);
				state = (await tryRemoveFile(stagingPath)) ? 'failed-cleaned' : 'cleanup-pending';
				throw storageError('write-failed', 'Gateway runtime artifact write failed.');
			}
		}

		async function commit(): Promise<void> {
			assertActive();
			try {
				await fileHandle.close();
				await rename(stagingPath, finalPath);
				state = 'committed';
			} catch {
				await closeIgnoringFailure(fileHandle);
				state = (await tryRemoveFile(stagingPath)) ? 'failed-cleaned' : 'cleanup-pending';
				throw storageError('commit-failed', 'Gateway runtime artifact commit failed.');
			}
		}

		async function discard(): Promise<void> {
			if (state === 'failed-cleaned') return;
			if (state === 'cleanup-pending') {
				if (await tryRemoveFile(stagingPath)) {
					state = 'failed-cleaned';
					return;
				}
				throw storageError('discard-failed', 'Gateway runtime artifact discard failed.');
			}
			assertActive();
			try {
				await fileHandle.close();
				await rm(stagingPath, { force: true });
				state = 'discarded';
			} catch {
				state = 'cleanup-pending';
				throw storageError('discard-failed', 'Gateway runtime artifact discard failed.');
			}
		}

		return { commit, discard, write };
	}

	async function readRange(readProps: {
		readonly artifactId: string;
		readonly maxBytes: number;
		readonly offsetBytes: number;
	}): Promise<Uint8Array> {
		validateReadRange(readProps);
		const filePath = committedPath(readProps.artifactId);
		let fileHandle: FileHandle | undefined;
		try {
			fileHandle = await open(filePath, 'r');
			const bytes = Buffer.alloc(readProps.maxBytes);
			const readResult = await fileHandle.read(bytes, 0, readProps.maxBytes, readProps.offsetBytes);
			await fileHandle.close();
			return bytes.subarray(0, readResult.bytesRead);
		} catch {
			if (fileHandle !== undefined) await closeIgnoringFailure(fileHandle);
			throw storageError('read-failed', 'Gateway runtime artifact read failed.');
		}
	}

	async function remove(artifactId: string): Promise<void> {
		const filePath = committedPath(artifactId);
		try {
			await rm(filePath);
		} catch {
			throw storageError('remove-failed', 'Gateway runtime artifact removal failed.');
		}
	}

	return { createWriter, readRange, remove };
}
