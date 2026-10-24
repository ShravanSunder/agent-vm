export interface SignInSqlStatement {
	readonly bind: (...values: readonly unknown[]) => SignInSqlStatement;
	readonly first: () => Promise<Record<string, unknown> | null>;
	readonly all: () => Promise<{ readonly results: readonly Record<string, unknown>[] }>;
	readonly run: () => Promise<void>;
}

export interface SignInSqlSession {
	readonly prepare: (query: string) => SignInSqlStatement;
}

/** Application reads use the primary; a batch commits every supplied statement or none. */
export interface SignInSqlDatabase extends SignInSqlSession {
	readonly primary: () => SignInSqlSession;
	readonly batch: (statements: readonly SignInSqlStatement[]) => Promise<void>;
}
