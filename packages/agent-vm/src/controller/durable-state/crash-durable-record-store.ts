import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { ZodType } from 'zod/v4';

interface CrashDurableRecordFileHandle {
	close(): Promise<void>;
	sync(): Promise<void>;
	writeFile(content: string, encoding: 'utf8'): Promise<void>;
}

export interface CrashDurableRecordFileOperations {
	readonly mkdir: (
		directoryPath: string,
		options: { readonly mode: number; readonly recursive: true },
	) => Promise<unknown>;
	readonly open: (
		filePath: string,
		flags: 'r' | 'wx',
		mode?: number,
	) => Promise<CrashDurableRecordFileHandle>;
	readonly readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
	readonly readdir: (directoryPath: string) => Promise<string[]>;
	readonly rename: (sourcePath: string, destinationPath: string) => Promise<void>;
	readonly rm: (filePath: string) => Promise<void>;
}

interface CreateCrashDurableRecordStoreProps<TRecord> {
	readonly fileOperations?: CrashDurableRecordFileOperations;
	readonly recordSchema: ZodType<TRecord>;
	readonly recordsDirectoryPath: string;
}

export interface CrashDurableRecordMutation<TResult, TRecord> {
	readonly nextRecord: TRecord | null;
	readonly result: TResult;
}

export interface CrashDurableRecordStore<TRecord> {
	readonly loadRecord: (recordId: string) => Promise<TRecord | null>;
	readonly listRecords: () => Promise<readonly TRecord[]>;
	readonly mutateRecord: <TResult>(
		recordId: string,
		mutate: (
			currentRecord: TRecord | null,
		) =>
			| CrashDurableRecordMutation<TResult, TRecord>
			| Promise<CrashDurableRecordMutation<TResult, TRecord>>,
	) => Promise<TResult>;
}

const privateDirectoryMode = 0o700;
const privateRecordMode = 0o600;
const safeRecordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const defaultFileOperations: CrashDurableRecordFileOperations = {
	mkdir,
	open: async (filePath, flags, mode) => (await open(filePath, flags, mode)) satisfies FileHandle,
	readFile,
	readdir,
	rename,
	rm: async (filePath) => await rm(filePath, { force: true }),
};

function assertSafeRecordId(recordId: string): void {
	if (
		!safeRecordIdPattern.test(recordId) ||
		recordId === '.' ||
		recordId === '..' ||
		recordId.includes('\\') ||
		recordId.includes('/') ||
		recordId.includes('\0')
	) {
		throw new Error('Crash-durable record id is unsafe.');
	}
}

function recordPath(recordsDirectoryPath: string, recordId: string): string {
	assertSafeRecordId(recordId);
	return path.join(recordsDirectoryPath, `${recordId}.json`);
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function closeAfterFailure(props: {
	readonly fileHandle: CrashDurableRecordFileHandle;
	readonly fileOperations: CrashDurableRecordFileOperations;
	readonly originalError: unknown;
	readonly temporaryFilePath: string;
}): Promise<never> {
	const cleanupErrors: unknown[] = [];
	try {
		await props.fileHandle.close();
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await props.fileOperations.rm(props.temporaryFilePath);
	} catch (error) {
		cleanupErrors.push(error);
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			[props.originalError, ...cleanupErrors],
			'Crash-durable record write and temporary-file cleanup both failed.',
		);
	}
	throw props.originalError;
}

async function syncDirectory(
	recordsDirectoryPath: string,
	fileOperations: CrashDurableRecordFileOperations,
): Promise<void> {
	const directoryHandle = await fileOperations.open(recordsDirectoryPath, 'r');
	try {
		await directoryHandle.sync();
	} finally {
		await directoryHandle.close();
	}
}

async function persistRecord(props: {
	readonly fileOperations: CrashDurableRecordFileOperations;
	readonly record: unknown;
	readonly recordFilePath: string;
	readonly recordsDirectoryPath: string;
}): Promise<void> {
	await props.fileOperations.mkdir(props.recordsDirectoryPath, {
		mode: privateDirectoryMode,
		recursive: true,
	});
	const temporaryFilePath = `${props.recordFilePath}.${process.pid}.${randomUUID()}.tmp`;
	const fileHandle = await props.fileOperations.open(temporaryFilePath, 'wx', privateRecordMode);
	try {
		await fileHandle.writeFile(`${JSON.stringify(props.record)}\n`, 'utf8');
		await fileHandle.sync();
		await fileHandle.close();
	} catch (error) {
		return await closeAfterFailure({
			fileHandle,
			fileOperations: props.fileOperations,
			originalError: error,
			temporaryFilePath,
		});
	}
	try {
		await props.fileOperations.rename(temporaryFilePath, props.recordFilePath);
	} catch (error) {
		try {
			await props.fileOperations.rm(temporaryFilePath);
		} catch (cleanupError) {
			const renameMessage = error instanceof Error ? error.message : String(error);
			const cleanupMessage =
				cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
			throw new Error(
				`Crash-durable record rename failed (${renameMessage}) and temporary-file cleanup also failed (${cleanupMessage}).`,
				{ cause: cleanupError },
			);
		}
		throw error;
	}
	await syncDirectory(props.recordsDirectoryPath, props.fileOperations);
}

export function createCrashDurableRecordStore<TRecord>(
	props: CreateCrashDurableRecordStoreProps<TRecord>,
): CrashDurableRecordStore<TRecord> {
	const fileOperations = props.fileOperations ?? defaultFileOperations;
	const pendingMutationsByRecordId = new Map<string, Promise<void>>();

	async function loadRecord(recordId: string): Promise<TRecord | null> {
		const filePath = recordPath(props.recordsDirectoryPath, recordId);
		let serializedRecord: string;
		try {
			serializedRecord = await fileOperations.readFile(filePath, 'utf8');
		} catch (error) {
			if (isMissingFileError(error)) return null;
			throw error;
		}
		return props.recordSchema.parse(JSON.parse(serializedRecord) as unknown);
	}

	async function runWithRecordLock<TResult>(
		recordId: string,
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		const previousMutation = pendingMutationsByRecordId.get(recordId) ?? Promise.resolve();
		let releaseCurrentMutation: (() => void) | undefined;
		const currentMutation = new Promise<void>((resolve) => {
			releaseCurrentMutation = resolve;
		});
		const mutationTail = previousMutation.then(() => currentMutation);
		pendingMutationsByRecordId.set(recordId, mutationTail);
		await previousMutation;
		try {
			return await operation();
		} finally {
			releaseCurrentMutation?.();
			if (pendingMutationsByRecordId.get(recordId) === mutationTail) {
				pendingMutationsByRecordId.delete(recordId);
			}
		}
	}

	async function mutateRecord<TResult>(
		recordId: string,
		mutate: (
			currentRecord: TRecord | null,
		) =>
			| CrashDurableRecordMutation<TResult, TRecord>
			| Promise<CrashDurableRecordMutation<TResult, TRecord>>,
	): Promise<TResult> {
		assertSafeRecordId(recordId);
		return await runWithRecordLock(recordId, async () => {
			const currentRecord = await loadRecord(recordId);
			const mutation = await mutate(currentRecord);
			const recordFilePath = recordPath(props.recordsDirectoryPath, recordId);
			if (mutation.nextRecord === null) {
				if (currentRecord !== null) {
					await fileOperations.rm(recordFilePath);
					await syncDirectory(props.recordsDirectoryPath, fileOperations);
				}
				return mutation.result;
			}
			const nextRecord = props.recordSchema.parse(mutation.nextRecord);
			await persistRecord({
				fileOperations,
				record: nextRecord,
				recordFilePath,
				recordsDirectoryPath: props.recordsDirectoryPath,
			});
			return mutation.result;
		});
	}

	async function listRecords(): Promise<readonly TRecord[]> {
		let fileNames: string[];
		try {
			fileNames = await fileOperations.readdir(props.recordsDirectoryPath);
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
		const recordIds = fileNames
			.filter((fileName) => fileName.endsWith('.json'))
			.map((fileName) => fileName.slice(0, -'.json'.length))
			.toSorted();
		const records: TRecord[] = [];
		for (const recordId of recordIds) {
			// oxlint-disable-next-line no-await-in-loop -- Preserve deterministic record order while validating each durable file.
			const record = await loadRecord(recordId);
			if (record !== null) records.push(record);
		}
		return records;
	}

	return { listRecords, loadRecord, mutateRecord };
}
