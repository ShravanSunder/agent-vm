import type { ManagedVmExactProcessTerminationCapability } from '@agent-vm/managed-vm';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { containCredentialedRuntimeRecords as containCredentialedRuntimeRecordsDefault } from '../controller/credentialed-runtime/credentialed-runtime-record.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
	type ControllerStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import { resolveControllerGatewayRecordTargets } from '../controller/durable-state/controller-state-record-paths.js';
import { scanLegacyControllerRecordEvidence as scanGatewayStateAuthorityEvidenceDefault } from '../controller/durable-state/legacy-controller-record-evidence.js';
import { cleanupRecordedToolVmRuntimes as cleanupRecordedToolVmRuntimesDefault } from '../controller/leases/tool-vm-recovery.js';
import { acquireControllerOwnershipLock as acquireControllerOwnershipLockDefault } from '../controller/vm-ownership/controller-ownership-lock.js';
import { cleanupRecordedGatewayRuntime as cleanupRecordedGatewayRuntimeDefault } from '../gateway/gateway-recovery.js';
import { cleanupRecordedWorkerRuntimes as cleanupRecordedWorkerRuntimesDefault } from '../gateway/worker-runtime-recovery.js';

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
	readonly containCredentialedRuntimeRecords?: typeof containCredentialedRuntimeRecordsDefault;
	readonly cleanupRecordedGatewayRuntime?: typeof cleanupRecordedGatewayRuntimeDefault;
	readonly cleanupRecordedToolVmRuntimes?: typeof cleanupRecordedToolVmRuntimesDefault;
	readonly cleanupRecordedWorkerRuntimes?: typeof cleanupRecordedWorkerRuntimesDefault;
	readonly scanGatewayStateAuthorityEvidence?: typeof scanGatewayStateAuthorityEvidenceDefault;
}

interface ControllerOfflineCleanupDependencies extends RecordedVmTreeReconciliationDependencies {
	readonly acquireControllerOwnershipLock?: typeof acquireControllerOwnershipLockDefault;
	readonly assertControllerUnavailableForOfflineCleanup?: (controllerPort: number) => Promise<void>;
	readonly cleanupRecordedVmTree?: (options: {
		readonly controllerStateRoot: ControllerStateRoot;
		readonly systemConfig: LoadedSystemConfig;
		readonly zoneId: string;
	}) => Promise<void>;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
}

export async function reconcileRecordedVmTree(options: {
	readonly controllerStateRoot: ControllerStateRoot;
	readonly dependencies?: RecordedVmTreeReconciliationDependencies;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
}): Promise<void> {
	const zone = options.systemConfig.zones.find((candidate) => candidate.id === options.zoneId);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}
	const legacyEvidence = await (
		options.dependencies?.scanGatewayStateAuthorityEvidence ??
		scanGatewayStateAuthorityEvidenceDefault
	)({ gatewayStateDirectoryPath: zone.gateway.stateDir });
	if (legacyEvidence.length > 0) {
		throw new Error(
			`Legacy controller record evidence exists under Gateway state for zone '${zone.id}': ${legacyEvidence.map((evidence) => `${evidence.family}:${evidence.kind}:${evidence.absolutePath}`).join('; ')}. Refusing admission without migration or fallback.`,
		);
	}
	const gatewayStateRoot = resolveControllerGatewayStateRoot({
		controllerStateRoot: options.controllerStateRoot,
		zoneId: zone.id,
	});
	const recordTargets = resolveControllerGatewayRecordTargets({ gatewayStateRoot });

	const cleanupScope = {
		expectedConfigPath: options.systemConfig.systemConfigPath,
		expectedControllerPort: options.systemConfig.host.controllerPort,
		mode: 'offline-cleanup' as const,
		projectNamespace: options.systemConfig.host.projectNamespace,
	};
	if (zone.gateway.type === 'worker') {
		await (
			options.dependencies?.cleanupRecordedWorkerRuntimes ?? cleanupRecordedWorkerRuntimesDefault
		)(
			{ ...cleanupScope, gatewayStateRoot },
			{ exactProcessTermination: options.exactProcessTermination },
		);
		return;
	}
	const unsafeCredentialedRuntimes = await (
		options.dependencies?.containCredentialedRuntimeRecords ??
		containCredentialedRuntimeRecordsDefault
	)({
		exactProcessTermination: options.exactProcessTermination,
		recordsDirectoryPath: recordTargets.credentialedRuntimeRecords.directoryPath,
	});
	if (unsafeCredentialedRuntimes.length > 0) {
		throw new Error(
			`Offline credentialed runtime cleanup for zone '${zone.id}' left ${String(unsafeCredentialedRuntimes.length)} owner-unsafe record(s).`,
		);
	}
	const toolCleanup = await (
		options.dependencies?.cleanupRecordedToolVmRuntimes ?? cleanupRecordedToolVmRuntimesDefault
	)(
		{
			...cleanupScope,
			recordsTarget: recordTargets.toolLeaseRecords,
			tcpBasePort: options.systemConfig.tcpPool.basePort,
		},
		{ exactProcessTermination: options.exactProcessTermination },
	);
	if (toolCleanup.warnings.length > 0 || toolCleanup.quarantinedCount > 0) {
		throw new Error(
			`Offline Tool VM cleanup for zone '${zone.id}' did not complete safely: ${toolCleanup.warnings.join('; ') || `${String(toolCleanup.quarantinedCount)} runtime record(s) remain quarantined`}`,
		);
	}

	const gatewayCleanup = await (
		options.dependencies?.cleanupRecordedGatewayRuntime ?? cleanupRecordedGatewayRuntimeDefault
	)(
		{
			...cleanupScope,
			configuredIngressPort: zone.gateway.port,
			runtimeRecordTarget: recordTargets.managedGatewayRuntimeRecord,
			zoneId: zone.id,
		},
		{ exactProcessTermination: options.exactProcessTermination },
	);
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
	dependencies: ControllerOfflineCleanupDependencies,
): Promise<ControllerOfflineCleanupResult> {
	const zone = options.systemConfig.zones.find(
		(candidateZone) => candidateZone.id === options.zoneId,
	);
	if (!zone) {
		throw new Error(`Unknown zone '${options.zoneId}'.`);
	}

	const controllerOwnershipLock = await (
		dependencies.acquireControllerOwnershipLock ?? acquireControllerOwnershipLockDefault
	)({ runtimeDirectory: options.systemConfig.controllerRuntimeDir });
	const controllerStateRoot = createControllerStateRoot({
		controllerStateDirectoryPath: options.systemConfig.controllerStateDir,
	});
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
				controllerStateRoot,
				systemConfig: options.systemConfig,
				zoneId: zone.id,
			});
		} else {
			await reconcileRecordedVmTree({
				controllerStateRoot,
				dependencies: {
					...(dependencies.cleanupRecordedGatewayRuntime
						? { cleanupRecordedGatewayRuntime: dependencies.cleanupRecordedGatewayRuntime }
						: {}),
					...(dependencies.cleanupRecordedToolVmRuntimes
						? { cleanupRecordedToolVmRuntimes: dependencies.cleanupRecordedToolVmRuntimes }
						: {}),
					...(dependencies.cleanupRecordedWorkerRuntimes
						? { cleanupRecordedWorkerRuntimes: dependencies.cleanupRecordedWorkerRuntimes }
						: {}),
					...(dependencies.scanGatewayStateAuthorityEvidence
						? {
								scanGatewayStateAuthorityEvidence: dependencies.scanGatewayStateAuthorityEvidence,
							}
						: {}),
				},
				exactProcessTermination: dependencies.exactProcessTermination,
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
