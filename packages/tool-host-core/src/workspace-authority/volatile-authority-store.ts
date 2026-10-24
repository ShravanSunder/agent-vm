import type {
	WorkspaceAuthorityStore,
	WorkspaceAuthorityTransaction,
} from '#tool-host-core/workspace-authority/models/workspace-authority-store';

/** Process-local conformance store; reopening it does not prove durable storage. */
export function createVolatileAuthorityStore(): WorkspaceAuthorityStore {
	let committed = new Map<string, unknown>();
	let pending: Promise<unknown> = Promise.resolve();
	function transaction<TResult>(
		decide: (storage: WorkspaceAuthorityTransaction) => Promise<TResult>,
	): Promise<TResult> {
		const result = pending.then(async () => {
			const staged = structuredClone(committed);
			const storage: WorkspaceAuthorityTransaction = {
				read: async (key) => structuredClone(staged.get(key)),
				write: async (key, value) => {
					staged.set(key, structuredClone(value));
				},
			};
			const answer = await decide(storage);
			committed = staged;
			return answer;
		});
		pending = result.catch(() => undefined);
		return result;
	}
	return {
		transaction,
		read: (key) => transaction(async (storage) => storage.read(key)),
		write: (key, value) => transaction(async (storage) => storage.write(key, value)),
	};
}
