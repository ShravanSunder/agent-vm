import { opendir } from 'node:fs/promises';
import path from 'node:path';

import {
	assertOperationRelativePath,
	OperationFolderAccessError,
} from './operation-folder-guest-access.js';

/** Inspect a stopped producer's owned directory without collecting an unbounded tree. */
export async function listSharedStagingFiles(
	root: string,
	signal: AbortSignal,
): Promise<{
	readonly regularFiles: readonly string[];
	readonly unsupportedPaths: readonly string[];
}> {
	const regularFiles: string[] = [];
	const unsupportedPaths: string[] = [];
	let inspected = 0;
	async function visit(relativeDirectory: string, depth: number): Promise<void> {
		signal.throwIfAborted();
		if (depth > 32) throw new OperationFolderAccessError('size-limit');
		const entries = await opendir(path.join(root, relativeDirectory));
		for await (const entry of entries) {
			signal.throwIfAborted();
			if (++inspected > 4096) throw new OperationFolderAccessError('size-limit');
			const relativePath =
				relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
			assertOperationRelativePath(relativePath);
			if (entry.isFile()) regularFiles.push(relativePath);
			else if (entry.isDirectory()) {
				// oxlint-disable-next-line no-await-in-loop -- bounded depth-first enumeration avoids parallel open-directory fanout.
				await visit(relativePath, depth + 1);
			} else unsupportedPaths.push(relativePath);
		}
	}
	await visit('', 0);
	return { regularFiles, unsupportedPaths };
}
