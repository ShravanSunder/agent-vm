export class ZoneGitOperationLocks {
	private readonly queuesByZoneId = new Map<string, Promise<void>>();

	public async runExclusive<TValue>(
		zoneId: string,
		operation: () => Promise<TValue>,
	): Promise<TValue> {
		const previousQueue = this.queuesByZoneId.get(zoneId) ?? Promise.resolve();
		let releaseCurrentQueue!: () => void;
		const currentQueue = new Promise<void>((resolve) => {
			releaseCurrentQueue = resolve;
		});
		const chainedQueue = previousQueue.then(async () => await currentQueue);
		this.queuesByZoneId.set(zoneId, chainedQueue);
		await previousQueue;
		try {
			return await operation();
		} finally {
			releaseCurrentQueue();
			if (this.queuesByZoneId.get(zoneId) === chainedQueue) {
				this.queuesByZoneId.delete(zoneId);
			}
		}
	}
}
