import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { ToolVmWorkFileBinding } from './current-tool-vm-work-files.js';
import type { OperationFileIdentity } from './operation-file-relay.js';
import type { OperationFileRetentionOwner } from './operation-file-retention-budget.js';
import {
	operationFolderFileLimit,
	OperationFolderAccessError,
} from './operation-folder-guest-access.js';
import {
	copySharedStagingFile,
	readSharedStagingFile,
	SharedStagingCopyCleanupError,
} from './shared-staging-file-copy.js';
import {
	createSharedStagingLifecycle,
	type SharedStagingLifecycle,
	type SharedStagingPublication,
} from './shared-staging-lifecycle.js';

interface PreparedOperation {
	readonly producerId: string;
	readonly operationId: string;
	readonly directory: string;
	readonly reservationId: string;
	readonly maximumBytes: number;
	publishing: boolean;
	publicationRetained: boolean;
	sourceCleaned: boolean;
}

export interface SharedStagingPublishedFile extends OperationFileIdentity {
	readonly relativePath: string;
	readonly path: string;
}

export interface SharedStagingDirectoryStore {
	readPublishedFile(request: {
		readonly publicationId: string;
		readonly receiver: ToolVmWorkFileBinding;
		readonly relativePath: string;
		readonly signal: AbortSignal;
	}): AsyncIterable<Uint8Array>;
	prepareProducerRoot(producerId: string): Promise<string>;
	prepareReceiverRoot(leafGeneration: string): Promise<string>;
	prepareOperation(props: {
		readonly producerId: string;
		readonly operationId: string;
		readonly maximumBytes: number;
	}): Promise<string>;
	publish(props: {
		readonly producerId: string;
		readonly operationId: string;
		readonly receiver: ToolVmWorkFileBinding;
		readonly relativePaths: readonly string[];
		/** Caller joins final current-policy/receiver checks to the filesystem exposure. */
		readonly withPublicationAuthority: (expose: () => Promise<void>) => Promise<void>;
		readonly signal: AbortSignal;
	}): Promise<
		SharedStagingPublication & {
			readonly files: readonly SharedStagingPublishedFile[];
			readonly failedFiles: readonly { readonly relativePath: string; readonly reason: string }[];
			readonly cleanup: 'complete' | 'pending';
		}
	>;
	retireProducer(producerId: string): Promise<void>;
	retireReceiver: SharedStagingLifecycle['retireReceiver'];
	reapExpired: SharedStagingLifecycle['reapExpired'];
}

function requireDirectoryId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))
		throw new OperationFolderAccessError('invalid-path');
	return value;
}

/** One agent/run's owned host subtree. Startup recovery removes old roots after VM containment. */
export async function createSharedStagingDirectoryStore(props: {
	readonly root: string;
	readonly now: () => number;
	readonly retention: OperationFileRetentionOwner;
}): Promise<SharedStagingDirectoryStore> {
	if (!path.isAbsolute(props.root) || path.parse(props.root).root === props.root)
		throw new OperationFolderAccessError('invalid-path');
	await mkdir(props.root, { mode: 0o700 });
	const root = await realpath(props.root);
	const producerRoot = path.join(root, 'producer');
	const receiverRoot = path.join(root, 'receiver');
	const privateRoot = path.join(root, 'private');
	await Promise.all(
		[producerRoot, receiverRoot, privateRoot].map(
			async (directory) => await mkdir(directory, { mode: 0o700 }),
		),
	);
	const operations = new Map<string, PreparedOperation>();
	const producers = new Map<string, Promise<string>>();
	const receivers = new Map<string, Promise<string>>();
	const lifecycle = createSharedStagingLifecycle({ now: props.now });
	const pendingCleanup = new Map<string, () => Promise<void>>();
	const attemptCleanup = async (id: string, remove: () => Promise<void>): Promise<boolean> => {
		try {
			await remove();
			pendingCleanup.delete(id);
			return true;
		} catch {
			pendingCleanup.set(id, remove);
			return false;
		}
	};
	const prepareChild = (
		parent: string,
		id: string,
		entries: Map<string, Promise<string>>,
	): Promise<string> => {
		requireDirectoryId(id);
		const existing = entries.get(id);
		if (existing !== undefined) return existing;
		const directory = path.join(parent, id);
		const preparing = mkdir(directory, { mode: 0o700 }).then(() => directory);
		entries.set(id, preparing);
		return preparing;
	};
	const operationKey = (producerId: string, operationId: string): string =>
		`${requireDirectoryId(producerId)}/${requireDirectoryId(operationId)}`;
	const removeOperation = async (operation: PreparedOperation): Promise<void> => {
		await rm(operation.directory, { recursive: true, force: true });
		props.retention.releaseAfterCleanup(operation.reservationId);
		operation.sourceCleaned = true;
		if (!operation.publicationRetained)
			operations.delete(operationKey(operation.producerId, operation.operationId));
	};
	return {
		readPublishedFile: async function* (request) {
			if (lifecycle.lookup(request.publicationId, request.receiver) === undefined)
				throw new OperationFolderAccessError('unavailable');
			const receiving = receivers.get(request.receiver.leafGeneration);
			if (receiving === undefined) throw new OperationFolderAccessError('unavailable');
			yield* readSharedStagingFile({
				root: path.join(await receiving, request.publicationId),
				relativePath: request.relativePath,
				signal: request.signal,
			});
		},
		prepareProducerRoot: async (producerId) =>
			await prepareChild(producerRoot, producerId, producers),
		prepareReceiverRoot: async (leafGeneration) =>
			await prepareChild(receiverRoot, leafGeneration, receivers),
		prepareOperation: async ({ producerId, operationId, maximumBytes }) => {
			const key = operationKey(producerId, operationId);
			if (
				operations.has(key) ||
				operations.size >= 32 ||
				!props.retention.reserve(key, maximumBytes)
			)
				throw new OperationFolderAccessError('size-limit');
			const directory = path.join(producerRoot, producerId, operationId);
			const operation: PreparedOperation = {
				producerId,
				operationId,
				directory,
				reservationId: key,
				maximumBytes,
				publishing: false,
				publicationRetained: false,
				sourceCleaned: false,
			};
			operations.set(key, operation);
			try {
				await prepareChild(producerRoot, producerId, producers);
				await mkdir(directory, { mode: 0o700 });
				return directory;
			} catch (error) {
				operations.delete(key);
				props.retention.releaseAfterCleanup(key);
				throw error;
			}
		},
		publish: async (request) => {
			const operation = operations.get(operationKey(request.producerId, request.operationId));
			const receiving = receivers.get(request.receiver.leafGeneration);
			if (
				operation === undefined ||
				operation.publishing ||
				operation.publicationRetained ||
				operation.sourceCleaned ||
				receiving === undefined
			)
				throw new OperationFolderAccessError('unavailable');
			if (
				request.relativePaths.length === 0 ||
				request.relativePaths.length > 4096 ||
				new Set(request.relativePaths).size !== request.relativePaths.length
			)
				throw new OperationFolderAccessError('size-limit');
			request.signal.throwIfAborted();
			const publicationId = randomUUID();
			const reservationId = `publication-${publicationId}`;
			if (!props.retention.reserve(reservationId, operation.maximumBytes))
				throw new OperationFolderAccessError('size-limit');
			operation.publishing = true;
			const temporary = path.join(privateRoot, publicationId);
			let temporaryCreated = false;
			let exposed = false;
			let exposeStarted = false;
			let destination: string | undefined;
			let publication: SharedStagingPublication | undefined;
			try {
				await mkdir(temporary, { mode: 0o700 });
				temporaryCreated = true;
				const files: SharedStagingPublishedFile[] = [];
				const failedFiles: { relativePath: string; reason: string }[] = [];
				let totalBytes = 0;
				for (const relativePath of request.relativePaths) {
					try {
						// oxlint-disable-next-line no-await-in-loop -- bounded copy buffer is reused file-by-file.
						const identity = await copySharedStagingFile({
							sourceRoot: operation.directory,
							destinationRoot: temporary,
							relativePath,
							signal: request.signal,
							maximumBytes: Math.min(operationFolderFileLimit, operation.maximumBytes - totalBytes),
						});
						totalBytes += identity.byteLength;
						if (totalBytes > operation.maximumBytes)
							throw new OperationFolderAccessError('size-limit');
						files.push({
							relativePath,
							path: `/agent-vm/files/${publicationId}/${relativePath}`,
							...identity,
						});
					} catch (error) {
						if (error instanceof SharedStagingCopyCleanupError) throw error;
						request.signal.throwIfAborted();
						failedFiles.push({
							relativePath,
							reason:
								error instanceof OperationFolderAccessError ? error.reason : 'transfer-failed',
						});
					}
				}
				if (files.length === 0) throw new OperationFolderAccessError('transfer-failed');
				if (!props.retention.resize(reservationId, totalBytes))
					throw new OperationFolderAccessError('size-limit');
				destination = path.join(await receiving, publicationId);
				const publishedDirectory = destination;
				await request.withPublicationAuthority(async () => {
					if (exposeStarted) throw new OperationFolderAccessError('unavailable');
					exposeStarted = true;
					request.signal.throwIfAborted();
					await rename(temporary, publishedDirectory);
					exposed = true;
					operation.publicationRetained = true;
					publication = lifecycle.track({
						publicationId,
						receiver: request.receiver,
						remove: async () => {
							await rm(publishedDirectory, { recursive: true, force: true });
							props.retention.releaseAfterCleanup(reservationId);
							operation.publicationRetained = false;
							if (operation.sourceCleaned)
								operations.delete(operationKey(operation.producerId, operation.operationId));
						},
					});
				});
				if (publication === undefined) throw new OperationFolderAccessError('unavailable');
				// Source cleanup failure cannot retract delivered bytes or release its reservation.
				const cleaned = await attemptCleanup(
					operation.reservationId,
					async () => await removeOperation(operation),
				);
				return { ...publication, files, failedFiles, cleanup: cleaned ? 'complete' : 'pending' };
			} catch (error) {
				if (exposed) throw error; // Delivered files retain normal lifecycle after acknowledgement loss.
				await attemptCleanup(reservationId, async () => {
					if (temporaryCreated)
						await rm(temporary, {
							recursive: true,
							force: true,
						});
					props.retention.releaseAfterCleanup(reservationId);
				});
				throw error;
			} finally {
				operation.publishing = false;
			}
		},
		retireProducer: async (producerId) => {
			requireDirectoryId(producerId);
			const selected = [...operations.values()].filter(
				(operation) => operation.producerId === producerId,
			);
			if (selected.some((operation) => operation.publishing))
				throw new OperationFolderAccessError('unavailable');
			await Promise.all(selected.map(removeOperation));
		},
		retireReceiver: async (receiver) => await lifecycle.retireReceiver(receiver),
		reapExpired: async () => {
			const expired = await lifecycle.reapExpired();
			const retried = await Promise.all(
				[...pendingCleanup].map(async ([id, remove]) => await attemptCleanup(id, remove)),
			);
			return {
				removed: expired.removed + retried.filter(Boolean).length,
				pending: expired.pending + retried.filter((success) => !success).length,
			};
		},
	};
}
