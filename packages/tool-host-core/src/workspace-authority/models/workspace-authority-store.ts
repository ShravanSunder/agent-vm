/** Read and write only within the store's atomic decision callback. */
export interface WorkspaceAuthorityTransaction {
	readonly read: (key: string) => Promise<unknown>;
	readonly write: (key: string, value: unknown) => Promise<void>;
}

/** A callback's writes commit together before its result is returned; errors roll them back. */
export interface WorkspaceAuthorityStore extends WorkspaceAuthorityTransaction {
	readonly transaction: <TResult>(
		decide: (storage: WorkspaceAuthorityTransaction) => Promise<TResult>,
	) => Promise<TResult>;
}
