/** The checked-in auth migrations contain DDL statements and whole-line comments, without SQL bodies. */
export function d1MigrationStatements(migrations: readonly string[]): readonly string[] {
	return migrations
		.join('\n')
		.replaceAll(/^--.*$/gmu, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '');
}
