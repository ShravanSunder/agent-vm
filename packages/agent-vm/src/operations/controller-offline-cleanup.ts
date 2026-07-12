import type { LoadedSystemConfig } from '../config/system-config.js';
import { cleanupRecordedToolVmRuntimes as cleanupRecordedToolVmRuntimesDefault } from '../controller/leases/tool-vm-recovery.js';
import { acquireControllerOwnershipLock as acquireControllerOwnershipLockDefault } from '../controller/vm-ownership/controller-ownership-lock.js';
import { cleanupRecordedGatewayRuntime as cleanupRecordedGatewayRuntimeDefault } from '../gateway/gateway-recovery.js';

export interface ControllerOfflineCleanupResult {
	readonly results: readonly {
		readonly ownershipDisposition: 'complete';
		readonly stateDir: string;
		readonly zoneId: string;
	}[];
}

function isConnectionRefusedError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	if ('code' in error && error.code === 'ECONNREFUSED') {
		return true;
	}
	if ('cause' in error) {
		return isConnectionRefusedError(error.cause);
	}
	return false;
}

async function assertControllerUnavailableForOfflineCleanup(controllerPort: number): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, 750);
	try {
		const response = await fetch(`http://127.0.0.1:${controllerPort}/health`, {
			signal: controller.signal,
		});
		throw new Error(
			`Refusing offline cleanup because the controller health endpoint responded with HTTP ${response.status} on port ${controllerPort}. Use 'agent-vm controller stop' first, or rerun cleanup with --force if the controller is responding but cannot stop the gateway.`,
		);
	} catch (error) {
		if (isConnectionRefusedError(error)) {
			return;
		}
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(
				`Refusing offline cleanup because the controller health probe timed out on port ${controllerPort}. Use --force only if the controller cannot stop the gateway.`,
				{ cause: error },
			);
		}
		throw new Error(
			`Refusing offline cleanup because the controller health probe failed ambiguously on port ${controllerPort}: ${error instanceof Error ? error.message : String(error)}. Use --force only if the controller cannot stop the gateway.`,
			{ cause: error },
		);
	} finally {
		clearTimeout(timeout);
	}
}

export interface RecordedVmTreeReconciliationDependencies {
	readonly cleanupRecordedGatewayRuntime?: typeof cleanupRecordedGatewayRuntimeDefault;
	readonly cleanupRecordedToolVmRuntimes?: typeof cleanupRecordedToolVmRuntimesDefault;
}

interface ControllerOfflineCleanupDependencies extends RecordedVmTreeReconciliationDependencies {
	readonly acquireControllerOwnershipLock?: typeof acquireControllerOwnershipLockDefault;
	readonly assertControllerUnavailableForOfflineCleanup?: (controllerPort: number) => Promise<void>;
	readonly cleanupRecordedVmTree?: (options: {
		readonly systemConfig: LoadedSystemConfig;
		readonly zoneId: string;
	}) => Promise<void>;
}

export async function reconcileRecordedVmTree(options: {
	readonly dependencies?: RecordedVmTreeReconciliationDependencies;
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
}): Promise<void> {
	const zone = options.systemConfig.zones.find((candidate) => candidate.id === options.zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}
	if (zone.gateway.type !== 'openclaw') {
		return;
	}

	const cleanupScope = {
		expectedConfigPath: options.systemConfig.systemConfigPath,
		expectedControllerPort: options.systemConfig.host.controllerPort,
		mode: 'offline-cleanup' as const,
		projectNamespace: options.systemConfig.host.projectNamespace,
		stateDir: zone.gateway.stateDir,
		zoneId: zone.id,
	};
	const toolCleanup = await (
		options.dependencies?.cleanupRecordedToolVmRuntimes ?? cleanupRecordedToolVmRuntimesDefault
	)({
		...cleanupScope,
		tcpBasePort: options.systemConfig.tcpPool.basePort,
	});
	if (toolCleanup.warnings.length > 0 || toolCleanup.quarantinedCount > 0) {
		throw new Error(
			`Offline Tool VM cleanup for zone '${zone.id}' did not complete safely: ${toolCleanup.warnings.join('; ') || `${String(toolCleanup.quarantinedCount)} runtime record(s) remain quarantined`}`,
		);
	}

	const gatewayCleanup = await (
		options.dependencies?.cleanupRecordedGatewayRuntime ?? cleanupRecordedGatewayRuntimeDefault
	)({
		...cleanupScope,
		configuredIngressPort: zone.gateway.port,
	});
	if (gatewayCleanup.cleanupWarning !== undefined) {
		throw new Error(
			`Offline Gateway cleanup for zone '${zone.id}' did not complete safely: ${gatewayCleanup.cleanupWarning}`,
		);
	}
}

export async function runControllerOfflineCleanup(
	options: {
		readonly force?: boolean;
		readonly systemConfig: LoadedSystemConfig;
		readonly zoneId: string;
	},
	dependencies: ControllerOfflineCleanupDependencies = {},
): Promise<ControllerOfflineCleanupResult> {
	const zone = options.systemConfig.zones.find(
		(candidateZone) => candidateZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}

	const controllerOwnershipLock = await (
		dependencies.acquireControllerOwnershipLock ?? acquireControllerOwnershipLockDefault
	)({ runtimeDirectory: options.systemConfig.runtimeDir });
	let cleanupResult: ControllerOfflineCleanupResult | undefined;
	let cleanupError: unknown;
	try {
		if (options.force !== true) {
			await (
				dependencies.assertControllerUnavailableForOfflineCleanup ??
				assertControllerUnavailableForOfflineCleanup
			)(options.systemConfig.host.controllerPort);
		}

		if (dependencies.cleanupRecordedVmTree) {
			await dependencies.cleanupRecordedVmTree({
				systemConfig: options.systemConfig,
				zoneId: zone.id,
			});
		} else {
			await reconcileRecordedVmTree({
				dependencies: {
					...(dependencies.cleanupRecordedGatewayRuntime
						? { cleanupRecordedGatewayRuntime: dependencies.cleanupRecordedGatewayRuntime }
						: {}),
					...(dependencies.cleanupRecordedToolVmRuntimes
						? { cleanupRecordedToolVmRuntimes: dependencies.cleanupRecordedToolVmRuntimes }
						: {}),
				},
				systemConfig: options.systemConfig,
				zoneId: zone.id,
			});
		}
		cleanupResult = {
			results: [
				{
					ownershipDisposition: 'complete',
					stateDir: zone.gateway.stateDir,
					zoneId: zone.id,
				},
			],
		};
	} catch (error) {
		cleanupError = error;
	}
	let lockReleaseError: unknown;
	try {
		await controllerOwnershipLock.release();
	} catch (error) {
		lockReleaseError = error;
	}
	if (cleanupError !== undefined && lockReleaseError !== undefined) {
		throw new AggregateError(
			[cleanupError, lockReleaseError],
			'Controller offline cleanup and ownership lock release both failed',
			{ cause: cleanupError },
		);
	}
	if (cleanupError !== undefined) {
		throw cleanupError;
	}
	if (lockReleaseError !== undefined) {
		throw lockReleaseError;
	}
	if (cleanupResult === undefined) {
		throw new Error('Controller offline cleanup completed without a result.');
	}
	return cleanupResult;
}
