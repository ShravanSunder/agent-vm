import crypto from 'node:crypto';

declare const hostGitDirBrand: unique symbol;
declare const vmWorkPathBrand: unique symbol;

export type HostGitDir = string & { readonly [hostGitDirBrand]: 'HostGitDir' };
export type VmWorkPath = string & { readonly [vmWorkPathBrand]: 'VmWorkPath' };

export function createHostGitDir(value: string): HostGitDir {
	if (value.startsWith('/gitdirs/') || value.startsWith('/work/repos/')) {
		throw new Error(`Expected a host gitdir path, received VM path '${value}'.`);
	}
	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- constructor validates the host/VM path domain before applying the brand
	return value as HostGitDir;
}

export function createVmWorkPath(value: string): VmWorkPath {
	if (!value.startsWith('/work/repos/')) {
		throw new Error(`Expected VM work path under /work/repos, received '${value}'.`);
	}
	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- constructor validates the VM work path domain before applying the brand
	return value as VmWorkPath;
}

export interface ActiveWorkerTaskRepo {
	readonly repoUrl: string;
	readonly baseBranch: string;
	readonly hostGitDir: HostGitDir;
	readonly vmWorkPath: VmWorkPath;
}

export interface ActiveWorkerTaskIngress {
	readonly host: string;
	readonly port: number;
}

export interface ActiveWorkerTask {
	readonly taskId: string;
	readonly zoneId: string;
	readonly taskRoot: string;
	readonly eventLogPath: string;
	readonly branchPrefix: string;
	readonly repos: readonly ActiveWorkerTaskRepo[];
	readonly workerIngress: ActiveWorkerTaskIngress | null;
}

interface ZoneTaskState {
	readonly reservations: Set<string>;
	readonly tasksById: Map<string, ActiveWorkerTask>;
}

export class ActiveTaskRegistry {
	private readonly tasksByZone = new Map<string, ZoneTaskState>();

	public tryReserve(zoneId: string, maxActiveTasksPerPod: number): string | null {
		const state = this.getOrCreateZoneState(zoneId);
		if (state.tasksById.size + state.reservations.size >= maxActiveTasksPerPod) {
			return null;
		}
		const reservationId = crypto.randomUUID();
		state.reservations.add(reservationId);
		return reservationId;
	}

	public activateReservation(zoneId: string, reservationId: string, task: ActiveWorkerTask): void {
		const state = this.getOrCreateZoneState(zoneId);
		if (!state.reservations.has(reservationId)) {
			throw new Error(
				`Zone '${zoneId}' does not have reservation '${reservationId}' for task '${task.taskId}'.`,
			);
		}
		state.reservations.delete(reservationId);
		state.tasksById.set(task.taskId, task);
	}

	public releaseReservation(zoneId: string, reservationId: string): boolean {
		const state = this.tasksByZone.get(zoneId);
		if (!state) {
			return false;
		}
		const deleted = state.reservations.delete(reservationId);
		this.deleteZoneIfEmpty(zoneId, state);
		return deleted;
	}

	public get(zoneId: string, taskId: string): ActiveWorkerTask | null {
		const state = this.tasksByZone.get(zoneId);
		if (!state) {
			return null;
		}
		return state.tasksById.get(taskId) ?? null;
	}

	public listForZone(zoneId: string): readonly ActiveWorkerTask[] {
		return [...(this.tasksByZone.get(zoneId)?.tasksById.values() ?? [])];
	}

	public countOccupiedForZone(zoneId: string): number {
		const state = this.tasksByZone.get(zoneId);
		if (!state) {
			return 0;
		}
		return state.tasksById.size + state.reservations.size;
	}

	public setWorkerIngress(
		zoneId: string,
		taskId: string,
		workerIngress: ActiveWorkerTaskIngress,
	): void {
		const task = this.get(zoneId, taskId);
		if (!task) {
			throw new Error(`Zone '${zoneId}' has no active task '${taskId}' to update.`);
		}
		const state = this.getOrCreateZoneState(zoneId);
		state.tasksById.set(taskId, { ...task, workerIngress });
	}

	public clear(zoneId: string, taskId: string): void {
		const state = this.tasksByZone.get(zoneId);
		if (!state) {
			throw new Error(`Zone '${zoneId}' has no active task '${taskId}' to clear.`);
		}
		if (!state.tasksById.delete(taskId)) {
			throw new Error(`Zone '${zoneId}' has no active task '${taskId}' to clear.`);
		}
		this.deleteZoneIfEmpty(zoneId, state);
	}

	private getOrCreateZoneState(zoneId: string): ZoneTaskState {
		const existingState = this.tasksByZone.get(zoneId);
		if (existingState) {
			return existingState;
		}
		const state: ZoneTaskState = {
			reservations: new Set<string>(),
			tasksById: new Map<string, ActiveWorkerTask>(),
		};
		this.tasksByZone.set(zoneId, state);
		return state;
	}

	private deleteZoneIfEmpty(zoneId: string, state: ZoneTaskState): void {
		if (state.tasksById.size === 0 && state.reservations.size === 0) {
			this.tasksByZone.delete(zoneId);
		}
	}
}
