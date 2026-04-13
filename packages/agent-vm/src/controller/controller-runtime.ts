import { createOpCliSecretResolver, type ManagedVm } from '@shravansunder/agent-vm-gondolin-core';

import { deleteGatewayRuntimeRecord as deleteGatewayRuntimeRecordDefault } from '../gateway/gateway-runtime-record.js';
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
import {
	createSecretResolverFromSystemConfig,
	findConfiguredZone,
} from './controller-runtime-support.js';
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
			await createSecretResolverFromSystemConfig(
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
	const zone = findConfiguredZone(options.systemConfig, options.zoneId);
	let gateway: Awaited<ReturnType<typeof startGatewayZone>> | undefined;
	const requireGateway = (): Awaited<ReturnType<typeof startGatewayZone>> => {
		if (!gateway) {
			throw new Error('Gateway runtime is unavailable because the last restart did not complete.');
		}
		return gateway;
	};
	await runTaskStep('Starting gateway zone', async () => {
		gateway = await startGateway();
	});
	const stopGatewayZone = async (): Promise<void> => {
		if (!gateway) {
			return;
		}
		try {
			await gateway.vm.close();
		} finally {
			await (dependencies.deleteGatewayRuntimeRecord ?? deleteGatewayRuntimeRecordDefault)(
				zone.gateway.stateDir,
			);
		}
	};
	const restartGatewayZone = async (): Promise<void> => {
		gateway = undefined;
		gateway = await startGateway();
	};
	const serverRef: { current?: { close(): Promise<void> } } = {};
	const controllerApp = createControllerService({
		leaseManager,
		operations: {
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
		},
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
		gateway: {
			ingress: requireGateway().ingress,
			processSpec: requireGateway().processSpec,
			vm: requireGateway().vm,
		},
	};
}
