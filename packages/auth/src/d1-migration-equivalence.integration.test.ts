import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { expect, it } from 'vitest';

import { d1MigrationStatements } from '#auth/test-fixtures/d1-migration-statements';

it('preserves the schema and statement order of the exact original migration scripts', async () => {
	const migrations = await Promise.all(
		['0001-better-auth.sql', '0002-private-admission-audit.sql'].map((file) =>
			readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
		),
	);
	const original = new DatabaseSync(':memory:');
	const batched = new DatabaseSync(':memory:');
	try {
		original.exec(migrations.join('\n'));
		for (const statement of d1MigrationStatements(migrations)) batched.exec(statement);
		const schemaQuery =
			"SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid";
		expect(batched.prepare(schemaQuery).all()).toEqual(original.prepare(schemaQuery).all());
		expect(
			batched
				.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all(),
		).toHaveLength(16);
		expect(
			d1MigrationStatements(migrations).every((statement) => !statement.startsWith('--')),
		).toBe(true);
	} finally {
		original.close();
		batched.close();
	}
});
