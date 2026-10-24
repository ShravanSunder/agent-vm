import { mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { jsonValueSchema } from '@agent-collaboration/tool-access/contracts';
import type {
	WorkspaceAuthorityStore,
	WorkspaceAuthorityTransaction,
} from '@agent-collaboration/tool-host-core';

export interface NodeWorkspaceAuthorityStore extends WorkspaceAuthorityStore {
	readonly close: () => Promise<void>;
}

// Async authority callbacks must not let a second synchronous SQLite connection
// block this process's event loop while its first transaction is suspended.
const pendingByDatabase = new Map<string, Promise<unknown>>();

/** One file is one workspace's durable authority; SQLite arbitrates other processes. */
export async function openNodeWorkspaceAuthorityStore(props: {
	readonly databasePath: string;
}): Promise<NodeWorkspaceAuthorityStore> {
	if (props.databasePath.length === 0 || props.databasePath === ':memory:')
		throw new Error('Workspace authority requires a persistent database file.');
	const databasePath = resolve(props.databasePath);
	await mkdir(dirname(databasePath), { recursive: true });
	const database = new DatabaseSync(databasePath, { timeout: 5_000 });
	let canonicalPath: string;
	try {
		canonicalPath = await realpath(databasePath);
		database.exec(`
			PRAGMA synchronous = FULL;
			CREATE TABLE IF NOT EXISTS workspace_authority_v1 (
				key TEXT PRIMARY KEY NOT NULL,
				value TEXT NOT NULL
			) STRICT;
		`);
	} catch (error) {
		database.close();
		throw error;
	}
	const readStatement = database.prepare('SELECT value FROM workspace_authority_v1 WHERE key = ?');
	const writeStatement = database.prepare(
		'INSERT INTO workspace_authority_v1 (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
	);
	let closing = false;
	let closeResult: Promise<void> | undefined;
	function enqueue<TResult>(run: () => Promise<TResult>): Promise<TResult> {
		const result = (pendingByDatabase.get(canonicalPath) ?? Promise.resolve()).then(run);
		const settled = result.catch(() => undefined);
		pendingByDatabase.set(canonicalPath, settled);
		void settled.then(() => {
			if (pendingByDatabase.get(canonicalPath) === settled) pendingByDatabase.delete(canonicalPath);
		});
		return result;
	}
	function transaction<TResult>(
		decide: (storage: WorkspaceAuthorityTransaction) => Promise<TResult>,
	): Promise<TResult> {
		if (closing) return Promise.reject(new Error('Workspace authority store is closed.'));
		return enqueue(async () => {
			database.exec('BEGIN IMMEDIATE');
			let active = true;
			function assertActive(): void {
				if (!active) throw new Error('Workspace authority transaction has ended.');
			}
			const storage: WorkspaceAuthorityTransaction = {
				read: async (key) => {
					assertActive();
					const row = readStatement.get(key);
					if (row === undefined) return undefined;
					if (typeof row.value !== 'string') throw new Error('Invalid workspace authority row.');
					const value: unknown = JSON.parse(row.value);
					return value;
				},
				write: async (key, value) => {
					assertActive();
					writeStatement.run(key, JSON.stringify(jsonValueSchema.parse(value)));
				},
			};
			try {
				const result = await decide(storage);
				active = false;
				database.exec('COMMIT');
				return result;
			} catch (error) {
				active = false;
				database.exec('ROLLBACK');
				throw error;
			}
		});
	}
	return {
		transaction,
		read: (key) => transaction(async (storage) => storage.read(key)),
		write: (key, value) => transaction(async (storage) => storage.write(key, value)),
		close: () => {
			closing = true;
			closeResult ??= enqueue(async () => database.close());
			return closeResult;
		},
	};
}
