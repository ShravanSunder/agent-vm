import { createOpCliSecretResolver, type ManagedVm } from '@shravansunder/gondolin-core';

import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { runTaskWithResult } from '../shared/run-task.js';
import {
	cleanToolVmWorkspace,
	createToolVm,
	resolveToolVmWorkspaceDirectory,
} from '../tool-vm/tool-vm-lifecycle.js';
import {
	createControllerRuntimeOperations,
	createStopControllerOperation,
} from './controller-runtime-operations.js';
import { createSecretResolver, findConfiguredZone } from './controller-runtime-support.js';
import {
	type ControllerRuntime,
	type ControllerRuntimeDependencies,
	type StartControllerRuntimeOptions,
} from './controller-runtime-types.js';
import { createControllerService } from './http/controller-http-routes.js';
import { startControllerHttpServer } from './http/controller-http-server.js';
import { createIdleReaper } from './leases/idle-reaper.js';
import { createLeaseManager } from './leases/lease-manager.js';
import { createTcpPool } from './leases/tcp-pool.js';
import { runWorkerTask as runWorkerTaskWithPerTaskVm } from './worker-task-runner.js';

export async function startControllerRuntime(
	options: StartControllerRuntimeOptions,
	dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
	const now = dependencies.now ?? Date.now;
	const runTaskStep =
		dependencies.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const secretResolver = await runTaskWithResult(
		runTaskStep,
		'Resolving 1Password secrets',
		async () =>
			await createSecretResolver(
				options.systemConfig,
				dependencies.createSecretResolver ?? createOpCliSecretResolver,
			),
	);
	const createManagedToolVm =
		dependencies.createManagedToolVm ??
		(async (toolVmOptions): Promise<ManagedVm> =>
			await createToolVm({
				cacheDir: options.systemConfig.cacheDir,
				profile: toolVmOptions.profile,
				systemConfig: options.systemConfig,
				tcpSlot: toolVmOptions.tcpSlot,
				workspaceDir: toolVmOptions.workspaceDir,
				zoneId: toolVmOptions.zoneId,
			}));
	const tcpPool = createTcpPool(options.systemConfig.tcpPool);
	const activeZone = findConfiguredZone(options.systemConfig, options.zoneId);
	const leaseManager = createLeaseManager({
		cleanWorkspace: async ({ profile, tcpSlot, zoneId }) => {
			await cleanToolVmWorkspace(
				resolveToolVmWorkspaceDirectory({
					profile,
					tcpSlot,
					zoneId,
				}),
			);
		},
		createManagedVm: async (leaseOptions) =>
			await createManagedToolVm({
				profile: leaseOptions.profile,
				tcpSlot: leaseOptions.tcpSlot,
				workspaceDir: leaseOptions.workspaceDir,
				zoneId: leaseOptions.zoneId,
			}),
		now,
		tcpPool,
	});
	const idleReaper = createIdleReaper({
		getLeases: () => leaseManager.listLeases(),
		now,
		releaseLease: async (leaseId: string) => {
			await leaseManager.releaseLease(leaseId);
		},
		ttlMs: 30 * 60 * 1000,
	});
	const reaperTimer = (dependencies.setIntervalImpl ?? setInterval)(
		() => void idleReaper.reapExpiredLeases(),
		60_000,
	);
	const clearReaperTimer = (): void =>
		(dependencies.clearIntervalImpl ?? clearInterval)(reaperTimer);
	const releaseAllLeases = async (): Promise<void> => {
		for (const lease of leaseManager.listLeases()) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
			await leaseManager.releaseLease(lease.id);
		}
	};
	const startGateway = async (): Promise<Awaited<ReturnType<typeof startGatewayZone>>> =>
		await (dependencies.startGatewayZone ?? startGatewayZone)({
			runTask: runTaskStep,
			secretResolver,
			systemConfig: options.systemConfig,
			zoneId: options.zoneId,
		});
	let gateway: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
	const requireGateway = (): Awaited<ReturnType<typeof startGatewayZone>> => {
		if (!gateway) {
			throw new Error('Gateway runtime is unavailable because the last restart did not complete.');
		}
		return gateway;
	};
	if (activeZone.gateway.type !== 'coding') {
		await runTaskStep('Starting gateway zone', async () => {
			gateway = await startGateway();
		});
	}
	const stopGatewayZone = async (): Promise<void> => {
		if (!gateway) {
			return;
		}
		await gateway.vm.close();
	};
	const restartGatewayZone = async (): Promise<void> => {
		gateway = undefined;
		if (activeZone.gateway.type !== 'coding') {
			gateway = await startGateway();
		}
	};
	const serverRef: { current?: { close(): Promise<void> } } = {};
	const controllerOperations =
		activeZone.gateway.type !== 'coding'
			? {
					...createControllerRuntimeOperations({
						activeZoneId: options.zoneId,
						getGateway: () => requireGateway(),
						getZone: (zoneId: string) => findConfiguredZone(options.systemConfig, zoneId),
						leaseManager,
						restartGatewayZone,
						secretResolver,
						stopGatewayZone,
						systemConfig: options.systemConfig,
					}),
					stopController: createStopControllerOperation({
						clearReaperTimer,
						closeControllerServer: () => setTimeout(() => void serverRef.current?.close(), 100),
						getLeases: () => leaseManager.listLeases(),
						releaseLease: async (leaseId: string) => await leaseManager.releaseLease(leaseId),
						stopGatewayZone,
					}),
				}
			: undefined;
	const workerTaskRunner =
		activeZone.gateway.type === 'coding'
			? async (
					zoneId: string,
					input: {
						readonly prompt: string;
						readonly repos: readonly {
							readonly repoUrl: string;
							readonly baseBranch: string;
						}[];
						readonly context: Record<string, unknown>;
					},
				) =>
					await (dependencies.runWorkerTask ?? runWorkerTaskWithPerTaskVm)({
						input,
						secretResolver,
						systemConfig: options.systemConfig,
						zoneId,
					})
			: undefined;
	const controllerApp = createControllerService({
		leaseManager,
		...(controllerOperations ? { operations: controllerOperations } : {}),
		...(workerTaskRunner ? { workerTaskRunner } : {}),
		systemConfig: options.systemConfig,
	});
	await runTaskStep(`Controller API on :${options.systemConfig.host.controllerPort}`, async () => {
		serverRef.current = await (dependencies.startHttpServer ?? startControllerHttpServer)({
			app: controllerApp,
			port: options.systemConfig.host.controllerPort,
		});
	});

	await idleReaper.reapExpiredLeases();

	return {
		async close(): Promise<void> {
			clearReaperTimer();
			await releaseAllLeases();
			try {
				await stopGatewayZone();
			} finally {
				await serverRef.current?.close();
			}
		},
		controllerPort: options.systemConfig.host.controllerPort,
		...(gateway
			? {
					gateway: {
						ingress: requireGateway().ingress,
						processSpec: requireGateway().processSpec,
						vm: requireGateway().vm,
					},
				}
			: {}),
	};
}
