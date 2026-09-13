import { createHash } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { OperationFileRetentionBudget } from './operation-file-retention-budget.js';
import {
	createSharedStagingDirectoryStore,
	type SharedStagingDirectoryStore,
} from './shared-staging-directory-store.js';

function directoryKey(identity: string): string {
	return createHash('sha256').update(identity).digest('hex');
}

function stagingZoneRoot(controllerRuntimeDir: string, zoneId: string): string {
	if (
		!path.isAbsolute(controllerRuntimeDir) ||
		path.parse(controllerRuntimeDir).root === controllerRuntimeDir
	)
		throw new Error('Controller staging requires an absolute scoped runtime directory.');
	return path.join(controllerRuntimeDir, 'shared-staging', directoryKey(zoneId));
}

/** Call only after existing exact VM-tree recovery succeeds while holding controller ownership. */
export async function cleanupSharedStagingZoneAfterContainment(props: {
	readonly controllerRuntimeDir: string;
	readonly zoneId: string;
}): Promise<void> {
	const root = stagingZoneRoot(props.controllerRuntimeDir, props.zoneId);
	for (const directory of [path.dirname(root), root]) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- validate parent before its scoped child.
			const status = await lstat(directory);
			if (!status.isDirectory() || status.isSymbolicLink())
				throw new Error('Unsafe shared staging cleanup root.');
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
			throw error;
		}
	}
	await rm(root, { recursive: true, force: true });
}

/** Composition-owned directory registry; no file contents, SQLite rows or new VM authority. */
export function createControllerSharedStaging(props: {
	readonly controllerRuntimeDir: string;
	readonly controllerEpoch: string;
	readonly retentionBudget: OperationFileRetentionBudget;
	readonly now: () => number;
}): {
	getStore(zoneId: string, agentId: string): Promise<SharedStagingDirectoryStore>;
	reapExpired(): Promise<void>;
} {
	const stores = new Map<string, Promise<SharedStagingDirectoryStore>>();
	return {
		getStore: async (zoneId, agentId) => {
			const key = JSON.stringify([zoneId, agentId]);
			let store = stores.get(key);
			if (store === undefined) {
				store = (async () => {
					const runRoot = path.join(
						stagingZoneRoot(props.controllerRuntimeDir, zoneId),
						directoryKey(props.controllerEpoch),
					);
					await mkdir(runRoot, { recursive: true, mode: 0o700 });
					return await createSharedStagingDirectoryStore({
						root: path.join(runRoot, directoryKey(agentId)),
						now: props.now,
						retention: props.retentionBudget.forOwner({
							zoneId,
							agentId,
							ownerId: `shared-staging-${props.controllerEpoch}`,
						}),
					});
				})();
				stores.set(key, store);
			}
			try {
				return await store;
			} catch (error) {
				// A transient disk failure must not become this agent's permanent runtime state.
				if (stores.get(key) === store) stores.delete(key);
				throw error;
			}
		},
		reapExpired: async () => {
			const results = await Promise.allSettled(
				[...stores.values()].map(async (store) => await (await store).reapExpired()),
			);
			if (results.some((result) => result.status === 'rejected' || result.value.pending > 0))
				throw new Error('Shared staging cleanup remains pending.');
		},
	};
}
