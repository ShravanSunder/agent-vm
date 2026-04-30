import type { SystemConfig } from '../config/system-config.js';
import {
	buildControllerStatus,
	buildControllerZoneStatus,
	type ControllerRuntimeStatus,
} from '../operations/controller-status.js';
import type {
	ControllerZoneRuntime,
	OpenClawZoneRuntime,
} from './zone-runtimes/zone-runtime-types.js';

interface ControllerRuntimeOperations {
	readonly destroyZone: (targetZoneId: string, purge: boolean) => Promise<unknown>;
	readonly enableSshForZone: (targetZoneId: string) => Promise<unknown>;
	readonly execInZone: (
		targetZoneId: string,
		command: string,
	) => Promise<{
		readonly exitCode: number;
		readonly stderr: string;
		readonly stdout: string;
	}>;
	readonly getStatus: () => Promise<unknown>;
	readonly getZoneLogs: (targetZoneId: string) => Promise<{
		readonly output: string;
		readonly zoneId: string;
	}>;
	readonly getZoneStatus: (targetZoneId: string) => Promise<unknown>;
	readonly refreshZoneCredentials: (targetZoneId: string) => Promise<{
		readonly ok: true;
		readonly zoneId: string;
	}>;
	readonly upgradeZone: (targetZoneId: string) => Promise<unknown>;
}

export function createControllerRuntimeOperations(options: {
	readonly getActiveLeases: () => readonly { readonly zoneId: string }[];
	readonly getOpenClawRuntime: (
		zoneId: string,
	) => Pick<
		OpenClawZoneRuntime,
		'destroy' | 'enableSsh' | 'exec' | 'getLogs' | 'refreshCredentials' | 'upgrade'
	>;
	readonly getRuntime: (zoneId: string) => Pick<ControllerZoneRuntime, 'destroy'>;
	readonly getRuntimeStatusByZone: () => ControllerRuntimeStatus['zones'];
	readonly systemConfig: SystemConfig;
}): ControllerRuntimeOperations {
	const buildRuntimeStatus = (): ControllerRuntimeStatus => {
		const zones = options.getRuntimeStatusByZone();
		return {
			activeLeases: options.getActiveLeases(),
			...(zones ? { zones } : {}),
		};
	};

	return {
		destroyZone: async (targetZoneId, purge) =>
			await options.getRuntime(targetZoneId).destroy(purge),
		enableSshForZone: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).enableSsh(),
		execInZone: async (targetZoneId, command) =>
			await options.getOpenClawRuntime(targetZoneId).exec(command),
		getStatus: async () => buildControllerStatus(options.systemConfig, buildRuntimeStatus()),
		getZoneLogs: async (targetZoneId) => await options.getOpenClawRuntime(targetZoneId).getLogs(),
		getZoneStatus: async (targetZoneId) =>
			buildControllerZoneStatus(options.systemConfig, targetZoneId, buildRuntimeStatus()),
		refreshZoneCredentials: async (targetZoneId) =>
			await options.getOpenClawRuntime(targetZoneId).refreshCredentials(),
		upgradeZone: async (targetZoneId) => await options.getOpenClawRuntime(targetZoneId).upgrade(),
	};
}

export function createStopControllerOperation(options: {
	readonly clearReaperTimer: () => void;
	readonly closeControllerServer: () => void;
	readonly getLeases: () => readonly { readonly id: string }[];
	readonly releaseLease: (leaseId: string) => Promise<void>;
	readonly stopAllZones: () => Promise<void>;
}): () => Promise<{ readonly ok: true }> {
	return async (): Promise<{ readonly ok: true }> => {
		options.clearReaperTimer();
		for (const lease of options.getLeases()) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
			await options.releaseLease(lease.id);
		}
		try {
			await options.stopAllZones();
		} finally {
			options.closeControllerServer();
		}
		return { ok: true } as const;
	};
}
