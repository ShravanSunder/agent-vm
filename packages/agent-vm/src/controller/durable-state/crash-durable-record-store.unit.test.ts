import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

const testRecordSchema = z
	.object({
		counter: z.number().int().nonnegative(),
		recordId: z.string().min(1),
	})
	.strict();

type TestRecord = z.infer<typeof testRecordSchema>;
type CreateCrashDurableRecordStore =
	(typeof import('./crash-durable-record-store.js'))['createCrashDurableRecordStore'];
type TestCrashDurableRecordStore =
	import('./crash-durable-record-store.js').CrashDurableRecordStore<TestRecord>;
type CrashDurableRecordFileOperations = NonNullable<
	Parameters<CreateCrashDurableRecordStore>[0]['fileOperations']
>;

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
}

function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: TValue): void {
			resolvePromise?.(value);
		},
	};
}

function missingFileError(): NodeJS.ErrnoException {
	return Object.assign(new Error('record does not exist'), { code: 'ENOENT' });
}

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-durable-records-'));
	temporaryDirectories.push(directoryPath);
	return directoryPath;
}

async function createTestStore(
	recordsDirectoryPath: string,
	fileOperations?: CrashDurableRecordFileOperations,
): Promise<TestCrashDurableRecordStore> {
	const { createCrashDurableRecordStore } = await import('./crash-durable-record-store.js');
	return createCrashDurableRecordStore({
		recordSchema: testRecordSchema,
		recordsDirectoryPath,
		...(fileOperations === undefined ? {} : { fileOperations }),
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
	);
});

describe('crash-durable controller record store', () => {
	it('creates private record storage and restores schema-validated state', async () => {
		// Arrange
		const parentDirectoryPath = await createTemporaryDirectory();
		const recordsDirectoryPath = path.join(parentDirectoryPath, 'approval-records');
		const store = await createTestStore(recordsDirectoryPath);
		const record = { counter: 1, recordId: 'approval-a' } satisfies TestRecord;

		// Act
		await store.mutateRecord('approval-a', () => ({ nextRecord: record, result: undefined }));
		const restoredRecord = await store.loadRecord('approval-a');
		const recordFileNames = await readdir(recordsDirectoryPath);

		// Assert
		expect(restoredRecord).toEqual(record);
		expect((await stat(recordsDirectoryPath)).mode & 0o777).toBe(0o700);
		expect(recordFileNames).toHaveLength(1);
		expect(
			(await stat(path.join(recordsDirectoryPath, recordFileNames[0] ?? ''))).mode & 0o777,
		).toBe(0o600);
	});

	it('syncs the new file before rename and the parent directory after rename', async () => {
		// Arrange
		const recordsDirectoryPath = '/controller-state/zones/zone-a/approvals';
		const events: string[] = [];
		let temporaryFilePath: string | undefined;
		let targetFilePath: string | undefined;
		const fileOperations: CrashDurableRecordFileOperations = {
			mkdir: async (directoryPath, options) => {
				events.push(`mkdir:${directoryPath}:${String(options.mode)}`);
			},
			open: async (filePath, flags, mode) => {
				events.push(`open:${flags}:${filePath}:${String(mode)}`);
				if (flags === 'wx') {
					temporaryFilePath = filePath;
					return {
						close: async () => {
							events.push('file:close');
						},
						sync: async () => {
							events.push('file:sync');
						},
						writeFile: async (content, encoding) => {
							events.push(`file:write:${encoding}`);
							expect(JSON.parse(content)).toEqual({ counter: 1, recordId: 'approval-a' });
						},
					};
				}
				if (flags === 'r' && filePath === recordsDirectoryPath) {
					return {
						close: async () => {
							events.push('directory:close');
						},
						sync: async () => {
							events.push('directory:sync');
						},
						writeFile: async () => {
							throw new Error('Directory handle must not be written.');
						},
					};
				}
				throw new Error(`Unexpected open: ${filePath} ${flags}`);
			},
			readFile: async () => Promise.reject(missingFileError()),
			readdir: async () => [],
			rename: async (sourcePath, destinationPath) => {
				targetFilePath = destinationPath;
				events.push('rename');
				expect(sourcePath).toBe(temporaryFilePath);
			},
			rm: async () => {
				throw new Error('Successful persistence must not remove a file.');
			},
		};
		const store = await createTestStore(recordsDirectoryPath, fileOperations);

		// Act
		await store.mutateRecord('approval-a', () => ({
			nextRecord: { counter: 1, recordId: 'approval-a' },
			result: undefined,
		}));

		// Assert
		expect(path.dirname(temporaryFilePath ?? '')).toBe(recordsDirectoryPath);
		expect(path.dirname(targetFilePath ?? '')).toBe(recordsDirectoryPath);
		expect(events).toEqual([
			`mkdir:${recordsDirectoryPath}:${String(0o700)}`,
			`open:wx:${temporaryFilePath}:${String(0o600)}`,
			'file:write:utf8',
			'file:sync',
			'file:close',
			'rename',
			`open:r:${recordsDirectoryPath}:undefined`,
			'directory:sync',
			'directory:close',
		]);
	});

	it('syncs the parent directory after deleting a record', async () => {
		// Arrange
		const recordsDirectoryPath = '/controller-state/zones/zone-a/approvals';
		const events: string[] = [];
		let loadedFilePath: string | undefined;
		const fileOperations: CrashDurableRecordFileOperations = {
			mkdir: async () => undefined,
			open: async (filePath, flags) => {
				expect(filePath).toBe(recordsDirectoryPath);
				expect(flags).toBe('r');
				return {
					close: async () => {
						events.push('directory:close');
					},
					sync: async () => {
						events.push('directory:sync');
					},
					writeFile: async () => {
						throw new Error('Directory handle must not be written.');
					},
				};
			},
			readFile: async (filePath) => {
				loadedFilePath = filePath;
				return JSON.stringify({ counter: 1, recordId: 'approval-a' });
			},
			readdir: async () => [],
			rename: async () => {
				throw new Error('Delete must not rename a record.');
			},
			rm: async (filePath) => {
				events.push('delete');
				expect(filePath).toBe(loadedFilePath);
			},
		};
		const store = await createTestStore(recordsDirectoryPath, fileOperations);

		// Act
		await store.mutateRecord('approval-a', (currentRecord) => {
			expect(currentRecord).toEqual({ counter: 1, recordId: 'approval-a' });
			return { nextRecord: null, result: undefined };
		});

		// Assert
		expect(events).toEqual(['delete', 'directory:sync', 'directory:close']);
	});

	it('does not publish a successful mutation before the directory durability barrier', async () => {
		// Arrange
		const recordsDirectoryPath = '/controller-state/zones/zone-a/approvals';
		const directorySyncStarted = createDeferred<void>();
		const releaseDirectorySync = createDeferred<void>();
		let callbackCompleted = false;
		let mutationResolved = false;
		const fileOperations: CrashDurableRecordFileOperations = {
			mkdir: async () => undefined,
			open: async (filePath, flags) => {
				if (flags === 'wx') {
					return {
						close: async () => undefined,
						sync: async () => undefined,
						writeFile: async () => undefined,
					};
				}
				expect(filePath).toBe(recordsDirectoryPath);
				expect(flags).toBe('r');
				return {
					close: async () => undefined,
					sync: async () => {
						directorySyncStarted.resolve();
						await releaseDirectorySync.promise;
					},
					writeFile: async () => undefined,
				};
			},
			readFile: async () => Promise.reject(missingFileError()),
			readdir: async () => [],
			rename: async () => undefined,
			rm: async () => undefined,
		};
		const store = await createTestStore(recordsDirectoryPath, fileOperations);

		// Act
		const mutation = store
			.mutateRecord('approval-a', () => {
				callbackCompleted = true;
				return {
					nextRecord: { counter: 1, recordId: 'approval-a' },
					result: 'protected-successor',
				};
			})
			.then((result) => {
				mutationResolved = true;
				return result;
			});
		await directorySyncStarted.promise;

		// Assert
		expect(callbackCompleted).toBe(true);
		expect(mutationResolved).toBe(false);

		// Act
		releaseDirectorySync.resolve();

		// Assert
		await expect(mutation).resolves.toBe('protected-successor');
		expect(mutationResolved).toBe(true);
	});

	it('serializes mutations for the same record', async () => {
		// Arrange
		const parentDirectoryPath = await createTemporaryDirectory();
		const store = await createTestStore(path.join(parentDirectoryPath, 'approval-records'));
		const firstMutationStarted = createDeferred<void>();
		const releaseFirstMutation = createDeferred<void>();
		const secondMutationStarted = createDeferred<void>();
		let secondMutationObservedRecord: TestRecord | null | undefined;
		const firstMutation = store.mutateRecord('approval-a', async () => {
			firstMutationStarted.resolve();
			await releaseFirstMutation.promise;
			return {
				nextRecord: { counter: 1, recordId: 'approval-a' },
				result: 'first',
			};
		});
		const secondMutation = store.mutateRecord('approval-a', (currentRecord) => {
			secondMutationObservedRecord = currentRecord;
			secondMutationStarted.resolve();
			return {
				nextRecord: { counter: 2, recordId: 'approval-a' },
				result: 'second',
			};
		});

		// Act
		await firstMutationStarted.promise;
		await Promise.resolve();

		// Assert
		expect(secondMutationObservedRecord).toBeUndefined();

		// Act
		releaseFirstMutation.resolve();
		await secondMutationStarted.promise;

		// Assert
		expect(secondMutationObservedRecord).toEqual({ counter: 1, recordId: 'approval-a' });
		await expect(Promise.all([firstMutation, secondMutation])).resolves.toEqual([
			'first',
			'second',
		]);
	});

	it('allows different record mutations to proceed independently', async () => {
		// Arrange
		const parentDirectoryPath = await createTemporaryDirectory();
		const store = await createTestStore(path.join(parentDirectoryPath, 'approval-records'));
		const firstMutationStarted = createDeferred<void>();
		const releaseFirstMutation = createDeferred<void>();
		const blockedMutation = store.mutateRecord('approval-a', async () => {
			firstMutationStarted.resolve();
			await releaseFirstMutation.promise;
			return {
				nextRecord: { counter: 1, recordId: 'approval-a' },
				result: 'approval-a',
			};
		});
		await firstMutationStarted.promise;

		// Act
		const independentMutation = store.mutateRecord('approval-b', () => ({
			nextRecord: { counter: 1, recordId: 'approval-b' },
			result: 'approval-b',
		}));

		// Assert
		await expect(independentMutation).resolves.toBe('approval-b');

		// Act
		releaseFirstMutation.resolve();

		// Assert
		await expect(blockedMutation).resolves.toBe('approval-a');
	});

	it('fails closed when persisted JSON does not satisfy the record schema', async () => {
		// Arrange
		const fileOperations: CrashDurableRecordFileOperations = {
			mkdir: async () => undefined,
			open: async () => {
				throw new Error('Load must not open a write or directory handle.');
			},
			readFile: async () => JSON.stringify({ counter: 'not-an-integer', recordId: 'approval-a' }),
			readdir: async () => [],
			rename: async () => {
				throw new Error('Load must not rename a file.');
			},
			rm: async () => {
				throw new Error('Load must not remove a file.');
			},
		};
		const store = await createTestStore('/controller-state/zones/zone-a/approvals', fileOperations);

		// Act
		const load = store.loadRecord('approval-a');

		// Assert
		await expect(load).rejects.toThrow();
	});

	it.each([
		'',
		'.',
		'..',
		'../approval-a',
		'nested/approval-a',
		'/absolute/approval-a',
		'approval\\a',
		'approval\u0000a',
	])('rejects unsafe record id %j before filesystem access', async (unsafeRecordId) => {
		// Arrange
		let filesystemAccessed = false;
		const rejectFilesystemAccess = async (): Promise<never> => {
			filesystemAccessed = true;
			throw new Error('Unsafe record id reached filesystem operations.');
		};
		const fileOperations: CrashDurableRecordFileOperations = {
			mkdir: rejectFilesystemAccess,
			open: rejectFilesystemAccess,
			readFile: rejectFilesystemAccess,
			readdir: rejectFilesystemAccess,
			rename: rejectFilesystemAccess,
			rm: rejectFilesystemAccess,
		};
		const store = await createTestStore('/controller-state/zones/zone-a/approvals', fileOperations);

		// Act
		const load = store.loadRecord(unsafeRecordId);

		// Assert
		await expect(load).rejects.toThrow(/record id/iu);
		expect(filesystemAccessed).toBe(false);
	});

	it('removes the temporary file and preserves a failed rename', async () => {
		// Arrange
		const renameError = new Error('rename failed');
		let temporaryFilePath: string | undefined;
		let cleanedFilePath: string | undefined;
		const fileOperations: CrashDurableRecordFileOperations = {
			mkdir: async () => undefined,
			open: async (filePath, flags) => {
				expect(flags).toBe('wx');
				temporaryFilePath = filePath;
				return {
					close: async () => undefined,
					sync: async () => undefined,
					writeFile: async () => undefined,
				};
			},
			readFile: async () => Promise.reject(missingFileError()),
			readdir: async () => [],
			rename: async () => Promise.reject(renameError),
			rm: async (filePath) => {
				cleanedFilePath = filePath;
			},
		};
		const store = await createTestStore('/controller-state/zones/zone-a/approvals', fileOperations);

		// Act
		const mutation = store.mutateRecord('approval-a', () => ({
			nextRecord: { counter: 1, recordId: 'approval-a' },
			result: undefined,
		}));

		// Assert
		await expect(mutation).rejects.toBe(renameError);
		expect(cleanedFilePath).toBe(temporaryFilePath);
	});
});
