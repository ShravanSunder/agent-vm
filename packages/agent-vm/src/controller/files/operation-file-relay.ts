import { createHash } from 'node:crypto';

import {
	assertOperationRelativePath,
	OperationFolderAccessError,
	operationFolderFileLimit,
	type OperationFolderGuestAccess,
} from './operation-folder-guest-access.js';

export interface OperationFileIdentity {
	readonly byteLength: number;
	readonly sha256: string;
}

/** Host-staging writer; not a VM filesystem capability. */
export interface OperationFileStagingWriter {
	writeFileStream(request: {
		readonly contents: AsyncIterable<Uint8Array>;
		readonly guestPath: string;
		readonly signal?: AbortSignal;
	}): Promise<void>;
}

export type OperationFileRelayResult =
	| {
			readonly kind: 'published';
			readonly path: string;
			readonly identity: OperationFileIdentity;
			readonly cleanup: 'complete' | 'pending';
	  }
	| { readonly kind: 'failed'; readonly reason: string; readonly cleanup: 'complete' | 'pending' };

/** Hash-only preflight; reads through the caller's current VM authority without retaining bytes. */
export async function inspectOperationFileInput(props: {
	readonly source: Pick<OperationFolderGuestAccess, 'read'>;
	readonly relativePath: string;
	readonly signal: AbortSignal;
}): Promise<OperationFileIdentity> {
	assertOperationRelativePath(props.relativePath);
	const digest = createHash('sha256');
	let byteLength = 0;
	for await (const chunk of props.source.read(props.relativePath)) {
		props.signal.throwIfAborted();
		byteLength += chunk.byteLength;
		if (byteLength > operationFolderFileLimit) throw new OperationFolderAccessError('size-limit');
		digest.update(chunk);
	}
	props.signal.throwIfAborted();
	return { byteLength, sha256: digest.digest('hex') };
}

/** Both roots/VMs and the fresh destination directory come from controller authority. */
export async function relayOperationFile(props: {
	readonly source: Pick<OperationFolderGuestAccess, 'read'>;
	readonly sourceRelativePath: string;
	readonly destination: Pick<
		OperationFolderGuestAccess,
		'createDirectory' | 'publish' | 'removeOwned'
	>;
	readonly destinationWriter: OperationFileStagingWriter;
	readonly destinationRoot: string;
	readonly destinationDirectory: string;
	readonly finalName: string;
	readonly expectedIdentity?: OperationFileIdentity;
	readonly signal: AbortSignal;
	readonly authorityIsCurrent: () => boolean;
}): Promise<OperationFileRelayResult> {
	const sourceRelativePath = props.sourceRelativePath;
	const directory = props.destinationDirectory;
	const finalName = props.finalName;
	const expectedIdentity =
		props.expectedIdentity === undefined ? undefined : { ...props.expectedIdentity };
	assertOperationRelativePath(sourceRelativePath);
	assertOperationRelativePath(directory);
	assertOperationRelativePath(finalName);
	if (
		finalName.includes('/') ||
		!props.destinationRoot.startsWith('/') ||
		props.destinationRoot === '/'
	)
		throw new OperationFolderAccessError('invalid-path');
	assertOperationRelativePath(props.destinationRoot.slice(1));
	const temporaryName = finalName === 'incoming.part' ? 'incoming-other.part' : 'incoming.part';
	const temporaryRelativePath = `${directory}/${temporaryName}`;
	const destinationPath = `${props.destinationRoot}/${directory}/${finalName}`;
	const temporaryPath = `${props.destinationRoot}/${temporaryRelativePath}`;
	const requireAuthority = (): void => {
		props.signal.throwIfAborted();
		if (!props.authorityIsCurrent()) throw new OperationFolderAccessError('unavailable');
	};
	let directoryOwned = false;
	try {
		requireAuthority();
		await props.destination.createDirectory(directory);
		directoryOwned = true;
		const digest = createHash('sha256');
		let byteLength = 0;
		let sourceCompleted = false;
		async function* sourceBytes(): AsyncIterable<Uint8Array> {
			for await (const chunk of props.source.read(sourceRelativePath)) {
				requireAuthority();
				byteLength += chunk.byteLength;
				if (
					byteLength > operationFolderFileLimit ||
					(expectedIdentity !== undefined && byteLength > expectedIdentity.byteLength)
				)
					throw new OperationFolderAccessError('size-limit');
				digest.update(chunk);
				yield chunk;
			}
			sourceCompleted = true;
		}
		await props.destinationWriter.writeFileStream({
			contents: sourceBytes(),
			guestPath: temporaryPath,
			signal: props.signal,
		});
		if (!sourceCompleted) throw new OperationFolderAccessError('transfer-failed');
		const identity = { byteLength, sha256: digest.digest('hex') };
		if (
			expectedIdentity !== undefined &&
			(identity.byteLength !== expectedIdentity.byteLength ||
				identity.sha256 !== expectedIdentity.sha256)
		)
			throw new OperationFolderAccessError('integrity-mismatch');
		requireAuthority();
		const published = await props.destination.publish({
			temporaryRelativePath,
			finalName,
			...identity,
		});
		return { kind: 'published', path: destinationPath, identity, cleanup: published.cleanup };
	} catch (error) {
		let cleanup: 'complete' | 'pending' = 'complete';
		if (directoryOwned) {
			// The owner supplies bounded cleanup/containment. Never delete a preexisting
			// directory or final name after a publish acknowledgement was lost.
			try {
				await props.destination.removeOwned(temporaryRelativePath);
			} catch {
				cleanup = 'pending';
			}
		}
		return {
			kind: 'failed',
			reason: error instanceof OperationFolderAccessError ? error.reason : 'transfer-failed',
			cleanup,
		};
	}
}
