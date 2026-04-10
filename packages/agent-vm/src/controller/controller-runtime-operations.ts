import { runControllerCredentialsRefresh } from '../operations/credentials-refresh.js';
import { runControllerDestroy } from '../operations/destroy-zone.js';
import { buildControllerStatus } from '../operations/controller-status.js';
import { runControllerLogs } from '../operations/zone-logs.js';
import { runControllerUpgrade } from '../operations/upgrade-zone.js';
import type { LeaseManager } from './lease-manager.js';
import type { SystemConfig } from './system-config.js';

interface GatewayZoneRuntime {
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly vm: {
		close(): Promise<void>;
		enableSsh(): Promise<unknown>;
		exec(command: string): Promise<{
			readonly exitCode: number;
			readonly stderr: string;
			readonly stdout: string;
		}>;
	};
}

export function createControllerRuntimeOperations(options: {
	readonly getGateway: () => GatewayZoneRuntime;
	readonly getZone: (zoneId: string) => SystemConfig['zones'][number];
	readonly leaseManager: Pick<LeaseManager, 'listLeases' | 'releaseLease'>;
	readonly restartGatewayZone: () => Promise<void>;
	readonly secretResolver: {
		resolveAll: (
			secrets: SystemConfig['zones'][number]['secrets'],
		) => Promise<Record<string, string>>;
	};
	readonly stopGatewayZone: () => Promise<void>;
	readonly systemConfig: SystemConfig;
}) {
	return {
		enableSshForZone: async () => await options.getGateway().vm.enableSsh(),
		execInZone: async (_targetZoneId: string, command: string) => {
			const result = await options.getGateway().vm.exec(command);
			return {
				exitCode: result.exitCode,
				stderr: result.stderr,
				stdout: result.stdout,
			};
		},
		destroyZone: async (targetZoneId: string, purge: boolean) =>
			await runControllerDestroy(
				{
					purge,
					systemConfig: options.systemConfig,
					zoneId: targetZoneId,
				},
				{
					releaseZoneLeases: async () => {
						for (const lease of options.leaseManager
							.listLeases()
							.filter((activeLease) => activeLease.zoneId === targetZoneId)) {
							await options.leaseManager.releaseLease(lease.id);
						}
					},
					stopGatewayZone: options.stopGatewayZone,
				},
			),
		getStatus: async () => buildControllerStatus(options.systemConfig),
		getZoneLogs: async (targetZoneId: string) =>
			await runControllerLogs(
				{
					zoneId: targetZoneId,
				},
				{
					readGatewayLogs: async () => {
						try {
							const result = await options
								.getGateway()
								.vm.exec('cat /tmp/openclaw.log 2>/dev/null || echo ""');
							return result.stdout;
						} catch {
							return '';
						}
					},
				},
			),
		refreshZoneCredentials: async (targetZoneId: string) =>
			await runControllerCredentialsRefresh(
				{
					zoneId: targetZoneId,
				},
				{
					refreshZoneSecrets: async (zoneId: string) => {
						await options.secretResolver.resolveAll(
							options.getZone(zoneId).secrets,
						);
					},
					restartGatewayZone: async () => {
						await options.stopGatewayZone();
						await options.restartGatewayZone();
					},
				},
			),
		upgradeZone: async (targetZoneId: string) =>
			await runControllerUpgrade(
				{
					systemConfig: options.systemConfig,
					zoneId: targetZoneId,
				},
				{
					rebuildGatewayImage: async () => {},
					restartGatewayZone: options.restartGatewayZone,
					stopGatewayZone: options.stopGatewayZone,
				},
			),
	};
}

export function createStopControllerOperation(options: {
	readonly clearReaperTimer: () => void;
	readonly closeControllerServer: () => void;
	readonly getLeases: () => readonly { readonly id: string }[];
	readonly releaseLease: (leaseId: string) => Promise<void>;
	readonly stopGatewayZone: () => Promise<void>;
}) {
	return async () => {
		options.clearReaperTimer();
		for (const lease of options.getLeases()) {
			await options.releaseLease(lease.id);
		}
		await options.stopGatewayZone();
		options.closeControllerServer();
		return { ok: true } as const;
	};
}
