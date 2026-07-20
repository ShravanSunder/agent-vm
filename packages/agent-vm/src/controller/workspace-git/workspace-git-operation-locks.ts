export interface WorkspaceGitResourceIdentity {
	readonly agentId: string;
	readonly resourceKind: 'workspace';
	readonly zoneId: string;
}

function buildWorkspaceGitResourceKey(identity: WorkspaceGitResourceIdentity): string {
	return [identity.zoneId, identity.agentId, identity.resourceKind].join('\u0000');
}

export class WorkspaceGitOperationLocks {
	private readonly queuesByResourceKey = new Map<string, Promise<void>>();

	public async runExclusive<TValue>(
		identity: WorkspaceGitResourceIdentity,
		operation: () => Promise<TValue>,
	): Promise<TValue> {
		const resourceKey = buildWorkspaceGitResourceKey(identity);
		const previousQueue = this.queuesByResourceKey.get(resourceKey) ?? Promise.resolve();
		let releaseCurrentQueue!: () => void;
		const currentQueue = new Promise<void>((resolve) => {
			releaseCurrentQueue = resolve;
		});
		const chainedQueue = previousQueue.then(async () => await currentQueue);
		this.queuesByResourceKey.set(resourceKey, chainedQueue);
		await previousQueue;
		try {
			return await operation();
		} finally {
			releaseCurrentQueue();
			if (this.queuesByResourceKey.get(resourceKey) === chainedQueue) {
				this.queuesByResourceKey.delete(resourceKey);
			}
		}
	}
}
