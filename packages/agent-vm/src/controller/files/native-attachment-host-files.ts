import { createHash } from 'node:crypto';
import { link, lstat, mkdir, opendir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { OperationFileStagingWriter } from './operation-file-relay.js';
import {
	assertOperationRelativePath,
	OperationFolderAccessError,
	type OperationFolderGuestAccess,
} from './operation-folder-guest-access.js';
import { readSharedStagingFile, writeSharedStagingBytes } from './shared-staging-file-copy.js';

function identityDirectory(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

async function privateChild(parent: string, name: string): Promise<string> {
	const child = path.join(parent, name);
	try {
		await mkdir(child, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
	}
	const status = await lstat(child);
	if (!status.isDirectory() || status.isSymbolicLink())
		throw new OperationFolderAccessError('invalid-path');
	return child;
}

/** Uses the already-mounted Gateway cache; no new mount or rootfs file-write protocol. */
export async function createNativeAttachmentHostFiles(props: {
	readonly cacheDirectory: string;
	readonly controllerEpoch: string;
	readonly gatewayVmId: string;
	readonly signal: AbortSignal;
}): Promise<{
	readonly guestRoot: string;
	readonly destination: Pick<
		OperationFolderGuestAccess,
		'createDirectory' | 'publish' | 'removeOwned'
	>;
	readonly writer: OperationFileStagingWriter;
}> {
	const cache = await realpath(props.cacheDirectory);
	const owned = await privateChild(cache, 'agent-vm-native');
	const run = identityDirectory(props.controllerEpoch);
	const gateway = identityDirectory(props.gatewayVmId);
	const hostRoot = await privateChild(await privateChild(owned, run), gateway);
	const guestRoot = `/home/hermes/.cache/agent-vm-native/${run}/${gateway}`;
	const hostPath = (relativePath: string): string => {
		assertOperationRelativePath(relativePath);
		return path.join(hostRoot, relativePath);
	};
	return {
		guestRoot,
		writer: {
			writeFileStream: async (request) => {
				if (!request.guestPath.startsWith(`${guestRoot}/`))
					throw new OperationFolderAccessError('invalid-path');
				await writeSharedStagingBytes({
					destinationRoot: hostRoot,
					relativePath: request.guestPath.slice(guestRoot.length + 1),
					contents: request.contents,
					signal: request.signal ?? props.signal,
				});
			},
		},
		destination: {
			createDirectory: async (relativePath) => {
				props.signal.throwIfAborted();
				await mkdir(hostPath(relativePath), { mode: 0o700 });
			},
			removeOwned: async (relativePath) => {
				await rm(hostPath(relativePath), { recursive: true, force: true });
			},
			publish: async (publication) => {
				assertOperationRelativePath(publication.finalName);
				if (publication.finalName.includes('/'))
					throw new OperationFolderAccessError('invalid-path');
				const digest = createHash('sha256');
				let byteLength = 0;
				for await (const chunk of readSharedStagingFile({
					root: hostRoot,
					relativePath: publication.temporaryRelativePath,
					signal: props.signal,
				})) {
					digest.update(chunk);
					byteLength += chunk.byteLength;
				}
				if (byteLength !== publication.byteLength || digest.digest('hex') !== publication.sha256)
					throw new OperationFolderAccessError('integrity-mismatch');
				props.signal.throwIfAborted();
				const temporary = hostPath(publication.temporaryRelativePath);
				await link(temporary, path.join(path.dirname(temporary), publication.finalName));
				try {
					await unlink(temporary);
					return { kind: 'published', cleanup: 'complete' };
				} catch {
					return { kind: 'published', cleanup: 'pending' };
				}
			},
		},
	};
}

/** Existing Gateway recovery must prove containment before this host-data cleanup. */
export async function cleanupNativeAttachmentCacheAfterContainment(
	cacheDirectory: string,
): Promise<void> {
	const owned = path.join(cacheDirectory, 'agent-vm-native');
	let status;
	try {
		status = await lstat(owned);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
		throw error;
	}
	if (!status.isDirectory() || status.isSymbolicLink())
		throw new OperationFolderAccessError('invalid-path');
	const runs = await opendir(owned);
	for await (const run of runs) {
		if (!run.isDirectory() || !/^[a-f0-9]{64}$/u.test(run.name)) continue;
		const runDirectory = path.join(owned, run.name);
		// oxlint-disable-next-line no-await-in-loop -- recovery visits only controlled generation namespaces.
		const gateways = await opendir(runDirectory);
		for await (const gateway of gateways) {
			if (!gateway.isDirectory() || !/^[a-f0-9]{64}$/u.test(gateway.name)) continue;
			// oxlint-disable-next-line no-await-in-loop -- remove only each validated, contained generation subtree.
			await rm(path.join(runDirectory, gateway.name), { recursive: true, force: true });
		}
		try {
			// oxlint-disable-next-line no-await-in-loop -- never recursively remove unknown children left in a run directory.
			await rmdir(runDirectory);
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY')) throw error;
		}
	}
}
