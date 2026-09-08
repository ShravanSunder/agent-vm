import type { OperationFileRetentionOwner } from '../files/operation-file-retention-budget.js';

export interface CredentialedOperationFolderReference {
	readonly referenceId: string;
	readonly expiresAtMs: number;
}
interface FolderLocation {
	readonly operationId: string;
	readonly directory: string;
}
type RetainedFolder = FolderLocation &
	(
		| { readonly kind: 'staging'; readonly maximumBytes: number }
		| {
				readonly kind: 'available';
				readonly byteLength: number;
				readonly reference: CredentialedOperationFolderReference;
				readonly authorityIsCurrent: () => boolean;
		  }
	);
export interface CredentialedOperationFolders {
	reserve(request: FolderLocation & { readonly maximumBytes: number }): boolean;
	complete(request: {
		readonly operationId: string;
		readonly referenceId: string;
		readonly byteLength: number;
		readonly completedAtMs: number;
		readonly authorityIsCurrent: () => boolean;
	}): CredentialedOperationFolderReference | undefined;
	lookup(referenceId: string, nowMs: number): FolderLocation | undefined;
	expired(nowMs: number): readonly FolderLocation[];
	removeAfterCleanup(operationId: string): void;
	retainedBytes(): number;
	releaseAllAfterCleanup(): void;
}

/** One bounded inventory on a live runtime. All mutation is under its owner's existing lock. */
export function createCredentialedOperationFolders(
	retention: OperationFileRetentionOwner,
): CredentialedOperationFolders {
	const folders = new Map<string, RetainedFolder>();
	const retainedBytes = (): number =>
		[...folders.values()].reduce(
			(sum, folder) => sum + (folder.kind === 'staging' ? folder.maximumBytes : folder.byteLength),
			0,
		);
	return {
		retainedBytes,
		releaseAllAfterCleanup: () => {
			retention.releaseAllAfterCleanup();
			folders.clear();
		},
		reserve: (request) => {
			if (
				!Number.isSafeInteger(request.maximumBytes) ||
				request.maximumBytes < 0 ||
				folders.size >= 32 ||
				folders.has(request.operationId) ||
				!retention.reserve(request.operationId, request.maximumBytes)
			)
				return false;
			folders.set(request.operationId, { ...request, kind: 'staging' });
			return true;
		},
		complete: (request) => {
			const folder = folders.get(request.operationId);
			if (
				folder?.kind !== 'staging' ||
				!Number.isSafeInteger(request.byteLength) ||
				request.byteLength < 0 ||
				request.byteLength > folder.maximumBytes ||
				!Number.isSafeInteger(request.completedAtMs) ||
				request.completedAtMs < 0 ||
				[...folders.values()].some(
					(entry) =>
						entry.kind === 'available' && entry.reference.referenceId === request.referenceId,
				)
			)
				return undefined;
			if (!retention.resize(request.operationId, request.byteLength)) return undefined;
			const reference = {
				referenceId: request.referenceId,
				expiresAtMs: request.completedAtMs + 5 * 60_000,
			};
			folders.set(request.operationId, {
				operationId: folder.operationId,
				directory: folder.directory,
				kind: 'available',
				byteLength: request.byteLength,
				reference,
				authorityIsCurrent: request.authorityIsCurrent,
			});
			return { ...reference };
		},
		lookup: (referenceId, nowMs) => {
			const folder = [...folders.values()].find(
				(entry) =>
					entry.kind === 'available' &&
					entry.reference.referenceId === referenceId &&
					nowMs < entry.reference.expiresAtMs,
			);
			return folder === undefined || folder.kind !== 'available' || !folder.authorityIsCurrent()
				? undefined
				: { operationId: folder.operationId, directory: folder.directory };
		},
		expired: (nowMs) =>
			[...folders.values()]
				.filter((entry) => entry.kind === 'available' && entry.reference.expiresAtMs <= nowMs)
				.map(({ operationId, directory }) => ({ operationId, directory })),
		removeAfterCleanup: (operationId) => {
			retention.releaseAfterCleanup(operationId);
			folders.delete(operationId);
		},
	};
}
