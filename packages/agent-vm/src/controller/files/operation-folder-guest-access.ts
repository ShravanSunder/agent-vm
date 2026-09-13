import { readFile } from 'node:fs/promises';

import type { ManagedVmExecProcess, ManagedVm } from '@agent-vm/managed-vm';
import { z } from 'zod';

export const operationFolderFileLimit = 16 * 1024 * 1024;
// Stock managed Linux images provide this interpreter; qualify it with the real
// file-request VM proof. Do not assume a host/Homebrew-style /usr/local path.
export const operationFolderPythonExecutable = '/usr/bin/python3';
export const operationFolderMetadataLimit = 32 * 1024;
const operationFolderListingSchema = z
	.object({
		entries: z
			.array(
				z.discriminatedUnion('kind', [
					z
						.object({
							name: z.string().min(1).max(255),
							kind: z.literal('file'),
							byteLength: z.number().int().nonnegative(),
						})
						.strict(),
					z
						.object({
							name: z.string().min(1).max(255),
							kind: z.enum(['directory', 'unsupported']),
						})
						.strict(),
				]),
			)
			.max(256)
			.readonly(),
		limitReached: z.boolean(),
	})
	.strict();
export type OperationFolderListing = z.infer<typeof operationFolderListingSchema>;
const inventorySchema = z
	.object({
		byteLength: z
			.number()
			.int()
			.nonnegative()
			.max(64 * 1024 * 1024),
		entryCount: z.number().int().nonnegative().max(4096),
	})
	.strict();
const publicationSchema = z
	.object({ kind: z.literal('published'), cleanup: z.enum(['complete', 'pending']) })
	.strict();

export class OperationFolderAccessError extends Error {
	constructor(
		readonly reason:
			| 'invalid-path'
			| 'unavailable'
			| 'destination-conflict'
			| 'integrity-mismatch'
			| 'size-limit'
			| 'transfer-failed',
	) {
		super(`Operation folder access failed: ${reason}.`);
	}
}

export interface OperationFolderGuestAccess {
	list(relativeDirectory: string): Promise<OperationFolderListing>;
	inventory(): Promise<z.infer<typeof inventorySchema>>;
	read(relativePath: string): AsyncIterable<Uint8Array>;
	createDirectory(relativePath: string): Promise<void>;
	removeOwned(relativePath: string): Promise<void>;
	publish(props: {
		readonly temporaryRelativePath: string;
		readonly finalName: string;
		readonly byteLength: number;
		readonly sha256: string;
	}): Promise<z.infer<typeof publicationSchema>>;
}

/** App-owned source, packaged alongside dist; never fetched or composed from agent input. */
export async function loadOperationFolderGuestProgram(): Promise<string> {
	return await readFile(
		new URL('../../../guest-programs/operation-folder.py', import.meta.url),
		'utf8',
	);
}

export function assertOperationRelativePath(relativePath: string, allowEmpty = false): void {
	if (allowEmpty && relativePath === '') return;
	const parts = relativePath.split('/');
	if (
		parts.length > 32 ||
		parts.some(
			(part) => part === '' || part === '.' || part === '..' || Buffer.byteLength(part) > 255,
		) ||
		Array.from(relativePath).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\',
		)
	)
		throw new OperationFolderAccessError('invalid-path');
}

function requireSuccessfulExit(exitCode: number): void {
	if (exitCode === 0) return;
	const reason =
		exitCode === 64
			? 'invalid-path'
			: exitCode === 66
				? 'unavailable'
				: exitCode === 73
					? 'destination-conflict'
					: exitCode === 74
						? 'integrity-mismatch'
						: exitCode === 75
							? 'size-limit'
							: 'transfer-failed';
	throw new OperationFolderAccessError(reason);
}

/** Caller owns the runtime reservation and containment on cancellation/error. */
export function createOperationFolderGuestAccess(props: {
	readonly vm: Pick<ManagedVm, 'exec'>;
	readonly root: string;
	readonly program: string;
	readonly pythonExecutable: string;
	readonly signal: AbortSignal;
}): OperationFolderGuestAccess {
	if (!props.root.startsWith('/') || props.root === '/' || !props.pythonExecutable.startsWith('/'))
		throw new OperationFolderAccessError('invalid-path');
	assertOperationRelativePath(props.root.slice(1));
	const root = props.root;
	function execute(
		action: string,
		relativePath: string,
		extra: readonly string[] = [],
	): ManagedVmExecProcess {
		assertOperationRelativePath(relativePath, action === 'list' || action === 'inventory');
		props.signal.throwIfAborted();
		return props.vm.exec(
			[props.pythonExecutable, '-I', '-c', props.program, action, root, relativePath, ...extra],
			{
				output: { stdout: { kind: 'pipe' }, stderr: { kind: 'pipe' } },
				pty: false,
				signal: props.signal,
			},
		);
	}
	async function* consume(
		process: ManagedVmExecProcess,
		maximumBytes: number,
	): AsyncIterable<Uint8Array> {
		// Observe completion immediately even while the consumer is backpressured.
		const completion = process.result;
		void completion.catch(() => {});
		let byteLength = 0;
		for await (const chunk of process.output()) {
			props.signal.throwIfAborted();
			if (chunk.stream === 'stderr') continue; // Never expose guest diagnostics as file bytes.
			byteLength += chunk.data.byteLength;
			if (byteLength > maximumBytes) throw new OperationFolderAccessError('size-limit');
			yield chunk.data;
		}
		requireSuccessfulExit((await completion).exitCode);
		props.signal.throwIfAborted();
	}
	async function metadata(
		action: string,
		relativePath: string,
		extra: readonly string[] = [],
	): Promise<unknown> {
		// Only fixed-size metadata is collected; file reads remain lazy byte streams.
		const storage = Buffer.alloc(operationFolderMetadataLimit);
		let offset = 0;
		for await (const chunk of consume(execute(action, relativePath, extra), storage.byteLength)) {
			storage.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return offset === 0
			? undefined
			: (JSON.parse(
					new TextDecoder('utf-8', { fatal: true }).decode(storage.subarray(0, offset)),
				) as unknown);
	}
	return {
		list: async (relativeDirectory) =>
			operationFolderListingSchema.parse(await metadata('list', relativeDirectory)),
		inventory: async () => inventorySchema.parse(await metadata('inventory', '')),
		read: async function* (relativePath) {
			yield* consume(execute('read', relativePath), operationFolderFileLimit);
		},
		createDirectory: async (relativePath) => {
			await metadata('mkdir', relativePath);
		},
		removeOwned: async (relativePath) => {
			await metadata('remove', relativePath);
		},
		publish: async ({ temporaryRelativePath, finalName, byteLength, sha256 }) => {
			assertOperationRelativePath(finalName);
			if (
				finalName.includes('/') ||
				!Number.isSafeInteger(byteLength) ||
				byteLength < 0 ||
				byteLength > operationFolderFileLimit ||
				!/^[a-f0-9]{64}$/u.test(sha256)
			)
				throw new OperationFolderAccessError('invalid-path');
			return publicationSchema.parse(
				await metadata('publish', temporaryRelativePath, [finalName, String(byteLength), sha256]),
			);
		},
	};
}
