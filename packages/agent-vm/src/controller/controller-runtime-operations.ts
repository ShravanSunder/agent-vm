import type { GatewayProcessSpec } from '@shravansunder/gateway-interface';
import type { SecretResolver } from '@shravansunder/gondolin-core';

import type { SystemConfig } from '../config/system-config.js';
import { resolveZoneSecrets } from '../gateway/credential-manager.js';
import { buildControllerStatus } from '../operations/controller-status.js';
import { runControllerCredentialsRefresh } from '../operations/credentials-refresh.js';
import { runControllerDestroy } from '../operations/destroy-zone.js';
import { runControllerUpgrade } from '../operations/upgrade-zone.js';
import { runControllerLogs } from '../operations/zone-logs.js';
import type { LeaseManager } from './leases/lease-manager.js';

interface GatewayZoneRuntime {
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly processSpec: GatewayProcessSpec;
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
	readonly refreshZoneCredentials: (targetZoneId: string) => Promise<{
		readonly ok: true;
		readonly zoneId: string;
	}>;
	readonly upgradeZone: (targetZoneId: string) => Promise<unknown>;
}

function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}

export function createControllerRuntimeOperations(options: {
	readonly activeZoneId: string;
	readonly getGateway: () => GatewayZoneRuntime;
	readonly getZone: (zoneId: string) => SystemConfig['zones'][number];
	readonly leaseManager: Pick<LeaseManager, 'listLeases' | 'releaseLease'>;
	readonly restartGatewayZone: () => Promise<void>;
	readonly secretResolver: SecretResolver;
	readonly stopGatewayZone: () => Promise<void>;
	readonly systemConfig: SystemConfig;
}): ControllerRuntimeOperations {
	const assertActiveZone = (targetZoneId: string): void => {
		if (targetZoneId !== options.activeZoneId) {
			throw new Error(
				`Controller is running zone '${options.activeZoneId}', not '${targetZoneId}'. Multi-zone runtime selection is not implemented yet.`,
			);
		}
	};

	return {
		enableSshForZone: async (targetZoneId: string) => {
			assertActiveZone(targetZoneId);
			return await options.getGateway().vm.enableSsh();
		},
		execInZone: async (targetZoneId: string, command: string) => {
			assertActiveZone(targetZoneId);
			const result = await options.getGateway().vm.exec(command);
			return {
				exitCode: result.exitCode,
				stderr: result.stderr,
				stdout: result.stdout,
			};
		},
		destroyZone: async (targetZoneId: string, purge: boolean) => {
			assertActiveZone(targetZoneId);
			return await runControllerDestroy(
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
							// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
							await options.leaseManager.releaseLease(lease.id);
						}
					},
					stopGatewayZone: options.stopGatewayZone,
				},
			);
		},
		getStatus: async () => buildControllerStatus(options.systemConfig),
		getZoneLogs: async (targetZoneId: string) => {
			assertActiveZone(targetZoneId);
			return await runControllerLogs(
				{
					zoneId: targetZoneId,
				},
				{
					readGatewayLogs: async () => {
						try {
							const result = await options
								.getGateway()
								.vm.exec(`cat ${options.getGateway().processSpec.logPath} 2>/dev/null || echo ""`);
							return result.stdout;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							writeStderr(
								`[controller-runtime-operations] Failed to read gateway logs for ${targetZoneId}: ${message}`,
							);
							return '';
						}
					},
				},
			);
		},
		refreshZoneCredentials: async (targetZoneId: string) => {
			assertActiveZone(targetZoneId);
			return await runControllerCredentialsRefresh(
				{
					zoneId: targetZoneId,
				},
				{
					refreshZoneSecrets: async (zoneId: string) => {
						await resolveZoneSecrets({
							secretResolver: options.secretResolver,
							systemConfig: options.systemConfig,
							zoneId,
						});
					},
					restartGatewayZone: async () => {
						await options.stopGatewayZone();
						await options.restartGatewayZone();
					},
				},
			);
		},
		upgradeZone: async (targetZoneId: string) => {
			assertActiveZone(targetZoneId);
			return await runControllerUpgrade(
				{
					systemConfig: options.systemConfig,
					zoneId: targetZoneId,
				},
				{
					rebuildGatewayImage: async () => {},
					restartGatewayZone: options.restartGatewayZone,
					stopGatewayZone: options.stopGatewayZone,
				},
			);
		},
	};
}

export function createStopControllerOperation(options: {
	readonly clearReaperTimer: () => void;
	readonly closeControllerServer: () => void;
	readonly getLeases: () => readonly { readonly id: string }[];
	readonly releaseLease: (leaseId: string) => Promise<void>;
	readonly stopGatewayZone: () => Promise<void>;
}): () => Promise<{ readonly ok: true }> {
	return async (): Promise<{ readonly ok: true }> => {
		options.clearReaperTimer();
		for (const lease of options.getLeases()) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
			await options.releaseLease(lease.id);
		}
		try {
			await options.stopGatewayZone();
		} finally {
			options.closeControllerServer();
		}
		return { ok: true } as const;
	};
}
