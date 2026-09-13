import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { openOAuthCredentialCatalog } from './oauth-credential-catalog.js';

async function expectCutoverRequired(databasePath: string): Promise<void> {
	await expect(
		openOAuthCredentialCatalog({ databasePath }).then((catalog) => {
			// If the guard regresses, close the unexpected handle before failing.
			catalog.close();
			return catalog;
		}),
	).rejects.toThrow('cutover-required');
}

describe('OAuth catalog preflight preservation', () => {
	it('rejects a legacy catalog before migrations without changing database or WAL bytes', async () => {
		// Arrange: retain uncheckpointed schema/data and original file modes.
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-legacy-preflight-'));
		const databasePath = path.join(directory, 'credentials.sqlite');
		const legacyDatabase = new BetterSqlite3(databasePath);
		try {
			legacyDatabase.pragma('journal_mode = WAL');
			legacyDatabase.pragma('wal_autocheckpoint = 0');
			legacyDatabase.exec(`
				CREATE TABLE oauth_schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
				INSERT INTO oauth_schema_metadata VALUES ('envelope_format_version', '1');
				CREATE TABLE oauth_account_profiles (profile_record_id TEXT PRIMARY KEY);
				INSERT INTO oauth_account_profiles VALUES ('synthetic-legacy-profile');
			`);
			const beforeDatabase = await readFile(databasePath);
			const beforeWal = await readFile(`${databasePath}-wal`);
			const beforeMode = (await stat(databasePath)).mode;

			// Act: invoke the real production opener, not only a helper validator.
			await expectCutoverRequired(databasePath);

			// Assert: normal SHM reader bookkeeping is allowed; persisted data is not.
			expect(await readFile(databasePath)).toEqual(beforeDatabase);
			expect(await readFile(`${databasePath}-wal`)).toEqual(beforeWal);
			expect((await stat(databasePath)).mode).toBe(beforeMode);
			expect(
				legacyDatabase
					.prepare("SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'")
					.get(),
			).toBeUndefined();
		} finally {
			legacyDatabase.close();
		}
	});

	it.each(['unknown-version', 'inconsistent-current-layout'] as const)(
		'preserves a catalog with %s',
		async (scenario) => {
			// Arrange
			const directory = await mkdtemp(path.join(tmpdir(), 'oauth-unknown-preflight-'));
			const databasePath = path.join(directory, 'credentials.sqlite');
			const database = new BetterSqlite3(databasePath);
			database.exec(
				'CREATE TABLE oauth_schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
			);
			database
				.prepare('INSERT INTO oauth_schema_metadata VALUES (?, ?)')
				.run('schema_version', scenario === 'unknown-version' ? '99' : '2');
			database
				.prepare('INSERT INTO oauth_schema_metadata VALUES (?, ?)')
				.run('envelope_format_version', '2');
			database.close();
			const before = await readFile(databasePath);

			// Act / Assert
			await expectCutoverRequired(databasePath);
			expect(await readFile(databasePath)).toEqual(before);
		},
	);

	it('does not initialize over an orphaned WAL when the database is missing', async () => {
		// Arrange
		const directory = await mkdtemp(path.join(tmpdir(), 'oauth-orphan-preflight-'));
		const databasePath = path.join(directory, 'credentials.sqlite');
		const wal = Buffer.from('synthetic orphaned recovery material');
		await writeFile(`${databasePath}-wal`, wal);

		// Act / Assert
		await expectCutoverRequired(databasePath);
		expect(await readFile(`${databasePath}-wal`)).toEqual(wal);
		await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
