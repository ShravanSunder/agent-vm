export interface KeyedAsyncLock {
	runExclusive<TResult>(key: string, operation: () => Promise<TResult>): Promise<TResult>;
}

export function createKeyedAsyncLock(): KeyedAsyncLock {
	const pendingByKey = new Map<string, Promise<void>>();
	return {
		async runExclusive<TResult>(key: string, operation: () => Promise<TResult>): Promise<TResult> {
			const prior = pendingByKey.get(key) ?? Promise.resolve();
			let release: (() => void) | undefined;
			const current = new Promise<void>((resolve) => {
				release = resolve;
			});
			const tail = prior.then(() => current);
			pendingByKey.set(key, tail);
			await prior;
			try {
				return await operation();
			} finally {
				release?.();
				if (pendingByKey.get(key) === tail) pendingByKey.delete(key);
			}
		},
	};
}
