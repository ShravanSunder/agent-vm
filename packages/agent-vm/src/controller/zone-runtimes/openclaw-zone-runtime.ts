import type { SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import { resolveZoneSecrets } from '../../gateway/credential-manager.js';
import { runGatewayHealthCheck } from '../../gateway/gateway-health-check.js';
import { deleteGatewayRuntimeRecord as deleteGatewayRuntimeRecordDefault } from '../../gateway/gateway-runtime-record.js';
import { startGatewayZone } from '../../gateway/gateway-zone-orchestrator.js';
import type { GatewayZoneStartResult } from '../../gateway/gateway-zone-support.js';
import { runControllerCredentialsRefresh as runControllerCredentialsRefreshDefault } from '../../operations/credentials-refresh.js';
import { runControllerDestroy as runControllerDestroyDefault } from '../../operations/destroy-zone.js';
import { runControllerUpgrade as runControllerUpgradeDefault } from '../../operations/upgrade-zone.js';
import { runControllerLogs as runControllerLogsDefault } from '../../operations/zone-logs.js';
import type { LeaseManager } from '../leases/lease-manager.js';
import {
	ControllerZoneRuntimeStartError,
	ControllerZoneRuntimeUnavailableError,
} from './zone-runtime-errors.js';
import type {
	ControllerZoneConfig,
	GatewayZoneRuntimeHandle,
	OpenClawZoneRuntime,
} from './zone-runtime-types.js';

type OpenClawZoneConfig = ControllerZoneConfig & {
	readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'openclaw' }>;
};

export interface CreateOpenClawZoneRuntimeOptions {
	readonly deleteGatewayRuntimeRecord?: (stateDirectory: string) => Promise<void>;
	readonly leaseManager: Pick<LeaseManager, 'listLeases' | 'releaseLease'>;
	readonly now: () => number;
	readonly restartGatewayZone?: (zoneId: string) => Promise<GatewayZoneStartResult>;
	readonly runControllerCredentialsRefresh?: typeof runControllerCredentialsRefreshDefault;
	readonly runControllerDestroy?: typeof runControllerDestroyDefault;
	readonly runControllerLogs?: typeof runControllerLogsDefault;
	readonly runControllerUpgrade?: typeof runControllerUpgradeDefault;
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
	readonly zone: OpenClawZoneConfig;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildOpenClawCombinedLogsCommand(logPath: string): string {
	return [
		`echo '===== gateway boot log (${logPath}) ====='`,
		`cat ${logPath} 2>/dev/null || true`,
		'echo',
		"echo '===== latest openclaw runtime log (/agent-vm/logs/*.log) ====='",
		'latest_openclaw_log=$(ls -1t /agent-vm/logs/*.log 2>/dev/null | grep -v "/gateway-boot-latest\\.log$" | head -n 1); if [ -n "$latest_openclaw_log" ]; then tail -n 400 "$latest_openclaw_log"; fi',
	].join('; ');
}

export function createOpenClawZoneRuntime(
	options: CreateOpenClawZoneRuntimeOptions,
): OpenClawZoneRuntime {
	let gateway: GatewayZoneRuntimeHandle | undefined;
	let bootedAt: string | undefined;
	let lastError: string | undefined;

	const startGateway = async (): Promise<GatewayZoneStartResult> =>
		options.restartGatewayZone
			? await options.restartGatewayZone(options.zone.id)
			: await startGatewayZone({
					secretResolver: options.secretResolver,
					systemConfig: options.systemConfig,
					zoneId: options.zone.id,
				});

	const requireGateway = (): GatewayZoneRuntimeHandle => {
		if (!gateway) {
			throw new ControllerZoneRuntimeUnavailableError(options.zone.id, lastError);
		}
		return gateway;
	};

	const stop = async (): Promise<void> => {
		const activeGateway = gateway;
		gateway = undefined;
		bootedAt = undefined;
		lastError = undefined;
		if (activeGateway) {
			await activeGateway.vm.close();
		}
		await (options.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecordDefault)(
			options.zone.gateway.stateDir,
		);
	};

	const start = async (): Promise<void> => {
		try {
			const startedGateway = await startGateway();
			gateway = startedGateway;
			bootedAt = new Date(options.now()).toISOString();
			lastError = undefined;
		} catch (error) {
			gateway = undefined;
			bootedAt = undefined;
			lastError = formatUnknownError(error);
			throw new ControllerZoneRuntimeStartError(options.zone.id, error);
		}
	};

	const restart = async (): Promise<void> => {
		await stop();
		await start();
	};

	return {
		destroy: async (purge) =>
			await (options.runControllerDestroy ?? runControllerDestroyDefault)(
				{ purge, systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					releaseZoneLeases: async (zoneId) => {
						await Promise.all(
							options.leaseManager
								.listLeases()
								.filter((activeLease) => activeLease.zoneId === zoneId)
								.map(
									async (lease) =>
										await options.leaseManager.releaseLease(lease.id, { force: true }),
								),
						);
					},
					stopGatewayZone: async () => await stop(),
				},
			),
		enableSsh: async () => await requireGateway().vm.enableSsh(),
		exec: async (command) => await requireGateway().vm.exec(command),
		gatewayType: 'openclaw',
		getHealth: async () => {
			const activeGateway = requireGateway();
			const result = await runGatewayHealthCheck({
				exec: async (command) => await activeGateway.vm.exec(command),
				healthCheck: activeGateway.processSpec.healthCheck,
			});
			return {
				ok: result.ok,
				observation: result.observation,
				...(result.path === undefined ? {} : { path: result.path }),
				...(result.port === undefined ? {} : { port: result.port }),
				...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
				zoneId: options.zone.id,
			};
		},
		getLogs: async () => {
			const activeGateway = requireGateway();
			return await (options.runControllerLogs ?? runControllerLogsDefault)(
				{ zoneId: options.zone.id },
				{
					readGatewayLogs: async () =>
						(
							await activeGateway.vm.exec(
								buildOpenClawCombinedLogsCommand(activeGateway.processSpec.logPath),
							)
						).stdout,
				},
			);
		},
		getSnapshot: () => {
			if (gateway) {
				const hostPid = gateway.vm.getHostPid();
				return {
					...(bootedAt ? { bootedAt } : {}),
					gateway: {
						ingress: gateway.ingress,
						vm: {
							...(hostPid === undefined || hostPid === null ? {} : { hostPid }),
							id: gateway.vm.id,
						},
					},
					lifecycleState: 'running',
				};
			}
			return lastError ? { lastError, lifecycleState: 'failed' } : { lifecycleState: 'stopped' };
		},
		refreshCredentials: async () =>
			await (options.runControllerCredentialsRefresh ?? runControllerCredentialsRefreshDefault)(
				{ zoneId: options.zone.id },
				{
					refreshZoneSecrets: async (zoneId) => {
						await resolveZoneSecrets({
							audience: 'gateway',
							secretResolver: options.secretResolver,
							systemConfig: options.systemConfig,
							zoneId,
						});
					},
					restartGatewayZone: async () => await restart(),
				},
			),
		restart,
		shutdown: stop,
		start,
		stop,
		upgrade: async () =>
			await (options.runControllerUpgrade ?? runControllerUpgradeDefault)(
				{ systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					rebuildGatewayImage: async () => {},
					restartGatewayZone: async () => await restart(),
				},
			),
		zoneId: options.zone.id,
	};
}
