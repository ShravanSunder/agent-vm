import type { SignInDatabase } from '#auth/better-auth-provider/provider-database';
import type {
	SignInSqlSession,
	SignInSqlStatement,
} from '#auth/sign-in-core/models/sign-in-database';

class D1SignInStatement implements SignInSqlStatement {
	constructor(
		readonly database: AuthWorkerEnv['DB'],
		readonly statement: D1PreparedStatement,
	) {}

	bind(...values: readonly unknown[]): SignInSqlStatement {
		return new D1SignInStatement(this.database, this.statement.bind(...values));
	}

	async first(): Promise<Record<string, unknown> | null> {
		return this.statement.first();
	}

	async all(): Promise<{ readonly results: readonly Record<string, unknown>[] }> {
		return this.statement.all();
	}

	async run(): Promise<void> {
		await this.statement.run();
	}
}

export function createD1SignInDatabase(database: AuthWorkerEnv['DB']): SignInDatabase {
	return {
		provider: database,
		sql: {
			prepare: (query: string): SignInSqlStatement =>
				new D1SignInStatement(database, database.prepare(query)),
			primary(): SignInSqlSession {
				const session = database.withSession('first-primary');
				return {
					prepare: (query: string): SignInSqlStatement =>
						new D1SignInStatement(database, session.prepare(query)),
				};
			},
			async batch(statements: readonly SignInSqlStatement[]): Promise<void> {
				const nativeStatements = statements.map((statement) => {
					if (!(statement instanceof D1SignInStatement) || statement.database !== database)
						throw new Error('Sign-in batch contains a statement from another database');
					return statement.statement;
				});
				await database.batch(nativeStatements);
			},
		},
	};
}
