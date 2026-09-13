import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import BetterSqlite3 from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';

import { oauthCatalogSchema, oauthSchemaMetadataTable } from './catalog-schema.js';
import { assertOAuthCatalogCanOpen } from './oauth-catalog-preflight.js';
import { createOAuthCatalogRepositories } from './oauth-catalog-repositories.js';
import type { OAuthCredentialCatalog } from './oauth-credential-catalog-contracts.js';

async function hardenCatalogPaths(databasePath: string): Promise<void> {
	await chmod(path.dirname(databasePath), 0o700);
	await Promise.all(
		[databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async (filePath) => {
			try {
				await chmod(filePath, 0o600);
			} catch (error) {
				if (
					!(
						typeof error === 'object' &&
						error !== null &&
						'code' in error &&
						error.code === 'ENOENT'
					)
				)
					throw error;
			}
		}),
	);
}

export async function openOAuthCredentialCatalog(props: {
	readonly busyTimeoutMs?: number;
	readonly databasePath: string;
	readonly migrationsFolder?: string;
	readonly now?: () => number;
}): Promise<OAuthCredentialCatalog> {
	const now = props.now ?? Date.now;
	const busyTimeoutMs = props.busyTimeoutMs ?? 5_000;
	if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > 60_000) {
		throw new Error('OAuth SQLite busy timeout must be between 1 and 60000 milliseconds.');
	}
	await assertOAuthCatalogCanOpen(props.databasePath);
	await mkdir(path.dirname(props.databasePath), { mode: 0o700, recursive: true });
	const sqlite = new BetterSqlite3(props.databasePath, { timeout: busyTimeoutMs });
	try {
		sqlite.pragma('journal_mode = WAL');
		sqlite.pragma('foreign_keys = ON');
		sqlite.pragma('synchronous = FULL');
		sqlite.pragma('busy_timeout = ' + String(busyTimeoutMs));
		const database = drizzle(sqlite, { schema: oauthCatalogSchema });
		migrate(database, {
			migrationsFolder:
				props.migrationsFolder ?? fileURLToPath(new URL('../drizzle', import.meta.url)),
		});
		await hardenCatalogPaths(props.databasePath);
		return {
			...createOAuthCatalogRepositories({ database, now }),
			close(): void {
				sqlite.pragma('wal_checkpoint(TRUNCATE)');
				sqlite.close();
			},
			getStorageDiagnostics: () => ({
				busyTimeoutMs: z
					.number()
					.int()
					.positive()
					.parse(sqlite.pragma('busy_timeout', { simple: true })),
				foreignKeysEnabled: sqlite.pragma('foreign_keys', { simple: true }) === 1,
				journalMode: z.string().parse(sqlite.pragma('journal_mode', { simple: true })),
				synchronousMode: z
					.number()
					.int()
					.parse(sqlite.pragma('synchronous', { simple: true })),
			}),
			verifyOrInitializeKeyEncryptionKey(keyEncryptionKey): void {
				if (keyEncryptionKey.byteLength !== 32)
					throw new Error('OAuth key-encryption key must contain exactly 32 bytes.');
				const fingerprint = createHash('sha256')
					.update('agent-vm/oauth/kek-verifier/v1\0')
					.update(keyEncryptionKey)
					.digest('base64url');
				database.transaction((transaction) => {
					const existing = transaction
						.select()
						.from(oauthSchemaMetadataTable)
						.where(eq(oauthSchemaMetadataTable.key, 'kek-verifier-v1'))
						.get();
					if (existing === undefined) {
						transaction
							.insert(oauthSchemaMetadataTable)
							.values({ key: 'kek-verifier-v1', value: fingerprint })
							.run();
						return;
					}
					const existingBytes = Buffer.from(existing.value);
					const fingerprintBytes = Buffer.from(fingerprint);
					if (
						existingBytes.length !== fingerprintBytes.length ||
						!timingSafeEqual(existingBytes, fingerprintBytes)
					) {
						throw new Error('OAuth key-encryption key does not match the catalog verifier.');
					}
				});
			},
		};
	} catch (error) {
		sqlite.close();
		throw error;
	}
}
