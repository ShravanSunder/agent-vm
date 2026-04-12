import { createOpCliSecretResolver, type ManagedVm } from 'gondolin-core';

import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import {
	cleanToolVmWorkspace,
	createToolVm,
	resolveToolVmWorkspaceDirectory,
} from '../tool-vm/tool-vm-lifecycle.js';
import { createControllerService } from './controller-http-routes.js';
import { startControllerHttpServer } from './controller-http-server.js';
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
import { createIdleReaper } from './idle-reaper.js';
import { createLeaseManager } from './lease-manager.js';
import { createTcpPool } from './tcp-pool.js';

export async function startControllerRuntime(
	options: StartControllerRuntimeOptions,
	dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
	const now = dependencies.now ?? Date.now;
	const runTaskStep =
		dependencies.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	let secretResolver!: Awaited<ReturnType<typeof createSecretResolverFromSystemConfig>>;
	await runTaskStep('Resolving 1Password secrets', async () => {
		secretResolver = await createSecretResolverFromSystemConfig(
			options.systemConfig,
			dependencies.createSecretResolver ?? createOpCliSecretResolver,
		);
	});
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
	let gateway!: Awaited<ReturnType<typeof startGatewayZone>>;
	await runTaskStep('Starting gateway zone', async () => {
		gateway = await startGateway();
	});
	const stopGatewayZone = async (): Promise<void> => await gateway.vm.close();
	const restartGatewayZone = async (): Promise<void> => {
		gateway = await startGateway();
	};
	const serverRef: { current?: { close(): Promise<void> } } = {};
	const controllerApp = createControllerService({
		leaseManager,
		operations: {
			...createControllerRuntimeOperations({
				activeZoneId: options.zoneId,
				getGateway: () => gateway,
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
			await gateway.vm.close();
			await serverRef.current?.close();
		},
		controllerPort: options.systemConfig.host.controllerPort,
		gateway: {
			ingress: gateway.ingress,
			vm: gateway.vm,
		},
	};
}
