import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOperationFileRetentionBudget } from './operation-file-retention-budget.js';
import { createSharedStagingDirectoryStore } from './shared-staging-directory-store.js';

const ownedRoots: string[] = [];
const receiver = { leaseId: 'lease', leafGeneration: 'leaf', vmId: 'vm' };
afterEach(async () => {
	await Promise.all(
		ownedRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
	);
});

async function fixture(): Promise<{
	root: string;
	now: { value: number };
	store: Awaited<ReturnType<typeof createSharedStagingDirectoryStore>>;
}> {
	const root = await mkdtemp(path.join(os.tmpdir(), 'shared-staging-store-'));
	ownedRoots.push(root);
	const now = { value: 1000 };
	const store = await createSharedStagingDirectoryStore({
		root: path.join(root, 'staging'),
		now: () => now.value,
		retention: createOperationFileRetentionBudget().forOwner({
			agentId: 'sun',
			zoneId: 'zone',
			ownerId: 'run',
		}),
	});
	return { root, now, store };
}

describe('shared staging owned directories and real cleanup', () => {
	it('counts published operations toward the retained-operation limit until cleanup', async () => {
		// Arrange
		const { store } = await fixture();
		await store.prepareReceiverRoot(receiver.leafGeneration);
		for (let index = 0; index < 32; index += 1) {
			const operationId = `operation-${index}`;
			// oxlint-disable-next-line no-await-in-loop -- exercise sequential publications accumulating retained slots.
			const root = await store.prepareOperation({
				producerId: 'producer',
				operationId,
				maximumBytes: 1,
			});
			// oxlint-disable-next-line no-await-in-loop -- stage this operation before publishing it.
			await writeFile(path.join(root, 'empty'), '');
			// oxlint-disable-next-line no-await-in-loop -- publication must finish before admission of the next operation.
			await store.publish({
				producerId: 'producer',
				operationId,
				receiver,
				relativePaths: ['empty'],
				withPublicationAuthority: async (expose) => await expose(),
				signal: new AbortController().signal,
			});
		}
		// Act / Assert
		await expect(
			store.prepareOperation({ producerId: 'producer', operationId: 'overflow', maximumBytes: 1 }),
		).rejects.toMatchObject({ reason: 'size-limit' });
		expect(await store.retireReceiver(receiver)).toEqual({ removed: 32, pending: 0 });
		await expect(
			store.prepareOperation({
				producerId: 'producer',
				operationId: 'after-cleanup',
				maximumBytes: 1,
			}),
		).resolves.toEqual(expect.any(String));
	});
	it('does not expose an output exceeding the reserved publication bytes', async () => {
		// Arrange
		const { store } = await fixture();
		const receiverRoot = await store.prepareReceiverRoot(receiver.leafGeneration);
		const source = await store.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 5,
		});
		await writeFile(path.join(source, 'valid'), 'small');
		await writeFile(path.join(source, 'oversized'), 'another');
		// Act
		const published = await store.publish({
			producerId: 'producer',
			operationId: 'operation',
			receiver,
			relativePaths: ['valid', 'oversized'],
			withPublicationAuthority: async (expose) => await expose(),
			signal: new AbortController().signal,
		});
		// Assert
		expect(published.failedFiles).toEqual([{ relativePath: 'oversized', reason: 'size-limit' }]);
		expect(await readdir(path.join(receiverRoot, published.publicationId))).toEqual(['valid']);
	});
	it('retains an exposed publication when acknowledgement fails', async () => {
		// Arrange
		const { store, now } = await fixture();
		const receiverRoot = await store.prepareReceiverRoot(receiver.leafGeneration);
		const source = await store.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 1024,
		});
		await writeFile(path.join(source, 'file'), 'bytes');
		// Act / Assert
		await expect(
			store.publish({
				producerId: 'producer',
				operationId: 'operation',
				receiver,
				relativePaths: ['file'],
				withPublicationAuthority: async (expose) => {
					await expose();
					throw new Error('lost acknowledgement');
				},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('lost acknowledgement');
		expect(await readdir(receiverRoot)).toHaveLength(1);
		now.value += 3_600_000;
		expect(await store.reapExpired()).toEqual({ removed: 1, pending: 0 });
		expect(await readdir(receiverRoot)).toEqual([]);
	});

	it('publishes a valid sibling when another source file is absent', async () => {
		// Arrange
		const { store } = await fixture();
		const receiverRoot = await store.prepareReceiverRoot(receiver.leafGeneration);
		const source = await store.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 1024,
		});
		await writeFile(path.join(source, 'valid'), 'bytes');
		// Act
		const published = await store.publish({
			producerId: 'producer',
			operationId: 'operation',
			receiver,
			relativePaths: ['valid', 'missing'],
			withPublicationAuthority: async (expose) => await expose(),
			signal: new AbortController().signal,
		});
		// Assert
		expect(published.files).toHaveLength(1);
		expect(published.failedFiles).toEqual([{ relativePath: 'missing', reason: 'transfer-failed' }]);
		expect(await readFile(path.join(receiverRoot, published.publicationId, 'valid'), 'utf8')).toBe(
			'bytes',
		);
	});
	it('publishes into the receiving root, survives producer cleanup, and expires without deleting unrelated files', async () => {
		// Arrange
		const { root, now, store } = await fixture();
		await writeFile(path.join(root, 'sentinel'), 'keep');
		const receiverRoot = await store.prepareReceiverRoot(receiver.leafGeneration);
		const producer = await store.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 1024,
		});
		await writeFile(path.join(producer, 'report.txt'), 'report');
		// Act
		const published = await store.publish({
			producerId: 'producer',
			operationId: 'operation',
			receiver,
			relativePaths: ['report.txt'],
			withPublicationAuthority: async (expose) => await expose(),
			signal: new AbortController().signal,
		});
		await store.retireProducer('producer');
		// Assert
		expect(published.files[0]?.path).toBe(`/agent-vm/files/${published.publicationId}/report.txt`);
		expect(
			await readFile(path.join(receiverRoot, published.publicationId, 'report.txt'), 'utf8'),
		).toBe('report');
		now.value = published.expiresAtMs;
		expect(await store.reapExpired()).toEqual({ removed: 1, pending: 0 });
		expect(await readdir(receiverRoot)).toEqual([]);
		expect(await readFile(path.join(root, 'sentinel'), 'utf8')).toBe('keep');
	});

	it('cleans failed exposure and receiver retirement without touching another generation', async () => {
		// Arrange
		const { store } = await fixture();
		const receiverRoot = await store.prepareReceiverRoot(receiver.leafGeneration);
		const otherRoot = await store.prepareReceiverRoot('other-leaf');
		await mkdir(path.join(otherRoot, 'unrelated'));
		await writeFile(path.join(otherRoot, 'unrelated', 'sentinel'), 'keep');
		const operation = await store.prepareOperation({
			producerId: 'producer',
			operationId: 'operation',
			maximumBytes: 1024,
		});
		await writeFile(path.join(operation, 'file'), 'bytes');
		// Act / Assert
		await expect(
			store.publish({
				producerId: 'producer',
				operationId: 'operation',
				receiver,
				relativePaths: ['file'],
				withPublicationAuthority: async () => {
					throw new Error('policy changed');
				},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('policy changed');
		expect(await readdir(receiverRoot)).toEqual([]);
		const published = await store.publish({
			producerId: 'producer',
			operationId: 'operation',
			receiver,
			relativePaths: ['file'],
			withPublicationAuthority: async (expose) => await expose(),
			signal: new AbortController().signal,
		});
		expect(await store.retireReceiver(receiver)).toEqual({ removed: 1, pending: 0 });
		expect(await readdir(receiverRoot)).not.toContain(published.publicationId);
		expect(await readFile(path.join(otherRoot, 'unrelated', 'sentinel'), 'utf8')).toBe('keep');
	});
});
