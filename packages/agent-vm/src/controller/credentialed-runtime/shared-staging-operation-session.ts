import type { ToolVmWorkFileBinding } from '../files/current-tool-vm-work-files.js';
import type { OperationFileIdentity } from '../files/operation-file-relay.js';
import { OperationFolderAccessError } from '../files/operation-folder-guest-access.js';
import type { SharedStagingDirectoryStore } from '../files/shared-staging-directory-store.js';
import { writeSharedStagingInput } from '../files/shared-staging-file-copy.js';
import { listSharedStagingFiles } from '../files/shared-staging-manifest.js';

export interface SharedStagingOperationSession {
	readonly root: string;
	stageInput(
		relativePath: string,
		contents: AsyncIterable<Uint8Array>,
		expected: OperationFileIdentity,
	): Promise<void>;
	publish(request: {
		readonly receiver: ToolVmWorkFileBinding;
		readonly withPublicationAuthority: (expose: () => Promise<void>) => Promise<void>;
	}): ReturnType<SharedStagingDirectoryStore['publish']>;
}

/** Runs under the existing credentialed command reservation, never across human approval. */
export async function createSharedStagingOperationSession(props: {
	readonly store: SharedStagingDirectoryStore;
	readonly producerId: string;
	readonly operationId: string;
	readonly maximumBytes: number;
	readonly signal: AbortSignal;
	readonly authorityIsCurrent: () => boolean;
}): Promise<SharedStagingOperationSession> {
	if (!props.authorityIsCurrent()) throw new OperationFolderAccessError('unavailable');
	const operationId = `operation-${props.operationId}`;
	const directory = await props.store.prepareOperation({
		producerId: props.producerId,
		operationId,
		maximumBytes: props.maximumBytes,
	});
	let stagedBytes = 0;
	let failed = false;
	let publishing = false;
	return {
		root: `/agent-vm/gog-work/${operationId}`,
		stageInput: async (relativePath, contents, expected) => {
			if (
				failed ||
				publishing ||
				!props.authorityIsCurrent() ||
				stagedBytes + expected.byteLength > props.maximumBytes
			)
				throw new OperationFolderAccessError('unavailable');
			stagedBytes += expected.byteLength;
			try {
				await writeSharedStagingInput({
					destinationRoot: directory,
					relativePath,
					contents,
					expected,
					signal: props.signal,
				});
			} catch (error) {
				failed = true;
				throw error;
			}
		},
		publish: async (request) => {
			if (failed || publishing || !props.authorityIsCurrent())
				throw new OperationFolderAccessError('unavailable');
			publishing = true;
			const manifest = await listSharedStagingFiles(directory, props.signal);
			const result = await props.store.publish({
				producerId: props.producerId,
				operationId,
				receiver: request.receiver,
				relativePaths: manifest.regularFiles,
				withPublicationAuthority: request.withPublicationAuthority,
				signal: props.signal,
			});
			return {
				...result,
				failedFiles: [
					...result.failedFiles,
					...manifest.unsupportedPaths.map((relativePath) => ({
						relativePath,
						reason: 'invalid-path',
					})),
				],
			};
		},
	};
}
