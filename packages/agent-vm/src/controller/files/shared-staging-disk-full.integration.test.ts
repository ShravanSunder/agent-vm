import type { PathLike } from 'node:fs';
import {
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
	type FileHandle,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createOperationFileRetentionBudget,
	type OperationFileRetentionOwner,
} from './operation-file-retention-budget.js';
import {
	createSharedStagingDirectoryStore,
	type SharedStagingDirectoryStore,
} from './shared-staging-directory-store.js';

const diskFullFault: {
	armed: boolean;
	destinationPrefix: string | undefined;
	realBytesWritten: number;
	writeAttempts: number;
} = vi.hoisted(() => ({
	armed: false,
	destinationPrefix: undefined,
	realBytesWritten: 0,
	writeAttempts: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
			const handle = await actual.open(...args);
			const filename: PathLike = args[0];
			if (
				diskFullFault.armed &&
				typeof filename === 'string' &&
				diskFullFault.destinationPrefix !== undefined &&
				filename.startsWith(`${diskFullFault.destinationPrefix}${path.sep}`)
			) {
				const originalWrite = handle.write.bind(handle);
				Object.defineProperty(handle, 'write', {
					value: async (...writeArgs: unknown[]): Promise<unknown> => {
						diskFullFault.writeAttempts += 1;
						if (diskFullFault.writeAttempts > 1)
							throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
						const requestedLength = writeArgs[2];
						if (typeof requestedLength !== 'number')
							throw new Error('Disk-full proof expected a byte-range write.');
						const partialLength = Math.max(1, Math.floor(requestedLength / 2));
						const partialWriteArgs = [...writeArgs];
						partialWriteArgs[2] = partialLength;
						const result: unknown = await Reflect.apply(originalWrite, handle, partialWriteArgs);
						if (
							typeof result !== 'object' ||
							result === null ||
							!('bytesWritten' in result) ||
							typeof result.bytesWritten !== 'number'
						)
							throw new Error('Unexpected native write result.');
						diskFullFault.realBytesWritten += result.bytesWritten;
						return result;
					},
				});
			}
			return handle;
		},
	};
});

const ownedRoots: string[] = [];
const receiver = { leaseId: 'lease', leafGeneration: 'leaf', vmId: 'vm' };

afterEach(async () => {
	diskFullFault.armed = false;
	diskFullFault.destinationPrefix = undefined;
	diskFullFault.realBytesWritten = 0;
	diskFullFault.writeAttempts = 0;
	await Promise.all(
		ownedRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{
	readonly root: string;
	readonly stagingRoot: string;
	readonly store: SharedStagingDirectoryStore;
	readonly retention: OperationFileRetentionOwner;
}> {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'shared-staging-disk-full-')));
	ownedRoots.push(root);
	const stagingRoot = path.join(root, 'staging');
	const retention = createOperationFileRetentionBudget().forOwner({
		agentId: 'sun',
		zoneId: 'zone',
		ownerId: 'run',
	});
	const store = await createSharedStagingDirectoryStore({
		root: stagingRoot,
		now: () => 1000,
		retention,
	});
	return { root, stagingRoot, store, retention };
}

describe('shared staging disk-full publication failure', () => {
	it('removes a partially written publication and releases only its reservation', async () => {
		// Arrange: one prepared operation is retained across the failed publication attempt.
		const current = await fixture();
		const receiverRoot = await current.store.prepareReceiverRoot(receiver.leafGeneration);
		const sourceRoot = await current.store.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 1024,
		});
		const sourceBytes = Buffer.from('complete producer output');
		await writeFile(path.join(sourceRoot, 'report.txt'), sourceBytes);
		await writeFile(path.join(receiverRoot, 'sentinel'), 'keep');
		diskFullFault.destinationPrefix = path.join(current.stagingRoot, 'private');
		diskFullFault.armed = true;

		// Act: the production host sink performs one real partial write, then receives ENOSPC.
		await expect(
			current.store.publish({
				producerId: 'producer',
				operationId: 'operation',
				receiver,
				relativePaths: ['report.txt'],
				withPublicationAuthority: async (expose) => await expose(),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ reason: 'transfer-failed' });

		// Assert: no complete path was exposed, unrelated data remains, and only the operation stays reserved.
		expect(diskFullFault.writeAttempts).toBe(2);
		expect(diskFullFault.realBytesWritten).toBeGreaterThan(0);
		expect(diskFullFault.realBytesWritten).toBeLessThan(sourceBytes.byteLength);
		expect(await readdir(path.join(current.stagingRoot, 'private'))).toEqual([]);
		expect(await readdir(receiverRoot)).toEqual(['sentinel']);
		expect(await readFile(path.join(receiverRoot, 'sentinel'), 'utf8')).toBe('keep');
		expect(current.retention.retainedBytes()).toBe(1024);

		// The same already-staged operation can publish after capacity returns; no producer rerun is needed.
		diskFullFault.armed = false;
		const publication = await current.store.publish({
			producerId: 'producer',
			operationId: 'operation',
			receiver,
			relativePaths: ['report.txt'],
			withPublicationAuthority: async (expose) => await expose(),
			signal: new AbortController().signal,
		});
		expect(
			await readFile(path.join(receiverRoot, publication.publicationId, 'report.txt')),
		).toEqual(sourceBytes);
		expect(current.retention.retainedBytes()).toBe(sourceBytes.byteLength);
		expect(await current.store.retireReceiver(receiver)).toEqual({ removed: 1, pending: 0 });
		expect(current.retention.retainedBytes()).toBe(0);
		expect(await readFile(path.join(receiverRoot, 'sentinel'), 'utf8')).toBe('keep');
	});
});
