import { createHash, randomUUID } from 'node:crypto';

import type { ManagedVm } from '@agent-vm/managed-vm';

import type { OperationFileIdentity } from '../files/operation-file-relay.js';
import {
	assertOperationRelativePath,
	createOperationFolderGuestAccess,
	loadOperationFolderGuestProgram,
	operationFolderPythonExecutable,
	OperationFolderAccessError,
	type OperationFolderGuestAccess,
} from '../files/operation-folder-guest-access.js';
import type {
	CredentialedOperationFolders,
	CredentialedOperationFolderReference,
} from './credentialed-operation-folders.js';

export interface CredentialedOperationFolderSession {
	readonly root: string;
	stageInput(
		relativePath: string,
		contents: AsyncIterable<Uint8Array>,
		expected: OperationFileIdentity,
	): Promise<void>;
	seal(): Promise<CredentialedOperationFolderReference>;
}

/** Caller holds the existing runtime lock; release accounting only after actual cleanup. */
export async function removeExpiredCredentialedOperationFolders(props: {
	readonly vm: ManagedVm;
	readonly folders: CredentialedOperationFolders;
	readonly workRoot: string;
	readonly nowMs: number;
}): Promise<void> {
	const expired = props.folders.expired(props.nowMs);
	if (expired.length === 0) return;
	const files = createOperationFolderGuestAccess({
		vm: props.vm,
		root: props.workRoot,
		program: await loadOperationFolderGuestProgram(),
		pythonExecutable: operationFolderPythonExecutable,
		signal: AbortSignal.timeout(30_000),
	});
	for (const folder of expired) {
		if (!folder.directory.startsWith(`${props.workRoot}/`))
			throw new OperationFolderAccessError('invalid-path');
		// oxlint-disable-next-line no-await-in-loop -- keep guest filesystem operations serialized on this VM.
		await files.removeOwned(folder.directory.slice(props.workRoot.length + 1));
		props.folders.removeAfterCleanup(folder.operationId);
	}
}

/** Lives only inside an acquired runtime command; no reservation spans human approval. */
export async function createCredentialedOperationFolderSession(props: {
	readonly vm: ManagedVm;
	readonly folders: CredentialedOperationFolders;
	readonly operationId: string;
	readonly workRoot: string;
	readonly maximumBytes: number;
	readonly signal: AbortSignal;
	readonly now: () => number;
	readonly authorityIsCurrent: () => boolean;
}): Promise<CredentialedOperationFolderSession> {
	if (!/^[a-f0-9-]{36}$/u.test(props.operationId))
		throw new OperationFolderAccessError('invalid-path');
	const operationId = props.operationId;
	const name = `operation-${operationId}`;
	const root = `${props.workRoot}/${name}`;
	const transfer = props.vm.fileTransfer;
	if (transfer === undefined || !props.authorityIsCurrent())
		throw new OperationFolderAccessError('unavailable');
	if (!props.folders.reserve({ operationId, directory: root, maximumBytes: props.maximumBytes }))
		throw new OperationFolderAccessError('size-limit');
	const program = await loadOperationFolderGuestProgram();
	const parent = createOperationFolderGuestAccess({
		vm: props.vm,
		root: props.workRoot,
		program,
		pythonExecutable: operationFolderPythonExecutable,
		signal: props.signal,
	});
	await parent.createDirectory(name);
	const files: OperationFolderGuestAccess = createOperationFolderGuestAccess({
		vm: props.vm,
		root,
		program,
		pythonExecutable: operationFolderPythonExecutable,
		signal: props.signal,
	});
	let sealed = false;
	let stagedBytes = 0;
	const stagedPaths = new Set<string>();
	const createdDirectories = new Set<string>();
	return {
		root,
		stageInput: async (relativePath, contents, expected) => {
			if (sealed || !props.authorityIsCurrent())
				throw new OperationFolderAccessError('unavailable');
			assertOperationRelativePath(relativePath);
			if (stagedPaths.has(relativePath))
				throw new OperationFolderAccessError('destination-conflict');
			stagedPaths.add(relativePath);
			const byteIdentity = { ...expected };
			if (
				!Number.isSafeInteger(byteIdentity.byteLength) ||
				byteIdentity.byteLength < 0 ||
				byteIdentity.byteLength > 16 * 1024 * 1024 ||
				stagedBytes + byteIdentity.byteLength > props.maximumBytes
			)
				throw new OperationFolderAccessError('size-limit');
			stagedBytes += byteIdentity.byteLength;
			const components = relativePath.split('/');
			for (let index = 1; index < components.length; index++) {
				const directory = components.slice(0, index).join('/');
				if (!createdDirectories.has(directory)) {
					// oxlint-disable-next-line no-await-in-loop -- each parent must exist before creating its child.
					await files.createDirectory(directory);
					createdDirectories.add(directory);
				}
			}
			let byteLength = 0;
			let complete = false;
			const digest = createHash('sha256');
			async function* verifiedInput(): AsyncIterable<Uint8Array> {
				for await (const chunk of contents) {
					props.signal.throwIfAborted();
					if (!props.authorityIsCurrent()) throw new OperationFolderAccessError('unavailable');
					byteLength += chunk.byteLength;
					if (byteLength > byteIdentity.byteLength)
						throw new OperationFolderAccessError('size-limit');
					digest.update(chunk);
					yield chunk;
				}
				complete = true;
			}
			await transfer.writeFileStream({
				guestPath: `${root}/${relativePath}`,
				contents: verifiedInput(),
				signal: props.signal,
			});
			if (
				!complete ||
				byteLength !== byteIdentity.byteLength ||
				digest.digest('hex') !== byteIdentity.sha256 ||
				!props.authorityIsCurrent()
			)
				throw new OperationFolderAccessError('integrity-mismatch');
		},
		seal: async () => {
			if (sealed || !props.authorityIsCurrent())
				throw new OperationFolderAccessError('unavailable');
			sealed = true;
			const inventory = await files.inventory();
			if (!props.authorityIsCurrent()) throw new OperationFolderAccessError('unavailable');
			const reference = props.folders.complete({
				operationId,
				referenceId: randomUUID(),
				byteLength: inventory.byteLength,
				completedAtMs: props.now(),
				authorityIsCurrent: props.authorityIsCurrent,
			});
			if (reference === undefined) throw new OperationFolderAccessError('size-limit');
			return reference;
		},
	};
}
