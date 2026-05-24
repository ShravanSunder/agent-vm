import type { LoadedSystemConfig } from '../config/system-config.js';
import { cleanupOrphanedToolVmsIfPresent } from '../controller/leases/tool-vm-recovery.js';
import { cleanupOrphanedGatewayIfPresent } from '../gateway/gateway-recovery.js';

export interface ControllerOfflineCleanupResult {
	readonly results: readonly {
		readonly cleanedUp: boolean;
		readonly cleanupWarning?: string;
		readonly killedPid: number | null;
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

interface ControllerOfflineCleanupDependencies {
	readonly assertControllerUnavailableForOfflineCleanup?: (controllerPort: number) => Promise<void>;
	readonly cleanupOrphanedGatewayIfPresent?: typeof cleanupOrphanedGatewayIfPresent;
	readonly cleanupOrphanedToolVmsIfPresent?: typeof cleanupOrphanedToolVmsIfPresent;
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

	if (options.force !== true) {
		await (
			dependencies.assertControllerUnavailableForOfflineCleanup ??
			assertControllerUnavailableForOfflineCleanup
		)(options.systemConfig.host.controllerPort);
	}

	const cleanupToolVms =
		dependencies.cleanupOrphanedToolVmsIfPresent ?? cleanupOrphanedToolVmsIfPresent;
	const cleanupGateway =
		dependencies.cleanupOrphanedGatewayIfPresent ?? cleanupOrphanedGatewayIfPresent;
	const results: ControllerOfflineCleanupResult['results'][number][] = [];
	await cleanupToolVms({
		expectedConfigPath: options.systemConfig.systemConfigPath,
		expectedControllerPort: options.systemConfig.host.controllerPort,
		mode: 'offline-cleanup',
		projectNamespace: options.systemConfig.host.projectNamespace,
		stateDir: zone.gateway.stateDir,
		tcpBasePort: options.systemConfig.tcpPool.basePort,
		zoneId: zone.id,
	});
	const result = await cleanupGateway({
		mode: 'offline-cleanup',
		projectNamespace: options.systemConfig.host.projectNamespace,
		stateDir: zone.gateway.stateDir,
		zoneId: zone.id,
	});
	results.push({
		...result,
		stateDir: zone.gateway.stateDir,
		zoneId: zone.id,
	});

	return { results };
}
