import type { BetterAuthOptions } from 'better-auth';

import type { SignInSqlDatabase } from '#auth/sign-in-core/models/sign-in-database';

/** Each host supplies its provider adapter and application SQL over the same database. */
export interface SignInDatabase {
	readonly provider: NonNullable<BetterAuthOptions['database']>;
	readonly sql: SignInSqlDatabase;
}
