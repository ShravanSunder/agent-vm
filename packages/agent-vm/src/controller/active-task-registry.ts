export interface ActiveWorkerTaskRepo {
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly hostWorkspacePath: string;
	readonly vmWorkspacePath: string;
}

export interface ActiveWorkerTask {
	readonly taskId: string;
	readonly zoneId: string;
	readonly taskRoot: string;
	readonly branchPrefix: string;
	readonly repos: readonly ActiveWorkerTaskRepo[];
}

export class ActiveTaskRegistry {
	private readonly tasksByZone = new Map<string, ActiveWorkerTask>();

	public register(task: ActiveWorkerTask): void {
		const existingTask = this.tasksByZone.get(task.zoneId);
		if (existingTask) {
			throw new Error(
				`Zone '${task.zoneId}' already has active task '${existingTask.taskId}', cannot register '${task.taskId}'.`,
			);
		}

		this.tasksByZone.set(task.zoneId, task);
	}

	public get(zoneId: string, taskId: string): ActiveWorkerTask | null {
		const task = this.tasksByZone.get(zoneId);
		if (!task || task.taskId !== taskId) {
			return null;
		}
		return task;
	}

	public getActiveForZone(zoneId: string): ActiveWorkerTask | null {
		return this.tasksByZone.get(zoneId) ?? null;
	}

	public clear(zoneId: string, taskId: string): void {
		const task = this.tasksByZone.get(zoneId);
		if (!task) {
			throw new Error(`Zone '${zoneId}' has no active task to clear.`);
		}
		if (task.taskId !== taskId) {
			throw new Error(
				`Zone '${zoneId}' active task is '${task.taskId}', cannot clear '${taskId}'.`,
			);
		}
		this.tasksByZone.delete(zoneId);
	}
}
