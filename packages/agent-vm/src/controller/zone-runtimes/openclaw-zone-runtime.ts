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
	OpenClawZoneRestartOptions,
	OpenClawZoneRestartResult,
} from './zone-runtime-types.js';

type OpenClawZoneConfig = ControllerZoneConfig & {
	readonly gateway: Extract<ControllerZoneConfig['gateway'], { readonly type: 'openclaw' }>;
};

export interface CreateOpenClawZoneRuntimeOptions {
	readonly clearTimeoutImpl?: ((timer: NodeJS.Timeout) => void) | undefined;
	readonly closeGatewayTimeoutMs?: number | undefined;
	readonly deleteGatewayRuntimeRecord?: (stateDirectory: string) => Promise<void>;
	readonly leaseManager: Pick<LeaseManager, 'listLeases' | 'releaseLease'>;
	readonly now: () => number;
	readonly restartGatewayZone?: (zoneId: string) => Promise<GatewayZoneStartResult>;
	readonly runControllerCredentialsRefresh?: typeof runControllerCredentialsRefreshDefault;
	readonly runControllerDestroy?: typeof runControllerDestroyDefault;
	readonly runControllerLogs?: typeof runControllerLogsDefault;
	readonly runControllerUpgrade?: typeof runControllerUpgradeDefault;
	readonly secretResolver: SecretResolver;
	readonly setTimeoutImpl?: ((callback: () => void, delayMs: number) => NodeJS.Timeout) | undefined;
	readonly systemConfig: LoadedSystemConfig;
	readonly zone: OpenClawZoneConfig;
}

const defaultGatewayCloseTimeoutMs = 60_000;

class OpenClawZoneRestartTimeoutError extends Error {
	readonly code = 'OPENCLAW_GATEWAY_RESTART_TIMEOUT';

	constructor(zoneId: string, timeoutMs: number) {
		super(`OpenClaw gateway restart timed out for zone '${zoneId}' after ${timeoutMs}ms`);
		this.name = 'OpenClawZoneRestartTimeoutError';
	}
}

export function isOpenClawZoneRestartTimeoutError(
	error: unknown,
): error is OpenClawZoneRestartTimeoutError {
	return (
		error instanceof Error && 'code' in error && error.code === 'OPENCLAW_GATEWAY_RESTART_TIMEOUT'
	);
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

function writeOpenClawZoneRuntimeLog(message: string): void {
	process.stderr.write(`[openclaw-zone-runtime] ${message}\n`);
}

export function createOpenClawZoneRuntime(
	options: CreateOpenClawZoneRuntimeOptions,
): OpenClawZoneRuntime {
	const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
	const closeGatewayTimeoutMs = options.closeGatewayTimeoutMs ?? defaultGatewayCloseTimeoutMs;
	const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
	let gateway: GatewayZoneRuntimeHandle | undefined;
	let bootedAt: string | undefined;
	let lastError: string | undefined;
	let lifecycleOperation: Promise<void> = Promise.resolve();
	let lifecycleGeneration = 0;

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

	const runLifecycleOperation = async <TResult>(
		operation: () => Promise<TResult>,
	): Promise<TResult> => {
		const operationPromise = lifecycleOperation.then(operation, operation);
		lifecycleOperation = operationPromise.then(
			() => undefined,
			() => undefined,
		);
		return await operationPromise;
	};

	const releaseZoneLeases = async (
		zoneId: string,
	): Promise<{ readonly failedLeaseIds: readonly string[] }> => {
		const leases = options.leaseManager
			.listLeases()
			.filter((activeLease) => activeLease.zoneId === zoneId);
		const releaseResults = await Promise.allSettled(
			leases.map(
				async (lease) => await options.leaseManager.releaseLease(lease.id, { force: true }),
			),
		);
		const failedLeaseIds: string[] = [];
		for (const [index, releaseResult] of releaseResults.entries()) {
			if (releaseResult.status === 'fulfilled') {
				continue;
			}
			const leaseId = leases[index]?.id ?? `(unknown lease at index ${index})`;
			failedLeaseIds.push(leaseId);
			writeOpenClawZoneRuntimeLog(
				`lease '${leaseId}' release failed while restarting zone '${zoneId}': ${formatUnknownError(releaseResult.reason)}`,
			);
		}
		return { failedLeaseIds };
	};

	const closeGatewayWithDeadline = async (
		activeGateway: GatewayZoneRuntimeHandle,
	): Promise<void> => {
		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				activeGateway.vm.close(),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeoutImpl(() => {
						reject(
							new Error(
								`Gateway VM close timed out for zone '${options.zone.id}' after ${closeGatewayTimeoutMs}ms`,
							),
						);
					}, closeGatewayTimeoutMs);
					timeout.unref?.();
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeoutImpl(timeout);
			}
		}
	};

	const stopNow = async (): Promise<void> => {
		const activeGateway = gateway;
		gateway = undefined;
		bootedAt = undefined;
		lastError = undefined;
		if (activeGateway) {
			await closeGatewayWithDeadline(activeGateway);
		}
		await (options.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecordDefault)(
			options.zone.gateway.stateDir,
		);
	};

	const startNow = async (expectedGeneration?: number): Promise<void> => {
		try {
			const startedGateway = await startGateway();
			if (expectedGeneration !== undefined && expectedGeneration !== lifecycleGeneration) {
				try {
					await closeGatewayWithDeadline(startedGateway);
				} catch (error) {
					writeOpenClawZoneRuntimeLog(
						`stale gateway start cleanup failed for zone '${options.zone.id}': ${formatUnknownError(error)}`,
					);
				}
				return;
			}
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

	const stop = async (): Promise<void> => await runLifecycleOperation(async () => await stopNow());

	const start = async (): Promise<void> =>
		await runLifecycleOperation(async () => await startNow());

	const restart = async (
		restartOptions: OpenClawZoneRestartOptions = {},
	): Promise<OpenClawZoneRestartResult> => {
		return await runLifecycleOperation(async () => {
			lifecycleGeneration += 1;
			const operationGeneration = lifecycleGeneration;
			const restartOperation = (async (): Promise<OpenClawZoneRestartResult> => {
				const leaseReleaseResult = await releaseZoneLeases(options.zone.id);
				await stopNow();
				await startNow(operationGeneration);
				if (operationGeneration !== lifecycleGeneration) {
					throw new OpenClawZoneRestartTimeoutError(options.zone.id, restartOptions.timeoutMs ?? 0);
				}
				return { leaseReleaseFailureCount: leaseReleaseResult.failedLeaseIds.length };
			})();

			if (restartOptions.timeoutMs === undefined) {
				return await restartOperation;
			}

			const restartTimeoutMs = restartOptions.timeoutMs;
			let timeout: NodeJS.Timeout | undefined;
			try {
				return await Promise.race([
					restartOperation,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeoutImpl(() => {
							lifecycleGeneration += 1;
							reject(new OpenClawZoneRestartTimeoutError(options.zone.id, restartTimeoutMs));
						}, restartTimeoutMs);
						timeout.unref?.();
					}),
				]);
			} finally {
				if (timeout) {
					clearTimeoutImpl(timeout);
				}
			}
		});
	};

	return {
		destroy: async (purge) =>
			await (options.runControllerDestroy ?? runControllerDestroyDefault)(
				{ purge, systemConfig: options.systemConfig, zoneId: options.zone.id },
				{
					releaseZoneLeases: async (zoneId) => {
						await releaseZoneLeases(zoneId);
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
					restartGatewayZone: async () => {
						await restart();
					},
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
					restartGatewayZone: async () => {
						await restart();
					},
				},
			),
		zoneId: options.zone.id,
	};
}
