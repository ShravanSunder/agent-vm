import { createHash, randomUUID } from 'node:crypto';

import { ArtifactReferenceSchema, type ArtifactReference } from '@agent-vm/agent-portal-sdk';

import { GatewayRuntimeArtifactReadCallerSchema } from './artifact-read-authority.js';
import type {
	GatewayRuntimeArtifactReadCaller,
	GatewayRuntimeArtifactReader,
} from './artifact-store.js';
import {
	GatewayRuntimeArtifactDeliveryError,
	readVerifiedGatewayArtifact,
} from './verified-artifact-reader.js';

const workspaceRootPath = '/workspace';
const publicationRootPath = `${workspaceRootPath}/.tool-portal`;
const maximumFileNameBytes = 128;
const maximumCleanupDeadlineMilliseconds = 60_000;

export type WorkspaceArtifactFileStat =
	| { readonly kind: 'directory' | 'missing' | 'other' | 'symbolic-link' }
	| { readonly byteLength: number; readonly kind: 'file' };

/**
 * Lease-bound filesystem capability for server-selected absolute guest paths.
 * Implementations must fence symlinks on every operation and make no-replace
 * publication atomic. A failed exclusive write reports whether it created the
 * temporary file so the coordinator never removes a path it does not own. Every
 * operation must honor its AbortSignal and settle only after it can guarantee no
 * later filesystem mutation from that operation.
 */
export interface WorkspaceArtifactFilesystemPort {
	readonly mkdir: (props: {
		readonly path: string;
		readonly signal: AbortSignal;
	}) => Promise<{ readonly kind: 'already-exists' | 'created' }>;
	readonly readFile: (props: {
		readonly maximumBytes: number;
		readonly path: string;
		readonly signal: AbortSignal;
	}) => Promise<Uint8Array>;
	readonly removeFile: (props: {
		readonly path: string;
		readonly signal: AbortSignal;
	}) => Promise<void>;
	readonly renameNoReplace: (props: {
		readonly fromPath: string;
		readonly signal: AbortSignal;
		readonly toPath: string;
	}) => Promise<{ readonly kind: 'destination-exists' | 'renamed' }>;
	readonly stat: (props: {
		readonly path: string;
		readonly signal: AbortSignal;
	}) => Promise<WorkspaceArtifactFileStat>;
	readonly writeFileExclusive: (props: {
		readonly bytes: Uint8Array;
		readonly path: string;
		readonly signal: AbortSignal;
	}) => Promise<
		| {
				readonly kind: 'failed';
				readonly temporaryFileOwnership: 'owned' | 'unconfirmed' | 'unowned';
		  }
		| { readonly kind: 'written' }
	>;
}

export type WorkspaceArtifactPublicationErrorCode =
	| 'artifact-unavailable'
	| 'authority-stale'
	| 'cancelled'
	| 'cleanup-unconfirmed'
	| 'conflict'
	| 'invalid-filename'
	| 'publication-failed'
	| 'unsafe-workspace';

export class WorkspaceArtifactPublicationError extends Error {
	readonly code: WorkspaceArtifactPublicationErrorCode;

	constructor(code: WorkspaceArtifactPublicationErrorCode) {
		super(`Workspace artifact publication failed (${code}).`);
		this.name = 'WorkspaceArtifactPublicationError';
		this.code = code;
	}
}

export interface PublishGatewayArtifactToWorkspaceProps {
	readonly assertCurrentLeaseAndAuthority: (props: {
		readonly signal: AbortSignal;
	}) => Promise<void>;
	readonly caller: GatewayRuntimeArtifactReadCaller;
	/** Bounds the best-effort removal of an owned temporary file after failure. */
	readonly cleanupDeadlineMilliseconds: number;
	readonly createTemporaryName?: () => string;
	readonly fileName: string;
	readonly filesystem: WorkspaceArtifactFilesystemPort;
	readonly maximumBytes: number;
	readonly reader: GatewayRuntimeArtifactReader;
	readonly reference: ArtifactReference;
	readonly signal: AbortSignal;
}

export type WorkspaceArtifactPublicationResult =
	| { readonly kind: 'published'; readonly workspacePath: string }
	| { readonly kind: 'reused'; readonly workspacePath: string };

function publicationError(
	code: WorkspaceArtifactPublicationErrorCode,
): WorkspaceArtifactPublicationError {
	return new WorkspaceArtifactPublicationError(code);
}

function checkCancellation(signal: AbortSignal): void {
	if (signal.aborted) throw publicationError('cancelled');
}

function deepFreeze<TValue>(value: TValue): Readonly<TValue> {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const nestedValue of Object.values(value)) deepFreeze(nestedValue);
	return Object.freeze(value);
}

/** The operation owns interruption; cancellation is reported only after the port settles. */
async function awaitAbortAwareOperation<TValue>(
	operation: () => Promise<TValue>,
	signal: AbortSignal,
): Promise<TValue> {
	checkCancellation(signal);
	const result = await operation();
	checkCancellation(signal);
	return result;
}

function validateFileName(fileName: string): void {
	const encodedLength = Buffer.byteLength(fileName, 'utf8');
	const containsControlCharacter = Array.from(fileName).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});
	if (
		fileName.length === 0 ||
		encodedLength > maximumFileNameBytes ||
		fileName !== fileName.normalize('NFC') ||
		fileName === '.' ||
		fileName === '..' ||
		fileName.includes('/') ||
		fileName.includes('\\') ||
		containsControlCharacter
	) {
		throw publicationError('invalid-filename');
	}
}

function artifactDirectoryPath(reference: ArtifactReference): string {
	return `${publicationRootPath}/${createHash('sha256').update(reference.id).digest('hex')}`;
}

function bytesMatch(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

async function statPath(
	filesystem: WorkspaceArtifactFilesystemPort,
	path: string,
	signal: AbortSignal,
): Promise<WorkspaceArtifactFileStat> {
	try {
		return await awaitAbortAwareOperation(
			async () => await filesystem.stat({ path, signal }),
			signal,
		);
	} catch (error) {
		if (error instanceof WorkspaceArtifactPublicationError) throw error;
		throw publicationError('publication-failed');
	}
}

async function ensureDirectory(
	filesystem: WorkspaceArtifactFilesystemPort,
	path: string,
	signal: AbortSignal,
): Promise<void> {
	let stat = await statPath(filesystem, path, signal);
	if (stat.kind === 'missing') {
		try {
			await awaitAbortAwareOperation(async () => await filesystem.mkdir({ path, signal }), signal);
		} catch (error) {
			if (error instanceof WorkspaceArtifactPublicationError) throw error;
			throw publicationError('publication-failed');
		}
		stat = await statPath(filesystem, path, signal);
	}
	if (stat.kind !== 'directory') throw publicationError('unsafe-workspace');
}

async function assertCurrentLeaseAndAuthority(
	props: PublishGatewayArtifactToWorkspaceProps,
): Promise<void> {
	try {
		await awaitAbortAwareOperation(
			async () => await props.assertCurrentLeaseAndAuthority({ signal: props.signal }),
			props.signal,
		);
	} catch (error) {
		if (error instanceof WorkspaceArtifactPublicationError && error.code === 'cancelled') {
			throw error;
		}
		throw publicationError('authority-stale');
	}
}

async function readMatchingFinalFile(props: {
	readonly bytes: Uint8Array;
	readonly filesystem: WorkspaceArtifactFilesystemPort;
	readonly path: string;
	readonly signal: AbortSignal;
}): Promise<boolean> {
	const stat = await statPath(props.filesystem, props.path, props.signal);
	if (stat.kind === 'missing') return false;
	if (stat.kind !== 'file') throw publicationError('unsafe-workspace');
	if (stat.byteLength !== props.bytes.byteLength) throw publicationError('conflict');
	try {
		const existingBytes = await awaitAbortAwareOperation(
			async () =>
				await props.filesystem.readFile({
					maximumBytes: props.bytes.byteLength,
					path: props.path,
					signal: props.signal,
				}),
			props.signal,
		);
		if (!bytesMatch(existingBytes, props.bytes)) throw publicationError('conflict');
		return true;
	} catch (error) {
		if (error instanceof WorkspaceArtifactPublicationError) throw error;
		throw publicationError('publication-failed');
	}
}

async function verifyOwnedTemporaryFile(props: {
	readonly bytes: Uint8Array;
	readonly filesystem: WorkspaceArtifactFilesystemPort;
	readonly path: string;
	readonly signal: AbortSignal;
}): Promise<void> {
	const stat = await statPath(props.filesystem, props.path, props.signal);
	if (stat.kind !== 'file' || stat.byteLength !== props.bytes.byteLength) {
		throw publicationError('publication-failed');
	}
	try {
		const writtenBytes = await awaitAbortAwareOperation(
			async () =>
				await props.filesystem.readFile({
					maximumBytes: props.bytes.byteLength,
					path: props.path,
					signal: props.signal,
				}),
			props.signal,
		);
		if (!bytesMatch(writtenBytes, props.bytes)) throw publicationError('publication-failed');
	} catch (error) {
		if (error instanceof WorkspaceArtifactPublicationError) throw error;
		throw publicationError('publication-failed');
	}
}

async function cleanupOwnedTemporaryFile(
	filesystem: WorkspaceArtifactFilesystemPort,
	temporaryPath: string,
	deadlineMilliseconds: number,
): Promise<void> {
	const controller = new AbortController();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			filesystem.removeFile({ path: temporaryPath, signal: controller.signal }),
			new Promise<never>((_resolve, reject) => {
				deadline = setTimeout((): void => {
					controller.abort();
					reject(publicationError('cleanup-unconfirmed'));
				}, deadlineMilliseconds);
			}),
		]);
	} catch {
		throw publicationError('cleanup-unconfirmed');
	} finally {
		if (deadline !== undefined) clearTimeout(deadline);
	}
}

/** Publish verified artifact bytes into the current lease without accepting a caller path. */
export async function publishGatewayArtifactToWorkspace(
	props: PublishGatewayArtifactToWorkspaceProps,
): Promise<WorkspaceArtifactPublicationResult> {
	const fileName = props.fileName;
	validateFileName(fileName);
	if (
		!Number.isSafeInteger(props.cleanupDeadlineMilliseconds) ||
		props.cleanupDeadlineMilliseconds <= 0 ||
		props.cleanupDeadlineMilliseconds > maximumCleanupDeadlineMilliseconds
	) {
		throw publicationError('publication-failed');
	}
	let caller: GatewayRuntimeArtifactReadCaller;
	let reference: ArtifactReference;
	try {
		caller = deepFreeze(GatewayRuntimeArtifactReadCallerSchema.parse(props.caller));
		reference = deepFreeze(ArtifactReferenceSchema.parse(props.reference));
	} catch {
		throw publicationError('artifact-unavailable');
	}
	checkCancellation(props.signal);

	let bytes: Uint8Array;
	try {
		bytes = await readVerifiedGatewayArtifact({
			caller,
			maximumBytes: props.maximumBytes,
			reader: props.reader,
			reference,
			signal: props.signal,
		});
	} catch (error) {
		if (error instanceof GatewayRuntimeArtifactDeliveryError && error.code === 'cancelled') {
			throw publicationError('cancelled');
		}
		throw publicationError('artifact-unavailable');
	}

	await assertCurrentLeaseAndAuthority(props);
	await ensureDirectory(props.filesystem, workspaceRootPath, props.signal);
	await ensureDirectory(props.filesystem, publicationRootPath, props.signal);
	const directoryPath = artifactDirectoryPath(reference);
	await ensureDirectory(props.filesystem, directoryPath, props.signal);
	const finalPath = `${directoryPath}/${fileName}`;
	if (
		await readMatchingFinalFile({
			bytes,
			filesystem: props.filesystem,
			path: finalPath,
			signal: props.signal,
		})
	) {
		await assertCurrentLeaseAndAuthority(props);
		return { kind: 'reused', workspacePath: finalPath };
	}

	const temporaryName = (props.createTemporaryName ?? randomUUID)();
	if (!/^[A-Za-z0-9-]{1,64}$/u.test(temporaryName)) {
		throw publicationError('publication-failed');
	}
	const temporaryPath = `${directoryPath}/.${fileName}.tmp-${temporaryName}`;
	let temporaryFileOwned = false;
	try {
		let writeResult: Awaited<ReturnType<WorkspaceArtifactFilesystemPort['writeFileExclusive']>>;
		try {
			checkCancellation(props.signal);
			writeResult = await props.filesystem.writeFileExclusive({
				bytes,
				path: temporaryPath,
				signal: props.signal,
			});
		} catch (error) {
			if (error instanceof WorkspaceArtifactPublicationError) throw error;
			throw publicationError('cleanup-unconfirmed');
		}
		if (writeResult.kind === 'failed') {
			if (writeResult.temporaryFileOwnership === 'unconfirmed') {
				throw publicationError('cleanup-unconfirmed');
			}
			temporaryFileOwned = writeResult.temporaryFileOwnership === 'owned';
			throw publicationError('publication-failed');
		}
		temporaryFileOwned = true;
		checkCancellation(props.signal);
		await verifyOwnedTemporaryFile({
			bytes,
			filesystem: props.filesystem,
			path: temporaryPath,
			signal: props.signal,
		});

		await assertCurrentLeaseAndAuthority(props);
		let renameResult: Awaited<ReturnType<WorkspaceArtifactFilesystemPort['renameNoReplace']>>;
		try {
			checkCancellation(props.signal);
			renameResult = await props.filesystem.renameNoReplace({
				fromPath: temporaryPath,
				signal: props.signal,
				toPath: finalPath,
			});
		} catch (error) {
			if (error instanceof WorkspaceArtifactPublicationError) throw error;
			throw publicationError('publication-failed');
		}
		if (renameResult.kind === 'renamed') {
			temporaryFileOwned = false;
			return { kind: 'published', workspacePath: finalPath };
		}

		temporaryFileOwned = false;
		await cleanupOwnedTemporaryFile(
			props.filesystem,
			temporaryPath,
			props.cleanupDeadlineMilliseconds,
		);
		if (
			await readMatchingFinalFile({
				bytes,
				filesystem: props.filesystem,
				path: finalPath,
				signal: props.signal,
			})
		) {
			await assertCurrentLeaseAndAuthority(props);
			return { kind: 'reused', workspacePath: finalPath };
		}
		throw publicationError('conflict');
	} catch (error) {
		if (temporaryFileOwned) {
			temporaryFileOwned = false;
			await cleanupOwnedTemporaryFile(
				props.filesystem,
				temporaryPath,
				props.cleanupDeadlineMilliseconds,
			);
		}
		if (error instanceof WorkspaceArtifactPublicationError) throw error;
		throw publicationError('publication-failed');
	}
}
