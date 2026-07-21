import path from 'node:path';

import { SANDBOX_MAXIMUM_BINARY_BYTES } from '@agent-vm/agent-portal-sdk';

import type { StrictToolVmSshClient } from '../sandbox/strict-tool-vm-ssh-client.js';

const SANDBOX_FILESYSTEM_READ_ROOTS = ['/work', '/workspace', '/gitdirs', '/tmp'] as const;
const SANDBOX_FILESYSTEM_MUTATION_ROOTS = ['/work', '/workspace', '/gitdirs', '/tmp'] as const;
const SANDBOX_RECURSIVE_REMOVE_MAXIMUM_DEPTH = 32;
const SANDBOX_RECURSIVE_REMOVE_MAXIMUM_ENTRIES = 1_000;
const SANDBOX_RECURSIVE_REMOVE_MAXIMUM_MILLISECONDS = 60_000;

type SandboxFilesystemOperation = 'mutation' | 'read';
type SandboxFilesystemRemovalKind = 'directory' | 'file';

interface SandboxFilesystemRemovalEntry {
	readonly depth: number;
	readonly kind: SandboxFilesystemRemovalKind;
	readonly path: string;
}

function pathIsWithinRoot(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

function requirePathWithoutParentTraversal(requestedPath: string): void {
	if (requestedPath.includes('\0')) {
		throw new Error('Sandbox filesystem path must not contain NUL.');
	}
	if (requestedPath.split('/').includes('..')) {
		throw new Error('Sandbox filesystem path must not contain parent traversal.');
	}
}

function requireDirectoryEntryName(filename: string): void {
	if (
		filename.length === 0 ||
		filename === '.' ||
		filename === '..' ||
		filename.includes('/') ||
		filename.includes('\0')
	) {
		throw new Error('Sandbox filesystem traversal returned an invalid directory entry name.');
	}
}

function directoryEntryRemovalKind(longname: string): SandboxFilesystemRemovalKind {
	return longname.startsWith('d') ? 'directory' : 'file';
}

function throwIfRemovalBoundExpired(deadlineMilliseconds: number): void {
	if (Date.now() > deadlineMilliseconds) {
		throw new Error('Sandbox recursive removal exceeded its time bound.');
	}
}

export function resolveSandboxFilesystemPath(props: {
	readonly environmentLogicalCwd: string | undefined;
	readonly operation: SandboxFilesystemOperation;
	readonly requestedPath: string;
}): string {
	requirePathWithoutParentTraversal(props.requestedPath);
	const environmentCwd =
		props.environmentLogicalCwd === undefined
			? '/work'
			: path.posix.join('/work', props.environmentLogicalCwd);
	const resolvedPath = path.posix.normalize(
		path.posix.isAbsolute(props.requestedPath)
			? props.requestedPath
			: path.posix.join(environmentCwd, props.requestedPath),
	);
	const admittedRoots =
		props.operation === 'read' ? SANDBOX_FILESYSTEM_READ_ROOTS : SANDBOX_FILESYSTEM_MUTATION_ROOTS;
	if (!admittedRoots.some((root) => pathIsWithinRoot(resolvedPath, root))) {
		throw new Error('Sandbox filesystem path is outside the operation-admitted guest roots.');
	}
	return resolvedPath;
}

export function requireSandboxFilesystemWriteLength(props: {
	readonly existingByteLength: number;
	readonly incomingByteLength: number;
	readonly offsetBytes: number;
}): number {
	if (
		!Number.isSafeInteger(props.existingByteLength) ||
		props.existingByteLength < 0 ||
		props.existingByteLength > SANDBOX_MAXIMUM_BINARY_BYTES ||
		props.offsetBytes > SANDBOX_MAXIMUM_BINARY_BYTES - props.incomingByteLength
	) {
		throw new Error('Sandbox filesystem write exceeds the canonical byte ceiling.');
	}
	return Math.max(props.existingByteLength, props.offsetBytes + props.incomingByteLength);
}

export function throwIfSandboxFilesystemRequestAborted(signal: AbortSignal): void {
	signal.throwIfAborted();
}

export function throwIfSandboxFilesystemMutationAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	throw new Error(
		'Sandbox filesystem mutation cancellation has an ambiguous outcome because guest side effects may have completed.',
		{ cause: signal.reason },
	);
}

export async function removeBoundedSandboxFilesystemTree(props: {
	readonly rootKind: SandboxFilesystemRemovalKind;
	readonly rootPath: string;
	readonly signal: AbortSignal;
	readonly strictSshClient: StrictToolVmSshClient;
}): Promise<void> {
	const deadlineMilliseconds = Date.now() + SANDBOX_RECURSIVE_REMOVE_MAXIMUM_MILLISECONDS;
	const pendingEntries: SandboxFilesystemRemovalEntry[] = [
		{ depth: 0, kind: props.rootKind, path: props.rootPath },
	];
	const removalEntries: SandboxFilesystemRemovalEntry[] = [];

	while (pendingEntries.length > 0) {
		throwIfSandboxFilesystemRequestAborted(props.signal);
		throwIfRemovalBoundExpired(deadlineMilliseconds);
		const currentEntry = pendingEntries.pop();
		if (currentEntry === undefined) break;
		if (removalEntries.length >= SANDBOX_RECURSIVE_REMOVE_MAXIMUM_ENTRIES) {
			throw new Error('Sandbox recursive removal exceeded its total entry bound.');
		}
		removalEntries.push(currentEntry);
		if (currentEntry.kind !== 'directory') continue;
		// oxlint-disable-next-line no-await-in-loop -- Removal discovery is serial and bounded for deterministic fencing.
		const children = await props.strictSshClient.guestListDirectory({ path: currentEntry.path });
		for (const child of children) {
			if (child.filename === '.' || child.filename === '..') continue;
			requireDirectoryEntryName(child.filename);
			const childDepth = currentEntry.depth + 1;
			if (childDepth > SANDBOX_RECURSIVE_REMOVE_MAXIMUM_DEPTH) {
				throw new Error('Sandbox recursive removal exceeded its depth bound.');
			}
			if (
				removalEntries.length + pendingEntries.length >=
				SANDBOX_RECURSIVE_REMOVE_MAXIMUM_ENTRIES
			) {
				throw new Error('Sandbox recursive removal exceeded its total entry bound.');
			}
			const childPath = resolveSandboxFilesystemPath({
				environmentLogicalCwd: undefined,
				operation: 'mutation',
				requestedPath: path.posix.join(currentEntry.path, child.filename),
			});
			pendingEntries.push({
				depth: childDepth,
				kind: directoryEntryRemovalKind(child.longname),
				path: childPath,
			});
		}
	}

	let mutationMayHaveApplied = false;
	for (const removalEntry of removalEntries.toReversed()) {
		if (mutationMayHaveApplied) {
			throwIfSandboxFilesystemMutationAborted(props.signal);
		} else {
			throwIfSandboxFilesystemRequestAborted(props.signal);
		}
		throwIfRemovalBoundExpired(deadlineMilliseconds);
		// oxlint-disable-next-line no-await-in-loop -- Children must be removed before their parent directory.
		await props.strictSshClient.guestRemove({
			kind: removalEntry.kind,
			path: removalEntry.path,
		});
		mutationMayHaveApplied = true;
		throwIfSandboxFilesystemMutationAborted(props.signal);
	}
}
