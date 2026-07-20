import { buildGatewaySessionLabel } from '@agent-vm/gateway-lifecycle';
import type { ManagedVmExactProcessTerminationCapability } from '@agent-vm/managed-vm';

import type { ControllerGatewayStateRoot } from '../controller/durable-state/controller-state-paths.js';
import { terminateRecordedManagedVmProcess } from '../shared/controller-managed-vm-termination.js';
import {
	readProcessCommand,
	readProcessIdentity,
	verifyRecordedManagedVmHostProcess,
} from '../shared/managed-vm-process.js';
import {
	deleteWorkerRuntimeRecord,
	listWorkerRuntimeRecordTargets,
	loadWorkerRuntimeRecordResult,
	type WorkerRuntimeRecord,
} from './worker-runtime-record.js';

export interface WorkerRuntimeRecoveryDependencies {
	readonly deleteWorkerRuntimeRecord?: typeof deleteWorkerRuntimeRecord;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly listWorkerRuntimeRecordTargets?: typeof listWorkerRuntimeRecordTargets;
	readonly loadWorkerRuntimeRecordResult?: typeof loadWorkerRuntimeRecordResult;
	readonly readProcessCommand?: (pid: number) => Promise<string | null>;
	readonly readProcessIdentity?: typeof readProcessIdentity;
}

export interface WorkerRuntimeCleanupResult {
	readonly cleanedCount: number;
	readonly killedPids: readonly number[];
}

function assertWorkerRuntimeRecordCleanupScope(options: {
	readonly expectedConfigPath: string;
	readonly expectedControllerPort: number;
	readonly projectNamespace: string;
	readonly record: WorkerRuntimeRecord;
	readonly targetPath: string;
}): void {
	const expectedSessionLabel = buildGatewaySessionLabel(
		options.projectNamespace,
		options.record.zoneId,
	);
	const scopeChecks = [
		{
			actual: options.record.configPath,
			expected: options.expectedConfigPath,
			label: 'configPath',
		},
		{
			actual: String(options.record.controllerPort),
			expected: String(options.expectedControllerPort),
			label: 'controllerPort',
		},
		{
			actual: options.record.projectNamespace,
			expected: options.projectNamespace,
			label: 'projectNamespace',
		},
		{
			actual: options.record.sessionLabel,
			expected: expectedSessionLabel,
			label: 'sessionLabel',
		},
	] as const;
	for (const scopeCheck of scopeChecks) {
		if (scopeCheck.actual !== scopeCheck.expected) {
			throw new Error(
				`Worker runtime record '${options.targetPath}' has ${scopeCheck.label} '${scopeCheck.actual}', expected '${scopeCheck.expected}'. Refusing scoped cleanup.`,
			);
		}
	}
}

export async function cleanupRecordedWorkerRuntimes(
	options: {
		readonly expectedConfigPath: string;
		readonly expectedControllerPort: number;
		readonly gatewayStateRoot: ControllerGatewayStateRoot;
		readonly projectNamespace: string;
	},
	dependencies: WorkerRuntimeRecoveryDependencies,
): Promise<WorkerRuntimeCleanupResult> {
	const targets = await (
		dependencies.listWorkerRuntimeRecordTargets ?? listWorkerRuntimeRecordTargets
	)({ gatewayStateRoot: options.gatewayStateRoot });
	const loadedRecords = await Promise.all(
		targets.map(async (target) => {
			const loadResult = await (
				dependencies.loadWorkerRuntimeRecordResult ?? loadWorkerRuntimeRecordResult
			)(target);
			if (loadResult.kind !== 'loaded') {
				const reason =
					loadResult.kind === 'missing'
						? 'is missing after collection validation'
						: `failed to parse: ${loadResult.error.message}`;
				throw new Error(`Worker runtime record '${loadResult.path}' ${reason}.`);
			}
			assertWorkerRuntimeRecordCleanupScope({
				expectedConfigPath: options.expectedConfigPath,
				expectedControllerPort: options.expectedControllerPort,
				projectNamespace: options.projectNamespace,
				record: loadResult.record,
				targetPath: target.filePath,
			});
			return { record: loadResult.record, target };
		}),
	);

	const processObservationDependencies = {
		readProcessCommand: dependencies.readProcessCommand ?? readProcessCommand,
		readProcessIdentity: dependencies.readProcessIdentity ?? readProcessIdentity,
	};
	await Promise.all(
		loadedRecords.map(async ({ record }) => {
			await verifyRecordedManagedVmHostProcess({
				contextLabel: `Worker runtime record for task '${record.taskId}' in zone '${record.zoneId}'`,
				currentSignalLabel: 'SIGTERM',
				pid: record.qemuPid,
				readProcessCommand: processObservationDependencies.readProcessCommand,
				readProcessIdentity: processObservationDependencies.readProcessIdentity,
				recordedIdentity: record.processIdentity,
			});
		}),
	);

	const cleanupResults = await Promise.all(
		loadedRecords.map(async ({ record, target }) => {
			const outcome = await terminateRecordedManagedVmProcess({
				contextLabel: `Worker runtime record for task '${record.taskId}' in zone '${record.zoneId}'`,
				exactProcessTermination: dependencies.exactProcessTermination,
				target: {
					hostPid: record.qemuPid,
					processIdentity: record.processIdentity,
					vmId: record.vmId,
				},
			});
			await (dependencies.deleteWorkerRuntimeRecord ?? deleteWorkerRuntimeRecord)(target);
			return outcome.kind === 'already-absent' ? null : outcome.pid;
		}),
	);

	return {
		cleanedCount: cleanupResults.length,
		killedPids: cleanupResults.filter((pid): pid is number => pid !== null),
	};
}
