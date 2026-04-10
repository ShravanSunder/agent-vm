import {
	createSecretResolver,
	type ManagedVm,
} from 'gondolin-core';

import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import { createControllerService } from './controller-http-routes.js';
import { startControllerHttpServer } from './controller-http-server.js';
import { createIdleReaper } from './idle-reaper.js';
import { createLeaseManager } from './lease-manager.js';
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
import { createTcpPool } from './tcp-pool.js';
import { createToolVm } from '../tool-vm/tool-vm-lifecycle.js';

export async function startControllerRuntime(
	options: StartControllerRuntimeOptions,
	dependencies: ControllerRuntimeDependencies,
): Promise<ControllerRuntime> {
	const now = dependencies.now ?? Date.now;
	const zone = findConfiguredZone(options.systemConfig, options.zoneId);
	const secretResolver = await createSecretResolverFromSystemConfig(
		options.systemConfig,
		dependencies.createSecretResolver ?? createSecretResolver,
	);
	const createManagedToolVm =
		dependencies.createManagedToolVm ??
		(async (toolVmOptions): Promise<ManagedVm> =>
			await createToolVm({
				profile: toolVmOptions.profile,
				systemConfig: options.systemConfig,
				tcpSlot: toolVmOptions.tcpSlot,
				workspaceDir: toolVmOptions.workspaceDir,
				zoneGatewayStateDirectory: zone.gateway.stateDir,
				zoneId: toolVmOptions.zoneId,
			}));
	const tcpPool = createTcpPool(options.systemConfig.tcpPool);
	const leaseManager = createLeaseManager({
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
	const startGateway = async (): Promise<Awaited<ReturnType<typeof startGatewayZone>>> =>
		await (dependencies.startGatewayZone ?? startGatewayZone)({
			pluginSourceDir: options.pluginSourceDir,
			secretResolver,
			systemConfig: options.systemConfig,
			zoneId: options.zoneId,
		});
	let gateway = await startGateway();
	const stopGatewayZone = async (): Promise<void> => await gateway.vm.close();
	const restartGatewayZone = async (): Promise<void> => {
		gateway = await startGateway();
	};
	let server: { close(): Promise<void> } | undefined;
	const controllerApp = createControllerService({
		leaseManager,
		operations: {
			...createControllerRuntimeOperations({
				getGateway: () => gateway,
				getZone: (zoneId: string) => findConfiguredZone(options.systemConfig, zoneId),
				leaseManager,
				restartGatewayZone,
				secretResolver,
				stopGatewayZone,
				systemConfig: options.systemConfig,
			}),
			stopController: createStopControllerOperation({
				clearReaperTimer: () =>
					(dependencies.clearIntervalImpl ?? clearInterval)(reaperTimer),
				closeControllerServer: () => setTimeout(() => void server?.close(), 100),
				getLeases: () => leaseManager.listLeases(),
				releaseLease: async (leaseId: string) => await leaseManager.releaseLease(leaseId),
				stopGatewayZone,
			}),
		},
		systemConfig: options.systemConfig,
	});
	server = await (dependencies.startHttpServer ?? startControllerHttpServer)({
		app: controllerApp,
		port: options.systemConfig.host.controllerPort,
	});

	await idleReaper.reapExpiredLeases();

		return {
			async close(): Promise<void> {
				(dependencies.clearIntervalImpl ?? clearInterval)(reaperTimer);
				await gateway.vm.close();
				await server?.close();
			},
		controllerPort: options.systemConfig.host.controllerPort,
		gateway: {
			ingress: gateway.ingress,
			vm: gateway.vm,
		},
	};
}
