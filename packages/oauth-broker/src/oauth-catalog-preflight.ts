import { stat } from 'node:fs/promises';

import BetterSqlite3 from 'better-sqlite3';
import { getTableColumns, getTableName, type Column } from 'drizzle-orm';
import { z } from 'zod';

import { oauthCatalogSchema } from './catalog-schema.js';

const tableNameRowsSchema = z.array(z.object({ name: z.string() }).strict());
const columnRowsSchema = z.array(
	z
		.object({
			name: z.string(),
			notnull: z.number().int().min(0).max(1),
			pk: z.number().int().nonnegative(),
			type: z.string(),
		})
		.strict(),
);

export class OAuthCatalogCutoverRequiredError extends Error {
	constructor(options?: ErrorOptions) {
		super(
			'OAuth catalog cutover-required: preserve this catalog and perform an explicit offline cutover.',
			options,
		);
		this.name = 'OAuthCatalogCutoverRequiredError';
	}
}

async function existingFileSize(filePath: string): Promise<number | undefined> {
	try {
		const metadata = await stat(filePath);
		if (!metadata.isFile()) throw new OAuthCatalogCutoverRequiredError();
		return metadata.size;
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

function assertCurrentSchema(database: BetterSqlite3.Database): void {
	const names = tableNameRowsSchema
		.parse(
			database
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
				.all(),
		)
		.map((row) => row.name);
	if (names.includes('oauth_account_profiles') || names.includes('oauth_grants')) {
		throw new OAuthCatalogCutoverRequiredError();
	}
	const expectedNames = [
		...Object.values(oauthCatalogSchema).map(getTableName),
		'__drizzle_migrations',
	];
	if (
		names.length !== expectedNames.length ||
		expectedNames.some((name) => !names.includes(name))
	) {
		throw new OAuthCatalogCutoverRequiredError();
	}
	const versions = z
		.array(z.object({ key: z.string(), value: z.string() }).strict())
		.parse(
			database
				.prepare('SELECT key, value FROM oauth_schema_metadata WHERE key IN (?, ?)')
				.all('schema_version', 'envelope_format_version'),
		);
	if (versions.length !== 2 || versions.some((entry) => entry.value !== '2')) {
		throw new OAuthCatalogCutoverRequiredError();
	}
	for (const table of Object.values(oauthCatalogSchema)) {
		const columns = columnRowsSchema.parse(
			database
				.prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?)')
				.all(getTableName(table)),
		);
		const expectedColumns: readonly Column[] = Object.values(getTableColumns(table));
		if (
			columns.length !== expectedColumns.length ||
			expectedColumns.some((expected) => {
				const actual = columns.find((column) => column.name === expected.name);
				return (
					actual === undefined ||
					actual.type.toLowerCase() !== expected.getSQLType().toLowerCase() ||
					Boolean(actual.notnull) !== expected.notNull ||
					actual.pk > 0 !== expected.primary
				);
			})
		)
			throw new OAuthCatalogCutoverRequiredError();
	}
}

/** Caller holds deployment ownership; no migration, chmod or write-mode open occurs here. */
export async function assertOAuthCatalogCanOpen(databasePath: string): Promise<void> {
	const size = await existingFileSize(databasePath);
	if (size === undefined || size === 0) {
		// An orphaned recovery file must not be overwritten by fresh initialization.
		const sidecars = await Promise.all([
			existingFileSize(`${databasePath}-wal`),
			existingFileSize(`${databasePath}-shm`),
		]);
		if (sidecars.some((sidecarSize) => sidecarSize !== undefined && sidecarSize > 0)) {
			throw new OAuthCatalogCutoverRequiredError();
		}
		return;
	}
	let database: BetterSqlite3.Database | undefined;
	try {
		// Read-only SQLite may update SHM reader marks. Database/WAL contents must
		// remain unchanged, and this connection must never perform a checkpoint.
		database = new BetterSqlite3(databasePath, { fileMustExist: true, readonly: true });
		assertCurrentSchema(database);
	} catch (error) {
		if (error instanceof OAuthCatalogCutoverRequiredError) throw error;
		throw new OAuthCatalogCutoverRequiredError({ cause: error });
	} finally {
		database?.close();
	}
}
