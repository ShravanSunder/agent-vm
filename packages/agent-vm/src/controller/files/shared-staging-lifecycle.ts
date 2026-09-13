import type { ToolVmWorkFileBinding } from './current-tool-vm-work-files.js';

export const sharedStagingLifetimeMs = 60 * 60_000;

export interface SharedStagingPublication {
	readonly publicationId: string;
	readonly expiresAtMs: number;
}

interface RetainedStagingDirectory {
	readonly publication: SharedStagingPublication;
	readonly receiver: ToolVmWorkFileBinding;
	readonly remove: () => Promise<void>;
	retiring: boolean;
	cleanupPromise: Promise<boolean> | undefined;
}

export interface SharedStagingCleanupResult {
	readonly removed: number;
	readonly pending: number;
}

export interface SharedStagingLifecycle {
	track(props: {
		readonly publicationId: string;
		readonly receiver: ToolVmWorkFileBinding;
		/** Deletes only the owned directory and releases accounting after success. */
		readonly remove: () => Promise<void>;
	}): SharedStagingPublication;
	lookup(
		publicationId: string,
		receiver: ToolVmWorkFileBinding,
	): SharedStagingPublication | undefined;
	reapExpired(): Promise<SharedStagingCleanupResult>;
	retireReceiver(receiver: ToolVmWorkFileBinding): Promise<SharedStagingCleanupResult>;
}

function sameReceiver(left: ToolVmWorkFileBinding, right: ToolVmWorkFileBinding): boolean {
	return (
		left.leaseId === right.leaseId &&
		left.leafGeneration === right.leafGeneration &&
		left.vmId === right.vmId
	);
}

/** Metadata only; VM authority and filesystem path validation stay with callers. */
export function createSharedStagingLifecycle(props: {
	readonly now: () => number;
}): SharedStagingLifecycle {
	const directories = new Map<string, RetainedStagingDirectory>();
	const cleanup = (entry: RetainedStagingDirectory): Promise<boolean> => {
		entry.retiring = true;
		entry.cleanupPromise ??= Promise.resolve()
			.then(entry.remove)
			.then(
				() => {
					directories.delete(entry.publication.publicationId);
					return true;
				},
				() => false,
			)
			.finally(() => {
				entry.cleanupPromise = undefined;
			});
		return entry.cleanupPromise;
	};
	const removeSelected = async (
		select: (entry: RetainedStagingDirectory) => boolean,
	): Promise<SharedStagingCleanupResult> => {
		const selected = [...directories.values()].filter(select);
		const results = await Promise.all(selected.map(cleanup));
		const removed = results.filter(Boolean).length;
		return { removed, pending: results.length - removed };
	};
	return {
		track: ({ publicationId, receiver, remove }) => {
			if (directories.has(publicationId)) throw new Error('Publication is already tracked.');
			const publishedAtMs = props.now();
			if (
				!Number.isSafeInteger(publishedAtMs) ||
				publishedAtMs < 0 ||
				!Number.isSafeInteger(publishedAtMs + sharedStagingLifetimeMs)
			)
				throw new Error('Invalid staging publication time.');
			const publication = { publicationId, expiresAtMs: publishedAtMs + sharedStagingLifetimeMs };
			directories.set(publicationId, {
				publication,
				receiver: { ...receiver },
				remove,
				retiring: false,
				cleanupPromise: undefined,
			});
			return { ...publication };
		},
		lookup: (publicationId, receiver) => {
			const entry = directories.get(publicationId);
			return entry === undefined ||
				entry.retiring ||
				props.now() >= entry.publication.expiresAtMs ||
				!sameReceiver(entry.receiver, receiver)
				? undefined
				: { ...entry.publication };
		},
		reapExpired: async () =>
			await removeSelected(
				(entry) => entry.retiring || props.now() >= entry.publication.expiresAtMs,
			),
		retireReceiver: async (receiver) =>
			await removeSelected((entry) => sameReceiver(entry.receiver, receiver)),
	};
}
