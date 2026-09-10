import {
	gogFileInputSnapshotSchema,
	normalizeGogFileArgument,
	type GogFileInputSnapshot,
} from '@agent-vm/oauth-broker-contracts';

import type { ToolVmWorkFileBinding } from './current-tool-vm-work-files.js';
import { inspectOperationFileInput } from './operation-file-relay.js';
import {
	OperationFolderAccessError,
	type OperationFolderGuestAccess,
} from './operation-folder-guest-access.js';

/** The caller holds current Tool VM /work access; no payload survives this preflight. */
export async function inspectGogFileInputs(props: {
	readonly binding: ToolVmWorkFileBinding;
	readonly paths: readonly string[];
	readonly files: Pick<OperationFolderGuestAccess, 'read'>;
	readonly signal: AbortSignal;
}): Promise<GogFileInputSnapshot> {
	const binding = { ...props.binding };
	if (props.paths.length === 0 || props.paths.length > 128)
		throw new OperationFolderAccessError('invalid-path');
	const names = new Set<string>();
	for (const value of props.paths) {
		const relativePath = normalizeGogFileArgument(value, 'file');
		if (relativePath === undefined) throw new OperationFolderAccessError('invalid-path');
		names.add(relativePath);
	}
	const files: GogFileInputSnapshot['files'][number][] = [];
	let totalBytes = 0;
	for (const relativePath of names) {
		// oxlint-disable-next-line no-await-in-loop -- preserve bounded source VM work and descriptor order.
		const identity = await inspectOperationFileInput({
			source: props.files,
			relativePath,
			signal: props.signal,
		});
		totalBytes += identity.byteLength;
		if (totalBytes > 64 * 1024 * 1024) throw new OperationFolderAccessError('size-limit');
		files.push({ relativePath, ...identity });
	}
	return gogFileInputSnapshotSchema.parse({ ...binding, files });
}
